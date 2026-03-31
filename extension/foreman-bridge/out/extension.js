"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const http = __importStar(require("http"));
const vscode = __importStar(require("vscode"));
const MAX_TERMINAL_LINES = 200;
const PORT = 19854;
let state = {
    terminalLines: [],
    diagnostics: [],
    activeFile: null,
    lastFileChange: null,
    lastFileChangeTime: 0,
    status: 'idle',
};
let server = null;
function activate(context) {
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
                ide: 'windsurf',
                port: PORT,
                uptime: process.uptime(),
            }));
        }
        else if (req.url === '/output') {
            // Last N lines of terminal output
            const n = 50;
            res.end(JSON.stringify({
                lines: state.terminalLines.slice(-n),
                total: state.terminalLines.length,
            }));
        }
        else if (req.url === '/output/all') {
            res.end(JSON.stringify({
                lines: state.terminalLines,
                total: state.terminalLines.length,
            }));
        }
        else if (req.url === '/diagnostics') {
            res.end(JSON.stringify({
                errors: state.diagnostics.filter(d => d.severity === 'Error'),
                warnings: state.diagnostics.filter(d => d.severity === 'Warning'),
                total: state.diagnostics.length,
            }));
        }
        else if (req.url === '/state') {
            res.end(JSON.stringify(state));
        }
        else {
            res.statusCode = 404;
            res.end(JSON.stringify({
                error: 'Not found',
                endpoints: ['/status', '/output', '/output/all', '/diagnostics', '/state'],
            }));
        }
    });
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`Foreman Bridge HTTP server running on http://127.0.0.1:${PORT}`);
        vscode.window.showInformationMessage(`Foreman Bridge active on port ${PORT}`);
    });
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${PORT} in use — Foreman Bridge already running?`);
        }
        else {
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
function deactivate() {
    if (server) {
        server.close();
        server = null;
    }
}
//# sourceMappingURL=extension.js.map