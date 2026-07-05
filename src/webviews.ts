import * as vscode from 'vscode';
import { DebugMonitorClient } from './debug_monitor_client';
import { FramebufferStreamClient, FrameData } from './framebuffer_client';
import { logError } from './log';

// Shared framebuffer stream -- one TCP connection, multiple subscribers
let sharedStream: FramebufferStreamClient | undefined;

export function getSharedStream(): FramebufferStreamClient {
    if (!sharedStream) {
        sharedStream = new FramebufferStreamClient();
        sharedStream.on('error', (err: Error) => {
            logError(`Framebuffer stream error: ${err.message}`);
        });
    }
    return sharedStream;
}

export function connectSharedStream(port: number): void {
    getSharedStream().connect(port);
}

export function disconnectSharedStream(): void {
    if (sharedStream) {
        sharedStream.disconnect();
    }
}

// Shared controller-key handling -- the panel view reads the keymap setting
// and forwards presses to the emulator.
function loadKeymap(): Map<string, string> {
    const cfg = vscode.workspace.getConfiguration('gearlynxDebug.keymap');
    const map = new Map<string, string>();
    for (const btn of ['up', 'down', 'left', 'right', 'a', 'b', 'option1', 'option2', 'pause']) {
        const key = cfg.get<string>(btn, '');
        if (key) map.set(key, btn);
    }
    return map;
}

async function sendKeyInput(monitor: DebugMonitorClient | null, keymap: Map<string, string>, key: string, action: string): Promise<void> {
    if (!monitor || !monitor.isConnected()) return;
    const button = keymap.get(key);
    if (!button) return;
    try { await monitor.controllerButton(button, action); } catch { /* ignore */ }
}

export class ScreenViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gearlynxDebug.screenView';

    private view: vscode.WebviewView | undefined;
    private monitor: DebugMonitorClient | null = null;
    private keymap: Map<string, string> = new Map();
    private frameHandler: ((frame: FrameData) => void) | null = null;
    private statusHandler: ((connected: boolean) => void) | null = null;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public setConnection(monitor: DebugMonitorClient): void {
        this.monitor = monitor;
        this.keymap = loadKeymap();
        this.subscribeStream();
    }

    public clearConnection(): void {
        this.unsubscribeStream();
        this.monitor = null;
        if (this.view) {
            this.view.webview.postMessage({ command: 'status', connected: false });
        }
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.unsubscribeStream();
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'keydown' || msg.command === 'keyup') {
                await sendKeyInput(this.monitor, this.keymap, msg.key, msg.command === 'keydown' ? 'press' : 'release');
            }
        });

        webviewView.onDidDispose(() => {
            this.unsubscribeStream();
            this.view = undefined;
        });

        webviewView.webview.html = this.getHtml();

        if (this.monitor) {
            this.subscribeStream();
        }
    }

    private subscribeStream(): void {
        if (!this.view) return;
        this.unsubscribeStream();
        const stream = getSharedStream();
        this.frameHandler = (frame: FrameData) => {
            this.view?.webview.postMessage({ command: 'frame', ...frame });
        };
        this.statusHandler = (connected: boolean) => {
            this.view?.webview.postMessage({ command: 'status', connected });
        };
        stream.on('frame', this.frameHandler);
        stream.on('status', this.statusHandler);
        this.view.webview.postMessage({ command: 'status', connected: stream.isConnected() });
    }

    private unsubscribeStream(): void {
        if (sharedStream) {
            if (this.frameHandler) sharedStream.off('frame', this.frameHandler);
            if (this.statusHandler) sharedStream.off('status', this.statusHandler);
        }
        this.frameHandler = null;
        this.statusHandler = null;
    }

    private getHtml(): string {
        return `<!DOCTYPE html>
<html><head><style>
    body { margin: 0; padding: 4px; background: var(--vscode-editor-background); color: var(--vscode-foreground);
        font-family: var(--vscode-font-family); display: flex; flex-direction: column; align-items: center; }
    .controls { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; font-size: 11px; }
    select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
        border: 1px solid var(--vscode-dropdown-border); padding: 1px 3px; font-size: 11px; }
    canvas { image-rendering: pixelated; border: 1px solid var(--vscode-panel-border); }
    .info { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .status.connected { color: #4ec9b0; }
    .status.disconnected { color: #f44747; }
</style></head><body>
    <div class="controls">
        <label>Scale:</label>
        <select id="scale" onchange="applyScale()">
            <option value="fit" selected>Fit</option>
            <option value="1">1x</option><option value="2">2x</option>
            <option value="3">3x</option><option value="4">4x</option><option value="5">5x</option>
        </select>
    </div>
    <canvas id="screen" width="160" height="102"></canvas>
    <div class="info" id="info">Waiting...</div>
    <div class="info status disconnected" id="status">Disconnected</div>
    <script>
        const vscode = acquireVsCodeApi();
        const canvas = document.getElementById('screen');
        const ctx = canvas.getContext('2d');
        const info = document.getElementById('info');
        const statusEl = document.getElementById('status');
        let fc = 0, lt = Date.now(), fps = 0;
        // 'fit' scales the canvas to the panel width (integer-agnostic); a number
        // applies pixel-perfect integer scaling, which matters for crisp pixels.
        function applyScale() {
            const v = document.getElementById('scale').value;
            if (v === 'fit') {
                canvas.style.width = '100%';
                canvas.style.maxWidth = '640px';
                canvas.style.height = 'auto';
            } else {
                const s = parseInt(v);
                canvas.style.maxWidth = 'none';
                canvas.style.width = (canvas.width * s) + 'px';
                canvas.style.height = (canvas.height * s) + 'px';
            }
        }
        window.addEventListener('message', (e) => {
            const m = e.data;
            if (m.command === 'status') {
                statusEl.textContent = m.connected ? 'Connected' : 'Disconnected';
                statusEl.className = 'info status ' + (m.connected ? 'connected' : 'disconnected');
            }
            if (m.command === 'frame') {
                if (canvas.width !== m.width || canvas.height !== m.height) { canvas.width = m.width; canvas.height = m.height; applyScale(); }
                ctx.putImageData(new ImageData(new Uint8ClampedArray(m.pixels), m.width, m.height), 0, 0);
                fc++; const now = Date.now();
                if (now - lt >= 1000) { fps = fc; fc = 0; lt = now; }
                info.textContent = m.width + 'x' + m.height + ' | ' + fps + ' fps';
            }
        });
        applyScale();
        document.addEventListener('keydown', (e) => { if (!e.repeat) { e.preventDefault(); vscode.postMessage({ command: 'keydown', key: e.key }); } });
        document.addEventListener('keyup', (e) => { e.preventDefault(); vscode.postMessage({ command: 'keyup', key: e.key }); });
        canvas.tabIndex = 0; canvas.focus();
        canvas.addEventListener('click', () => canvas.focus());
    </script>
</body></html>`;
    }
}

