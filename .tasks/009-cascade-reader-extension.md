# 🥊 Task 9: VS Code Extension — Cascade Output Reader

## Weight Class: Heavyweight (uppercut)

## What to do

Build a minimal VS Code extension that runs inside Windsurf and exposes Cascade's AI output to external processes (like Claude Foreman) via a local HTTP server.

### Architecture

```
Windsurf (Electron)
├── Cascade AI Panel (sends/receives via Codeium API)
├── Extension Host
│   └── foreman-bridge extension
│       ├── Captures: terminal output, file changes, diagnostics
│       ├── Runs: HTTP server on localhost:19854
│       └── Exposes: GET /status, GET /output, GET /diagnostics
└── Foreman reads from localhost:19854 instead of screenshots
```

### Create directory: `extension/foreman-bridge/`

### File 1: `extension/foreman-bridge/package.json`

```json
{
  "name": "foreman-bridge",
  "displayName": "Foreman Bridge",
  "description": "Exposes IDE state to Claude Foreman via local HTTP",
  "version": "0.1.0",
  "publisher": "depollutenow",
  "engines": {
    "vscode": "^1.85.0"
  },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "scripts": {
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./"
  },
  "devDependencies": {
    "@types/vscode": "^1.85.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.3.0"
  }
}
```

### File 2: `extension/foreman-bridge/tsconfig.json`

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2022",
    "outDir": "out",
    "lib": ["ES2022"],
    "sourceMap": true,
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "exclude": ["node_modules", "out"]
}
```

### File 3: `extension/foreman-bridge/src/extension.ts`

This is the main extension file. It does three things:
1. Watches terminal output (captures what Kimi runs in terminal)
2. Watches diagnostics (TypeScript errors, lint warnings)
3. Runs a tiny HTTP server on port 19854 exposing this data

```typescript
import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';

interface BridgeState {
    terminalLines: string[];
    diagnostics: { file: string; message: string; severity: string }[];
    activeFile: string | null;
    lastFileChange: string | null;
    lastFileChangeTime: number;
    status: 'idle' | 'busy';
}

const MAX_TERMINAL_LINES = 200;
const PORT = 19854;

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
    // Watch terminal data events
    vscode.window.onDidWriteTerminalData(event => {
        const lines = event.data.split('\n');
        state.terminalLines.push(...lines);
        // Keep only last N lines
        if (state.terminalLines.length > MAX_TERMINAL_LINES) {
            state.terminalLines = state.terminalLines.slice(-MAX_TERMINAL_LINES);
        }
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

    server.listen(PORT, '127.0.0.1', () => {
        console.log(`Foreman Bridge HTTP server running on http://127.0.0.1:${PORT}`);
        vscode.window.showInformationMessage(`Foreman Bridge active on port ${PORT}`);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${PORT} in use — Foreman Bridge already running?`);
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
```

### File 4: `extension/foreman-bridge/.vscodeignore`

```
.vscode/**
src/**
tsconfig.json
**/*.map
node_modules/**
```

### File 5: `extension/foreman-bridge/README.md`

```markdown
# Foreman Bridge

VS Code extension that exposes IDE state to Claude Foreman via a local HTTP server.

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /status` | Bridge health check |
| `GET /output` | Last 50 lines of terminal output |
| `GET /output/all` | All captured terminal output |
| `GET /diagnostics` | Current TypeScript/lint errors |
| `GET /state` | Full bridge state |

## Install in Windsurf

```bash
cd extension/foreman-bridge
npm install
npm run compile
# Then in Windsurf: Cmd+Shift+P → "Developer: Install Extension from Location" → select this folder
```

## Port

Default: `19854` (FORE in a phone keypad... close enough)
```

### Build and verify

```bash
cd extension/foreman-bridge
npm install
npm run compile
ls out/extension.js  # should exist
```

## Commit

```bash
git add extension/
git commit -m "feat: foreman-bridge VS Code extension for Cascade output reading"
```
