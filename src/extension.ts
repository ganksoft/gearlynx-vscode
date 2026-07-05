import * as vscode from 'vscode';
import { LynxDebugSession } from './lynx_debug_session';
import { expandTilde } from './paths';
import { ScreenViewProvider, connectSharedStream, disconnectSharedStream } from './webviews';
import { MemoryMapPanel } from './memory_map';
import { SymbolViewProvider } from './symbol_table';
import { DebugInfo } from './debug_info';
import { WorkspaceDebugInfoProvider } from './workspace_debug_info';
import { getLogChannel, logInfo } from './log';

let activeSession: LynxDebugSession | undefined;
let screenViewProvider: ScreenViewProvider | undefined;
let symbolViewProvider: SymbolViewProvider | undefined;
let overlayTreeProvider: OverlayTreeProvider | undefined;
let traceOutputChannel: vscode.OutputChannel | undefined;
let workspaceDebugInfoProvider: WorkspaceDebugInfoProvider | undefined;

// A live session takes precedence, even if it has no debug file loaded --
// falling through to the workspace scan in that case would show an unrelated
// launch.json config's symbols as if they belonged to the active session.
// The workspace-scanned debug info (from launch.json, no session required)
// only applies when there is no session at all, so panels work while writing
// code, not just while debugging.
function getEffectiveDebugInfo(): DebugInfo | null {
    if (activeSession) {
        return activeSession.getDebugInfo();
    }
    return workspaceDebugInfoProvider?.getDebugInfo() ?? null;
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(getLogChannel());
    logInfo('Gearlynx Debugger extension activated.');

    const factory = new LynxDebugAdapterFactory();
    context.subscriptions.push(
        vscode.debug.registerDebugAdapterDescriptorFactory('gearlynx', factory)
    );

    const provider = new LynxConfigurationProvider();
    context.subscriptions.push(
        vscode.debug.registerDebugConfigurationProvider('gearlynx', provider)
    );

    // Register persistent screen view in panel. Views in gearlynxDebugPanel
    // that should work standalone (no debug session) each need their own
    // "onView:<viewId>" entry in package.json's activationEvents -- there is
    // no "any view in this container" wildcard, so a new view without one
    // silently never activates the extension on first open.
    screenViewProvider = new ScreenViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ScreenViewProvider.viewType, screenViewProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Symbol table view in panel -- populated from the effective debug info
    // (active session, or the workspace scan below when nothing is running).
    symbolViewProvider = new SymbolViewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SymbolViewProvider.viewType, symbolViewProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Overlay tree view (panel) -- mirrors the debug toolbar selector.
    overlayTreeProvider = new OverlayTreeProvider();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('gearlynxDebug.overlayView', overlayTreeProvider)
    );

    // Resolves debug info from launch.json with no session running, so
    // Symbols/Overlays/Memory Map work while writing code, not just while
    // debugging. Session data takes precedence once a session starts.
    workspaceDebugInfoProvider = new WorkspaceDebugInfoProvider();
    context.subscriptions.push(workspaceDebugInfoProvider);
    context.subscriptions.push(workspaceDebugInfoProvider.onDidChange(() => syncDebugInfoUi()));
    syncDebugInfoUi();

    // Internal command invoked by tree items (and reusable elsewhere).
    context.subscriptions.push(
        vscode.commands.registerCommand('gearlynxDebug.setOverlay', (name: string | null) => selectOverlay(name))
    );

    // Overlay selector command
    context.subscriptions.push(
        vscode.commands.registerCommand('gearlynxDebug.selectOverlay', async () => {
            const debugInfo = getEffectiveDebugInfo();
            if (!debugInfo || !debugInfo.hasOverlays()) {
                vscode.window.showInformationMessage('No overlays detected in debug info.');
                return;
            }

            const groups = debugInfo.getOverlayGroups();
            const currentName = debugInfo.getActiveOverlayName();

            // "None" resets to the unselected state (all segments active). Useful
            // because overlay code is copied into RAM at runtime and the debugger
            // cannot know which overlay is currently resident; the user picks.
            const NONE_LABEL = 'None (no overlay)';
            const items: vscode.QuickPickItem[] = [{
                label: NONE_LABEL,
                description: currentName === null ? '(active)' : '',
            }];

            for (const group of groups) {
                for (const name of group.segmentNames) {
                    items.push({
                        label: name,
                        description: name === currentName ? '(active)' : '',
                    });
                }
            }

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select the active code overlay',
            });

            if (picked) {
                selectOverlay(picked.label === NONE_LABEL ? null : picked.label);
            }
        })
    );

    // Memory map command
    context.subscriptions.push(
        vscode.commands.registerCommand('gearlynxDebug.showMemoryMap', () => {
            const debugInfo = getEffectiveDebugInfo();
            if (!debugInfo) {
                vscode.window.showInformationMessage('No debug info loaded.');
                return;
            }
            MemoryMapPanel.show(debugInfo.getSegments());
        })
    );

    // Trace logger commands
    context.subscriptions.push(
        vscode.commands.registerCommand('gearlynxDebug.startTraceLog', async () => {
            if (!activeSession) return;
            const monitor = activeSession.getMonitor();
            await monitor.setTraceLog(true);
            vscode.window.showInformationMessage('Trace logger started.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gearlynxDebug.stopTraceLog', async () => {
            if (!activeSession) return;
            const monitor = activeSession.getMonitor();
            await monitor.setTraceLog(false);
            vscode.window.showInformationMessage('Trace logger stopped.');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gearlynxDebug.showTraceLog', async () => {
            if (!activeSession) {
                vscode.window.showInformationMessage('No active Lynx debug session.');
                return;
            }
            const monitor = activeSession.getMonitor();
            const data = await monitor.getTraceLog(-1, 500);
            const lines = data['lines'] as string[] || [];

            if (!traceOutputChannel) {
                traceOutputChannel = vscode.window.createOutputChannel('Lynx Trace Log');
            }
            traceOutputChannel.clear();
            for (const line of lines) {
                traceOutputChannel.appendLine(line);
            }
            traceOutputChannel.show(true);
        })
    );

    // Show/hide overlay UI based on debug session
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession((session) => {
            if (session.type === 'gearlynx') {
                syncDebugInfoUi();

                if (activeSession) {
                    const monitor = activeSession.getMonitor();
                    const streamPort = activeSession.getStreamPort();

                    // Connect shared framebuffer stream
                    setTimeout(() => {
                        connectSharedStream(streamPort);
                        if (screenViewProvider) {
                            screenViewProvider.setConnection(monitor);
                        }
                    }, 1000);
                }
            }
        })
    );
    context.subscriptions.push(
        vscode.debug.onDidTerminateDebugSession((session) => {
            if (session.type === 'gearlynx') {
                disconnectSharedStream();
                screenViewProvider?.clearConnection();
                activeSession = undefined;
                syncDebugInfoUi();
            }
        })
    );
}

