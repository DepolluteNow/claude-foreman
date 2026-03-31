# 🥊 Task 10: Extension v0.2.0 — file watcher, git endpoints, save tracking

## Weight Class: Heavyweight (uppercut)

## What to do

Upgrade the foreman-bridge VS Code extension with three new capabilities:

1. **File watcher** — track all file creates/deletes/renames in the workspace
2. **Git status endpoint** — run `git diff --stat HEAD` and `git log --oneline -5` from the extension
3. **Save history** — track the last 50 file saves with timestamps

### File: `extension/foreman-bridge/src/extension.ts`

#### 1. Add file change tracking to BridgeState

Add these fields to the `BridgeState` interface:

```typescript
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
```

Initialize the new fields:
```typescript
saveHistory: [],
fileEvents: [],
```

#### 2. Add a FileSystemWatcher

After the file save tracking section, add:

```typescript
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
```

#### 3. Update save tracking to keep history

Replace the existing `onDidSaveTextDocument` handler:

```typescript
vscode.workspace.onDidSaveTextDocument(doc => {
    const file = vscode.workspace.asRelativePath(doc.uri);
    state.lastFileChange = file;
    state.lastFileChangeTime = Date.now();
    state.saveHistory.push({ file, time: Date.now() });
    if (state.saveHistory.length > 50) state.saveHistory = state.saveHistory.slice(-50);
}, null, context.subscriptions);
```

#### 4. Add git endpoint using child_process

Add this import at the top:
```typescript
import { execSync } from 'child_process';
```

Add a helper function before `activate`:
```typescript
function runGit(command: string): string {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) return '(no workspace)';
    try {
        return execSync(`git ${command}`, { cwd: workspaceRoot, timeout: 5000 }).toString().trim();
    } catch {
        return '(git error)';
    }
}
```

#### 5. Add new HTTP endpoints

Inside the `http.createServer` callback, add these routes BEFORE the 404 handler:

```typescript
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
```

Update the 404 endpoints list too:
```typescript
endpoints: ['/status', '/output', '/output/all', '/diagnostics', '/state', '/git', '/files', '/health'],
```

#### 6. Bump version

In `extension/foreman-bridge/package.json`, change version to `"0.2.0"`.

In the `/status` response, change `version: '0.1.0'` to `version: '0.2.0'`.

### Build and verify

```bash
cd extension/foreman-bridge
npm install
npm run compile
# Should compile clean with zero errors
```

### Test the new endpoints mentally

- `GET /git` → returns current branch, short status, diff stat, recent log
- `GET /files` → returns last 20 saves and 30 file events
- `GET /health` → returns quick health check with ms since last save

## Commit

```bash
git add extension/foreman-bridge/
git commit -m "feat: extension v0.2.0 — git endpoints, file watcher, save history"
```
