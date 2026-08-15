import * as vscode from 'vscode';
import * as path from 'path';
import { DebugInfo } from './debug_info';
import { expandTilde } from './paths';
import { logInfo, logWarn } from './log';

// A file event of any kind means the same thing here: re-resolve.
function onAnyChange(watcher: vscode.FileSystemWatcher, fn: () => void): void {
    watcher.onDidChange(fn);
    watcher.onDidCreate(fn);
    watcher.onDidDelete(fn);
}

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
// running, so panels work while writing code, not just while debugging.
// Watches launch.json and the resolved debug file to refresh on rebuild.
export class WorkspaceDebugInfoProvider implements vscode.Disposable {
    // Debounces bursts of file events from one logical save/rebuild into a
    // single DebugInfo.load(), which can be an expensive re-parse.
    private static readonly DEBOUNCE_MS = 250;

    private debugInfo: DebugInfo | null = null;
    // One field, not two, so path and sourceRoots can't drift out of pairing.
    private resolved: ResolvedDebugFile | undefined;
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private readonly launchWatcher: vscode.FileSystemWatcher;
    private readonly emitter = new vscode.EventEmitter<void>();
    public readonly onDidChange = this.emitter.event;
    private debounceTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
        this.launchWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/launch.json');
        onAnyChange(this.launchWatcher, () => this.scheduleRefresh(() => this.refreshFromLaunchConfig()));
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
        onAnyChange(this.fileWatcher, () => this.scheduleRefresh(() => this.reloadDebugInfo()));
    }

    // Unlike LynxConfigurationProvider (extension.ts), which sees a config
    // already fully substituted by VS Code, there's no public API to get that
    // resolution outside a real debug session -- so this reads raw
    // launch.json values and only substitutes ${workspaceFolder} itself (see
    // substituteWorkspaceFolder below).
    //
    // Only the first "type": "gearlynx" config across workspace folders is
    // used; multiple gearlynx configs in one workspace aren't disambiguated.
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

    // Only ${workspaceFolder} is resolved here, unlike a real debug session's
    // full variable resolution; warnIfUnresolvedVariable surfaces anything
    // else a launch.json relies on instead of failing silently.
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
