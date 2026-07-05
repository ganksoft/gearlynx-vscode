import * as vscode from 'vscode';
import * as fs from 'fs';
import { LynxDebugSession } from './lynx_debug_session';
import { expandTilde } from './paths';
import { ScreenViewProvider, connectSharedStream, disconnectSharedStream } from './webviews';
import { MemoryMapPanel } from './memory_map';
import { SymbolViewProvider } from './symbol_table';
import { getLogChannel, logInfo } from './log';

let activeSession: LynxDebugSession | undefined;
let screenViewProvider: ScreenViewProvider | undefined;
let symbolViewProvider: SymbolViewProvider | undefined;
let overlayTreeProvider: OverlayTreeProvider | undefined;
let traceOutputChannel: vscode.OutputChannel | undefined;

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

    // Register persistent screen view in panel
    screenViewProvider = new ScreenViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ScreenViewProvider.viewType, screenViewProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    // Symbol table view in panel -- populated from the active session's debug info.
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
    // Internal command invoked by tree items (and reusable elsewhere).
    context.subscriptions.push(
        vscode.commands.registerCommand('gearlynxDebug.setOverlay', (name: string | null) => selectOverlay(name))
    );

    // Overlay selector command
    context.subscriptions.push(
        vscode.commands.registerCommand('gearlynxDebug.selectOverlay', async () => {
            if (!activeSession) return;
            const debugInfo = activeSession.getDebugInfo();
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
            if (!activeSession) {
                vscode.window.showInformationMessage('No active Lynx debug session.');
                return;
            }
            const debugInfo = activeSession.getDebugInfo();
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
                syncOverlayUi();

                // Reveal the Screen view (and its panel) on debug start. The
                // auto-generated <viewId>.focus command works even before the
                // view has been resolved.
                void vscode.commands.executeCommand('gearlynxDebug.screenView.focus');

                if (activeSession) {
                    const monitor = activeSession.getMonitor();
                    const streamPort = activeSession.getStreamPort();

                    const debugInfo = activeSession.getDebugInfo();
                    if (debugInfo) {
                        symbolViewProvider?.setDebugInfo(debugInfo);
                    }

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
                symbolViewProvider?.clearDebugInfo();
                activeSession = undefined;
                syncOverlayUi();
            }
        })
    );
}

// Single source of truth for changing the active overlay. Every surface (the
// debug-toolbar quickpick button and the panel tree) routes through here, so
// they can never drift out of sync: each just re-reads getActiveOverlayName().
function selectOverlay(name: string | null): void {
    const debugInfo = activeSession?.getDebugInfo();
    if (!debugInfo) return;
    if (name === null) {
        debugInfo.clearActiveOverlay();
    } else {
        debugInfo.setActiveOverlay(name);
    }
    overlayTreeProvider?.refresh();
    // Re-emit stopped event so VSCode re-queries the stack trace and
    // repositions the editor to the correct source line.
    activeSession?.refreshStoppedState();
}

// Refresh overlay UI for the current session: toolbar/tree visibility context
// key and tree contents.
function syncOverlayUi(): void {
    const hasOverlays = activeSession?.getDebugInfo()?.hasOverlays() ?? false;
    void vscode.commands.executeCommand('setContext', 'gearlynxDebug.hasOverlays', hasOverlays);
    overlayTreeProvider?.refresh();
}

export function setActiveSession(session: LynxDebugSession | undefined): void {
    activeSession = session;
    syncOverlayUi();
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
            const baseName = config.rom.replace(/\.[^.]+$/, '');
            // Try common naming patterns:
            // game.dbg, game.lnx.dbg, game.sym, game.lnx.sym
            const candidates = [
                baseName + '.dbg',
                config.rom + '.dbg',
                baseName + '.sym',
                config.rom + '.sym',
            ];
            for (const debugPath of candidates) {
                if (fs.existsSync(debugPath)) {
                    config.debugFile = debugPath;
                    break;
                }
            }
            if (config.debugFile) {
                logInfo(`Auto-detected debug file: ${config.debugFile}`);
            } else {
                logInfo(`No debug file found for ${config.rom} (tried: ${candidates.join(', ')})`);
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
        const active = activeSession?.getDebugInfo()?.getActiveOverlayName() ?? null;
        item.iconPath = new vscode.ThemeIcon(choice.value === active ? 'check' : 'blank');
        item.command = {
            command: 'gearlynxDebug.setOverlay',
            title: 'Select Overlay',
            arguments: [choice.value],
        };
        return item;
    }

    getChildren(): OverlayChoice[] {
        const debugInfo = activeSession?.getDebugInfo();
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
