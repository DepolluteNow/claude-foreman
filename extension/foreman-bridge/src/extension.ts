import { execSync } from 'child_process';
import * as http from 'http';
import * as vscode from 'vscode';

interface BridgeState {
    terminalLines: string[];
    diagnostics: { file: string; message: string; severity: string }[];
    activeFile: string | null;
    lastFileChange: string | null;
    lastFileChangeTime: number;
    saveHistory: { file: string; time: number }[];
    fileEvents: { type: string; file: string; time: number }[];
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
    saveHistory: [],
    fileEvents: [],
    status: 'idle',
};

function runGit(command: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return '(no workspace)';
    try {
        return execSync(`git ${command}`, { cwd: workspaceRoot, timeout: 5000 }).toString().trim();
    } catch {
        return '(git error)';
    }
}

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
        const file = vscode.workspace.asRelativePath(doc.uri);
        state.lastFileChange = file;
        state.lastFileChangeTime = Date.now();
        state.saveHistory.push({ file, time: Date.now() });
        if (state.saveHistory.length > 50) state.saveHistory = state.saveHistory.slice(-50);
    }, null, context.subscriptions);

    // ── Filesystem watcher ─────────────────────────────────
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    watcher.onDidCreate(uri => {
        const entry = { type: 'create', file: vscode.workspace.asRelativePath(uri), time: Date.now() };
        state.fileEvents.push(entry);
        if (state.fileEvents.length > 100) state.fileEvents = state.fileEvents.slice(-100);
    }, null, context.subscriptions);

    watcher.onDidDelete(uri => {
        const entry = { type: 'delete', file: vscode.workspace.asRelativePath(uri), time: Date.now() };
        state.fileEvents.push(entry);
        if (state.fileEvents.length > 100) state.fileEvents = state.fileEvents.slice(-100);
    }, null, context.subscriptions);

    watcher.onDidChange(uri => {
        const entry = { type: 'change', file: vscode.workspace.asRelativePath(uri), time: Date.now() };
        state.fileEvents.push(entry);
        if (state.fileEvents.length > 100) state.fileEvents = state.fileEvents.slice(-100);
    }, null, context.subscriptions);

    context.subscriptions.push(watcher);

    // ── HTTP server ─────────────────────────────────────────
    server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (req.url === '/status') {
            res.end(JSON.stringify({
                bridge: 'foreman-bridge',
                version: '0.2.0',
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
        } else if (req.url === '/git') {
            res.end(JSON.stringify({
                status: runGit('status --short'),
                diff: runGit('diff --stat HEAD'),
                log: runGit('log --oneline -5'),
                branch: runGit('branch --show-current'),
            }));
        } else if (req.url === '/files') {
            res.end(JSON.stringify({
                saves: state.saveHistory.slice(-20),
                events: state.fileEvents.slice(-30),
            }));
        } else if (req.url === '/health') {
            // Quick health check for Foreman polling
            const sinceLastSave = state.lastFileChangeTime
                ? Date.now() - state.lastFileChangeTime
                : -1;
            res.end(JSON.stringify({
                alive: true,
                ide: detectIDE(),
                sinceLastSaveMs: sinceLastSave,
                diagnosticCount: state.diagnostics.length,
                errorCount: state.diagnostics.filter(d => d.severity === 'Error').length,
            }));
        } else {
            res.statusCode = 404;
            res.end(JSON.stringify({
                error: 'Not found',
                endpoints: ['/status', '/output', '/output/all', '/diagnostics', '/state', '/git', '/files', '/health'],
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
