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
