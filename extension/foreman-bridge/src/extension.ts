import * as http from 'http';
import * as vscode from 'vscode';

interface BridgeState {
    terminalLines: string[];
    diagnostics: { file: string; message: string; severity: string }[];
    activeFile: string | null;
    lastFileChange: string | null;
    lastFileChangeTime: number;
    status: 'idle' | 'busy';
}

const MAX_TERMINAL_LINES = 200;

// Each IDE gets its own port so they can run simultaneously
// Windsurf: 19854, Antigravity: 19855, Cursor: 19856
function detectPort(): number {
    const appName = vscode.env.appName.toLowerCase();
    if (appName.includes('antigravity')) return 19855;
    if (appName.includes('cursor')) return 19856;
    return 19854; // Windsurf / default
}

function detectIDE(): string {
    const appName = vscode.env.appName.toLowerCase();
    if (appName.includes('antigravity')) return 'antigravity';
    if (appName.includes('cursor')) return 'cursor';
    return 'windsurf';
}

let state: BridgeState = {
    terminalLines: [],
    diagnostics: [],
    activeFile: null,
    lastFileChange: null,
    lastFileChangeTime: 0,
    status: 'idle',
};

let server: http.Server | null = null;

export function activate(context: vscode.ExtensionContext) {
    console.log('Foreman Bridge activated');

    // ── Terminal output capture ─────────────────────────────
    // Note: onDidWriteTerminalData is a proposed API, not available in stable
    // We'll capture terminal creation/disposal instead
    vscode.window.onDidOpenTerminal(terminal => {
        state.terminalLines.push(`[Terminal opened: ${terminal.name}]`);
    }, null, context.subscriptions);

    vscode.window.onDidCloseTerminal(terminal => {
        state.terminalLines.push(`[Terminal closed: ${terminal.name}]`);
    }, null, context.subscriptions);

    // ── Diagnostics capture ─────────────────────────────────
    vscode.languages.onDidChangeDiagnostics(event => {
        state.diagnostics = [];
        for (const uri of event.uris) {
            const diags = vscode.languages.getDiagnostics(uri);
            for (const d of diags) {
                state.diagnostics.push({
                    file: vscode.workspace.asRelativePath(uri),
                    message: d.message,
                    severity: vscode.DiagnosticSeverity[d.severity],
                });
            }
        }
    }, null, context.subscriptions);

    // ── Active editor tracking ──────────────────────────────
    vscode.window.onDidChangeActiveTextEditor(editor => {
        state.activeFile = editor
            ? vscode.workspace.asRelativePath(editor.document.uri)
            : null;
    }, null, context.subscriptions);

    // ── File save tracking ──────────────────────────────────
    vscode.workspace.onDidSaveTextDocument(doc => {
        state.lastFileChange = vscode.workspace.asRelativePath(doc.uri);
        state.lastFileChangeTime = Date.now();
    }, null, context.subscriptions);

    // ── HTTP server ─────────────────────────────────────────
    server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (req.url === '/status') {
            res.end(JSON.stringify({
                bridge: 'foreman-bridge',
                version: '0.1.0',
                ide: detectIDE(),
                port: detectPort(),
                uptime: process.uptime(),
            }));
        } else if (req.url === '/output') {
            // Last N lines of terminal output
            const n = 50;
            res.end(JSON.stringify({
                lines: state.terminalLines.slice(-n),
                total: state.terminalLines.length,
            }));
        } else if (req.url === '/output/all') {
            res.end(JSON.stringify({
                lines: state.terminalLines,
                total: state.terminalLines.length,
            }));
        } else if (req.url === '/diagnostics') {
            res.end(JSON.stringify({
                errors: state.diagnostics.filter(d => d.severity === 'Error'),
                warnings: state.diagnostics.filter(d => d.severity === 'Warning'),
                total: state.diagnostics.length,
            }));
        } else if (req.url === '/state') {
            res.end(JSON.stringify(state));
        } else {
            res.statusCode = 404;
            res.end(JSON.stringify({
                error: 'Not found',
                endpoints: ['/status', '/output', '/output/all', '/diagnostics', '/state'],
            }));
        }
    });

    const port = detectPort();
    const ide = detectIDE();
    server.listen(port, '127.0.0.1', () => {
        console.log(`Foreman Bridge HTTP server running on http://127.0.0.1:${port}`);
        vscode.window.showInformationMessage(`Foreman Bridge active on port ${port} (${ide})`);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${port} in use — Foreman Bridge already running?`);
        } else {
            console.error('Foreman Bridge server error:', err);
        }
    });

    context.subscriptions.push({
        dispose: () => {
            if (server) {
                server.close();
                server = null;
            }
        },
    });
}

export function deactivate() {
    if (server) {
        server.close();
        server = null;
    }
}
