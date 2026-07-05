import * as vscode from 'vscode';
import * as path from 'path';
import { DebugInfo } from './debug_info';

interface SymbolRow {
    kind: string;
    name: string;
    address: number;
    segment: string;
    source: string;
    line: number;
}

// Build the flat row list shown in the table. Functions and plain symbols come
// from separate DebugInfo arrays (a function's own `source`/`line` fields are
// the raw, unresolved paths from the .dbg file), so both go through
// findSourceForAddress -- the same resolved-path lookup used for call-stack
// frames -- to get a location that's guaranteed to exist on disk (or none).
function buildRows(debugInfo: DebugInfo): SymbolRow[] {
    const rows: SymbolRow[] = [];

    for (const fn of debugInfo.getFunctions()) {
        const loc = debugInfo.findSourceForAddress(fn.address);
        rows.push({
            kind: 'Function',
            name: fn.name,
            address: fn.address,
            segment: '',
            source: loc?.source || '',
            line: loc?.line || 0,
        });
    }

    for (const sym of debugInfo.getSymbols()) {
        const loc = debugInfo.findSourceForAddress(sym.address);
        rows.push({
            kind: sym.isZeroPage ? 'Zero Page' : (sym.isGlobal ? 'Global' : 'Static'),
            name: sym.name,
            address: sym.address,
            segment: sym.segment,
            source: loc?.source || '',
            line: loc?.line || 0,
        });
    }

    return rows;
}

const ALL_KINDS = ['Function', 'Global', 'Zero Page', 'Static'];