// Single source of truth for changing the active overlay. Every surface (the
// debug-toolbar quickpick button and the panel tree) routes through here, so
// they can never drift out of sync: each just re-reads getActiveOverlayName().
function selectOverlay(name: string | null): void {
    const debugInfo = getEffectiveDebugInfo();
    if (!debugInfo) return;
    if (name === null) {
        debugInfo.clearActiveOverlay();
    } else {
        debugInfo.setActiveOverlay(name);
    }
    overlayTreeProvider?.refresh();
    if (activeSession) {
        // Re-emit stopped event so VSCode re-queries the stack trace and
        // repositions the editor to the correct source line.
        activeSession.refreshStoppedState();
    }
}

// Refresh all debug-info-derived UI: the "project detected" and "has overlays"
// context keys, the overlay tree, and the Symbols panel. Called whenever the
// effective debug info could have changed -- session start/end or a workspace
// rescan (rebuild, launch.json edit).
function syncDebugInfoUi(): void {
    const debugInfo = getEffectiveDebugInfo();
    void vscode.commands.executeCommand('setContext', 'gearlynxDebug.projectDetected', debugInfo !== null);
    void vscode.commands.executeCommand('setContext', 'gearlynxDebug.hasOverlays', debugInfo?.hasOverlays() ?? false);
    overlayTreeProvider?.refresh();
    if (debugInfo) {
        symbolViewProvider?.setDebugInfo(debugInfo);
    } else {
        symbolViewProvider?.clearDebugInfo();
    }
}

export function setActiveSession(session: LynxDebugSession | undefined): void {
    activeSession = session;
    syncDebugInfoUi();
}

export function deactivate(): void {
    activeSession = undefined;
}

class LynxDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(
        _session: vscode.DebugSession,
        _executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(new LynxDebugSession());
    }
}

class LynxConfigurationProvider implements vscode.DebugConfigurationProvider {
    resolveDebugConfiguration(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        if (!config.type && !config.request && !config.name) {
            // "Just press F5" with no launch.json
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                config.type = 'gearlynx';
                config.name = 'Launch Lynx';
                config.request = 'launch';
                config.rom = '${workspaceFolder}/game.lnx';
                config.stopOnEntry = true;
            }
        }

        // Fill in default port from settings
        if (!config.port) {
            const settings = vscode.workspace.getConfiguration('gearlynxDebug');
            config.port = settings.get<number>('defaultPort', 6502);
        }

        // Fill in gearlynx path from settings if not in launch config
        if (config.request === 'launch' && !config.gearlynxPath) {
            const settings = vscode.workspace.getConfiguration('gearlynxDebug');
            const globalPath = settings.get<string>('gearlynxPath', '');
            if (globalPath) {
                config.gearlynxPath = expandTilde(globalPath);
            }
        }

        return config;
    }

    resolveDebugConfigurationWithSubstitutedVariables(
        _folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        _token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        // Auto-detect debug file after ${workspaceFolder} etc. are resolved
        if (config.rom) {
            config.rom = expandTilde(config.rom);
        }
        if (config.rom && !config.debugFile) {
            const { path, candidates } = DebugInfo.resolveDebugFile(config.rom, undefined);
            config.debugFile = path;
            if (path) {
                logInfo(`Auto-detected debug file: ${path}`);
            } else {
                logInfo(`No debug file found for ${config.rom} (tried: ${candidates!.join(', ')})`);
            }
        }

        return config;
    }
}

interface OverlayChoice {
    label: string;
    // null is the "no overlay" choice (all segments active).
    value: string | null;
}

class OverlayTreeProvider implements vscode.TreeDataProvider<OverlayChoice> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(choice: OverlayChoice): vscode.TreeItem {
        const item = new vscode.TreeItem(choice.label);
        const active = getEffectiveDebugInfo()?.getActiveOverlayName() ?? null;
        item.iconPath = new vscode.ThemeIcon(choice.value === active ? 'check' : 'blank');
        item.command = {
            command: 'gearlynxDebug.setOverlay',
            title: 'Select Overlay',
            arguments: [choice.value],
        };
        return item;
    }

    getChildren(): OverlayChoice[] {
        const debugInfo = getEffectiveDebugInfo();
        if (!debugInfo || !debugInfo.hasOverlays()) return [];
        const choices: OverlayChoice[] = [{ label: 'None (no overlay)', value: null }];
        for (const group of debugInfo.getOverlayGroups()) {
            for (const name of group.segmentNames) {
                choices.push({ label: name, value: name });
            }
        }
        return choices;
    }
}
