import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DebugInfo } from './debug_info';
import { expandTilde } from './paths';
import { logInfo } from './log';

interface RomConfig {
    rom: string;
    debugFile?: string;
    sourceRoots?: string[];
}

// Resolves debug info from the workspace's launch.json with no debug session
// running, so the Symbols/Overlays/Memory Map panels work while writing code,
// not just while debugging. Watches launch.json and the resolved debug file
// so a rebuild refreshes the panels automatically.
export class WorkspaceDebugInfoProvider implements vscode.Disposable {
    private debugInfo: DebugInfo | null = null;
    private resolvedPath: string | undefined;
    private sourceRoots: string[] | undefined;
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private readonly launchWatcher: vscode.FileSystemWatcher;
    private readonly emitter = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.emitter.event;

    constructor() {
        this.launchWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/launch.json');
        this.launchWatcher.onDidChange(() => this.refreshFromLaunchConfig());
        this.launchWatcher.onDidCreate(() => this.refreshFromLaunchConfig());
        this.launchWatcher.onDidDelete(() => this.refreshFromLaunchConfig());
        this.refreshFromLaunchConfig();
    }

    getDebugInfo(): DebugInfo | null {
        return this.debugInfo;
    }

    dispose(): void {
        this.fileWatcher?.dispose();
        this.launchWatcher.dispose();
        this.emitter.dispose();
    }

    private refreshFromLaunchConfig(): void {
        const romConfig = this.findGearlynxConfig();
        let newPath: string | undefined;

        if (romConfig) {
            if (romConfig.debugFile && fs.existsSync(romConfig.debugFile)) {
                newPath = romConfig.debugFile;
            } else {
                newPath = DebugInfo.findCandidatePath(romConfig.rom).found;
            }
        }

        if (newPath !== this.resolvedPath) {
            this.watchDebugFile(newPath);
            this.resolvedPath = newPath;
        }
        this.sourceRoots = romConfig?.sourceRoots;

        this.reloadDebugInfo();
    }

    private reloadDebugInfo(): void {
        this.debugInfo = this.resolvedPath ? DebugInfo.load(this.resolvedPath, this.sourceRoots) : null;

        if (this.resolvedPath && !this.debugInfo) {
            logInfo(`Failed to parse workspace debug file: ${this.resolvedPath}`);
        } else if (this.debugInfo) {
            logInfo(`Workspace debug info loaded: ${this.resolvedPath}`);
        }

        this.emitter.fire();
    }

    private watchDebugFile(newPath: string | undefined): void {
        this.fileWatcher?.dispose();
        this.fileWatcher = undefined;
        if (!newPath) return;

        const pattern = new vscode.RelativePattern(path.dirname(newPath), path.basename(newPath));
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.fileWatcher.onDidChange(() => this.reloadDebugInfo());
        this.fileWatcher.onDidCreate(() => this.reloadDebugInfo());
        this.fileWatcher.onDidDelete(() => this.reloadDebugInfo());
    }

    // Only the first "type": "gearlynx" configuration across workspace folders
    // is used; multiple gearlynx configs in one workspace aren't disambiguated.
    private findGearlynxConfig(): RomConfig | undefined {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const configs = vscode.workspace
                .getConfiguration('launch', folder.uri)
                .get<Record<string, unknown>[]>('configurations', []);

            for (const config of configs) {
                if (config['type'] !== 'gearlynx' || typeof config['rom'] !== 'string') continue;

                const rom = expandTilde(this.substituteWorkspaceFolder(config['rom'], folder))!;
                const debugFile = typeof config['debugFile'] === 'string'
                    ? expandTilde(this.substituteWorkspaceFolder(config['debugFile'], folder))
                    : undefined;
                const sourceRoots = Array.isArray(config['sourceRoots'])
                    ? config['sourceRoots']
                        .filter((r): r is string => typeof r === 'string')
                        .map(r => expandTilde(this.substituteWorkspaceFolder(r, folder)) as string)
                    : undefined;

                return { rom, debugFile, sourceRoots };
            }
        }
        return undefined;
    }

    private substituteWorkspaceFolder(value: string, folder: vscode.WorkspaceFolder): string {
        return value.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
    }
}