export class SymbolViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gearlynxDebug.symbolView';

    private view: vscode.WebviewView | undefined;
    private debugInfo: DebugInfo | null = null;

    public setDebugInfo(debugInfo: DebugInfo): void {
        this.debugInfo = debugInfo;
        this.render();
    }

    public clearDebugInfo(): void {
        this.debugInfo = null;
        this.render();
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.command === 'navigate' && msg.source) {
                const uri = vscode.Uri.file(msg.source);
                const line = Math.max(0, (msg.line || 1) - 1);
                void vscode.window.showTextDocument(uri, {
                    selection: new vscode.Range(line, 0, line, 0),
                    viewColumn: vscode.ViewColumn.One,
                });
            } else if (msg.command === 'setBreakpoint' && msg.name) {
                vscode.debug.addBreakpoints([new vscode.FunctionBreakpoint(msg.name)]);
            }
        });

        webviewView.onDidDispose(() => {
            this.view = undefined;
        });

        this.render();
    }

    private render(): void {
        if (!this.view) return;
        const rows = this.debugInfo ? buildRows(this.debugInfo) : [];
        this.view.webview.html = this.getHtml(rows);
    }

    private getHtml(rows: SymbolRow[]): string {
        const rowsJson = JSON.stringify(rows.map(r => ({
            ...r,
            sourceLabel: r.source ? `${path.basename(r.source)}:${r.line}` : '',
        })));
        const kindsJson = JSON.stringify(ALL_KINDS);

        return `<!DOCTYPE html>
<html>
<head>
<style>
    body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 8px; margin: 0; font-size: 12px;
    }
    #filter {
        width: 100%; box-sizing: border-box; margin-bottom: 6px; padding: 3px 6px;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border); font-family: var(--vscode-font-family);
    }
    #kinds { display: flex; flex-wrap: wrap; gap: 2px 10px; margin-bottom: 6px; }
    #kinds label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
    table { border-collapse: collapse; width: 100%; }
    th, td { text-align: left; padding: 2px 8px 2px 0; white-space: nowrap; }
    th {
        cursor: pointer; user-select: none; position: sticky; top: 0;
        background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border);
    }
    th:hover { color: var(--vscode-textLink-foreground); }
    tr.nav { cursor: pointer; }
    tr.nav:hover { background: var(--vscode-list-hoverBackground); }
    td.addr, td.source { font-family: var(--vscode-editor-font-family, monospace); }
    #count { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 4px; }
    #empty { color: var(--vscode-descriptionForeground); padding: 8px 0; }
    #ctxmenu {
        display: none; position: fixed; z-index: 100; min-width: 140px;
        background: var(--vscode-menu-background); color: var(--vscode-menu-foreground);
        border: 1px solid var(--vscode-menu-border); box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        padding: 4px 0; font-size: 12px;
    }
    #ctxmenu .item { padding: 4px 12px; cursor: pointer; }
    #ctxmenu .item:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
</style>
</head>
<body>
    <input id="filter" type="text" placeholder="Filter by name or address..." />
    <div id="kinds"></div>
    <div id="count"></div>
    <table>
        <thead>
            <tr>
                <th data-key="kind">Kind</th>
                <th data-key="name">Name</th>
                <th data-key="address">Address</th>
                <th data-key="segment">Segment</th>
                <th data-key="sourceLabel">Location</th>
            </tr>
        </thead>
        <tbody id="rows"></tbody>
    </table>
    <div id="empty" style="display:none">No debug info loaded.</div>
    <div id="ctxmenu"><div class="item" id="ctxSetBreakpoint">Set Breakpoint</div></div>
    <script>
    (function() {
        const vscode = acquireVsCodeApi();
        const allRows = ${rowsJson};
        const allKinds = ${kindsJson};
        const enabledKinds = new Set(allKinds);
        const tbody = document.getElementById('rows');
        const filterEl = document.getElementById('filter');
        const kindsEl = document.getElementById('kinds');
        const countEl = document.getElementById('count');
        const table = document.querySelector('table');
        const emptyEl = document.getElementById('empty');
        const ctxMenu = document.getElementById('ctxmenu');
        const ctxSetBreakpoint = document.getElementById('ctxSetBreakpoint');
        let sortKey = 'address';
        let sortAsc = true;
        let ctxRow = null;

        function hideCtxMenu() {
            ctxMenu.style.display = 'none';
            ctxRow = null;
        }

        ctxSetBreakpoint.addEventListener('click', () => {
            if (ctxRow) {
                vscode.postMessage({ command: 'setBreakpoint', name: ctxRow.name });
            }
            hideCtxMenu();
        });

        document.addEventListener('click', hideCtxMenu);
        document.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('tr.can-break')) hideCtxMenu();
        });

        if (allRows.length === 0) {
            table.style.display = 'none';
            emptyEl.style.display = 'block';
        }

        for (const kind of allKinds) {
            const label = document.createElement('label');
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = true;
            cb.addEventListener('change', () => {
                if (cb.checked) enabledKinds.add(kind); else enabledKinds.delete(kind);
                render();
            });
            label.appendChild(cb);
            label.appendChild(document.createTextNode(kind));
            kindsEl.appendChild(label);
        }

        function fmtAddr(a) {
            return '$' + a.toString(16).toUpperCase().padStart(4, '0');
        }

        function render() {
            const q = filterEl.value.trim().toLowerCase();
            let rows = allRows.filter(r =>
                enabledKinds.has(r.kind) &&
                (!q || r.name.toLowerCase().includes(q) || fmtAddr(r.address).toLowerCase().includes(q))
            );
            rows.sort((a, b) => {
                let av = a[sortKey], bv = b[sortKey];
                if (typeof av === 'string') { av = av.toLowerCase(); bv = bv.toLowerCase(); }
                if (av < bv) return sortAsc ? -1 : 1;
                if (av > bv) return sortAsc ? 1 : -1;
                return 0;
            });

            countEl.textContent = rows.length + ' of ' + allRows.length + ' symbols';

            tbody.textContent = '';
            for (const r of rows) {
                const tr = document.createElement('tr');
                if (r.source) {
                    tr.classList.add('nav');
                    tr.title = r.source + ':' + r.line;
                    tr.addEventListener('click', () => {
                        vscode.postMessage({ command: 'navigate', source: r.source, line: r.line });
                    });
                }
                if (r.kind === 'Function') {
                    tr.classList.add('can-break');
                    tr.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        ctxRow = r;
                        ctxMenu.style.display = 'block';
                        ctxMenu.style.left = e.clientX + 'px';
                        ctxMenu.style.top = e.clientY + 'px';
                    });
                }
                addCell(tr, r.kind, '');
                addCell(tr, r.name, '');
                addCell(tr, fmtAddr(r.address), 'addr');
                addCell(tr, r.segment || '', '');
                addCell(tr, r.sourceLabel || '--', 'source');
                tbody.appendChild(tr);
            }
        }

        function addCell(tr, text, className) {
            const td = document.createElement('td');
            if (className) td.className = className;
            td.textContent = text;
            tr.appendChild(td);
        }

        document.querySelectorAll('th').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.dataset.key;
                if (sortKey === key) { sortAsc = !sortAsc; } else { sortKey = key; sortAsc = true; }
                render();
            });
        });

        filterEl.addEventListener('input', render);
        render();
    })();
    </script>
</body>
</html>`;
    }
}
