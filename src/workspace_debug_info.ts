import * as vscode from 'vscode';
import * as path from 'path';
import { DebugInfo } from './debug_info';
import { expandTilde } from './paths';
import { logInfo, logWarn } from './log';

interface RomConfig {
    rom: string;
    debugFile?: string;
    sourceRoots?: string[];
}

interface ResolvedDebugFile {
    path: string;
    sourceRoots?: string[];
}

// Resolves debug info from the workspace's launch.json with no debug session
// running, so the Symbols/Overlays/Memory Map panels work while writing code,
// not just while debugging. Watches launch.json and the resolved debug file
// so a rebuild refreshes the panels automatically.
export class WorkspaceDebugInfoProvider implements vscode.Disposable {
    // Build tools and editors often touch a file (or launch.json) several
    // times in quick succession for one logical save/rebuild; debouncing
    // collapses that burst into a single synchronous DebugInfo.load(), which
    // can otherwise be an expensive re-parse for a large .dbg file.
    private static readonly DEBOUNCE_MS = 250;

    private debugInfo: DebugInfo | null = null;
    // Path and sourceRoots always come from, and change with, the same
    // resolved launch config -- one field keeps that pairing structural
    // instead of relying on two fields always being updated together.
    private resolved: ResolvedDebugFile | undefined;
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private readonly launchWatcher: vscode.FileSystemWatcher;
    private readonly emitter = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.emitter.event;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
        this.launchWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/launch.json');
        this.launchWatcher.onDidChange(() => this.scheduleRefresh(() => this.refreshFromLaunchConfig()));
        this.launchWatcher.onDidCreate(() => this.scheduleRefresh(() => this.refreshFromLaunchConfig()));
        this.launchWatcher.onDidDelete(() => this.scheduleRefresh(() => this.refreshFromLaunchConfig()));
        this.refreshFromLaunchConfig();
    }

    getDebugInfo(): DebugInfo | null {
        return this.debugInfo;
    }

    dispose(): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.fileWatcher?.dispose();
        this.launchWatcher.dispose();
        this.emitter.dispose();
    }

    private scheduleRefresh(fn: () => void): void {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = undefined;
            fn();
        }, WorkspaceDebugInfoProvider.DEBOUNCE_MS);
    }

    private refreshFromLaunchConfig(): void {
        const romConfig = this.findGearlynxConfig();
        if (romConfig) {
            this.warnIfUnresolvedVariable('rom', romConfig.rom);
            if (romConfig.debugFile) this.warnIfUnresolvedVariable('debugFile', romConfig.debugFile);
        }

        const newPath = romConfig ? DebugInfo.resolveDebugFile(romConfig.rom, romConfig.debugFile).path : undefined;

        if (newPath !== this.resolved?.path) {
            this.watchDebugFile(newPath);
        }
        this.resolved = newPath ? { path: newPath, sourceRoots: romConfig?.sourceRoots } : undefined;

        this.reloadDebugInfo();
    }

    private reloadDebugInfo(): void {
        this.debugInfo = this.resolved ? DebugInfo.load(this.resolved.path, this.resolved.sourceRoots) : null;

        if (this.resolved && !this.debugInfo) {
            logInfo(`Failed to parse workspace debug file: ${this.resolved.path}`);
        } else if (this.debugInfo) {
            logInfo(`Workspace debug info loaded: ${this.resolved!.path}`);
        }

        this.emitter.fire();
    }

    private watchDebugFile(newPath: string | undefined): void {
        this.fileWatcher?.dispose();
        this.fileWatcher = undefined;
        if (!newPath) return;

        const pattern = new vscode.RelativePattern(path.dirname(newPath), path.basename(newPath));
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.fileWatcher.onDidChange(() => this.scheduleRefresh(() => this.reloadDebugInfo()));
        this.fileWatcher.onDidCreate(() => this.scheduleRefresh(() => this.reloadDebugInfo()));
        this.fileWatcher.onDidDelete(() => this.scheduleRefresh(() => this.reloadDebugInfo()));
    }

    // Deliberately independent of LynxConfigurationProvider (extension.ts),
    // which resolves the *same* kind of config during a real debug session:
    // that provider receives its config already fully substituted by VS Code
    // (${env:...}, multi-root ${workspaceFolder:name}, etc. all resolved
    // before it sees it). There is no public VS Code API to get that same
    // resolution outside of actually starting a debug session, so this method
    // reads raw, unsubstituted launch.json values instead and only handles
    // ${workspaceFolder} itself (see substituteWorkspaceFolder below). The two
    // are kept behaviorally aligned only where that's actually possible --
    // e.g. both go through DebugInfo.resolveDebugFile for the debugFile
    // decision.
    //
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

    // Only ${workspaceFolder} is resolved here, unlike a real debug session
    // (which goes through VS Code's full DebugConfigurationProvider variable
    // resolution -- ${env:...}, multi-root ${workspaceFolder:name}, etc.). A
    // launch.json relying on those will silently fail to resolve in this
    // no-session path; warnIfUnresolvedVariable surfaces that instead of
    // failing silently.
    private substituteWorkspaceFolder(value: string, folder: vscode.WorkspaceFolder): string {
        return value.replace(/\$\{workspaceFolder\}/g, folder.uri.fsPath);
    }

    private warnIfUnresolvedVariable(field: string, value: string): void {
        const match = value.match(/\$\{[^}]+\}/);
        if (match) {
            logWarn(
                `Workspace symbol scan: launch.json "${field}" still contains ${match[0]} after substitution ` +
                `(only \${workspaceFolder} is supported outside an active debug session). Panels may not populate ` +
                `until a debug session is started.`
            );
        }
    }
}
