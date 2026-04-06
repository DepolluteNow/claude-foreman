---
name: claude-foreman
version: 1.0.0
description: |
  Autonomous coding supervisor — Claude thinks and reviews, free models (Kimi, Gemini)
  do the typing. Dispatch task files to AI assistants running in Windsurf, Antigravity,
  or Cursor via the foreman Python library and CLI.
  Smart model selection per task. Token accounting after every dispatch.
  Invoke with: /claude-foreman [task-file] [assistant]
  Proactively invoke when the user says "send this to Kimi", "have Windsurf do it",
  "dispatch to Gemini", "use foreman", or writes a .tasks/ file.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Agent
---

# Claude Foreman — Autonomous Coding Supervisor

Claude thinks. Free models type.

Source: `~/CascadeProjects/claude-foreman/`
Install: `pip install -e ~/CascadeProjects/claude-foreman/` (if not already installed)

## Arguments

- `$ARGUMENTS[0]` — task file path (e.g., `.tasks/010-extension-v2.md`)
- `$ARGUMENTS[1]` — assistant target: `windsurf` | `antigravity` | `cursor` (default: `windsurf`)

If no arguments provided, check for the most recent `.tasks/*.md` file and ask which assistant.

## IDE Configuration

| Assistant | IDE | Port | CLI |
|-----------|-----|------|-----|
| Kimi / Claude / GPT | Windsurf | 19854 | `windsurf chat` |
| Gemini | Antigravity | 19855 | AppleScript only |
| Cursor AI | Cursor | 19856 | AppleScript only |

## Workflow — 5 Phases, 6 Tool Calls Max

All phases call the `foreman` CLI, which wraps the Python library.
Never reimplement phase logic inline — use the CLI.

---

### Phase 0: Pre-Flight (1 tool call — MANDATORY, NEVER SKIP)

```bash
TASK_FILE="/absolute/path/to/.tasks/NNN-slug.md"
WORKTREE="/absolute/path/to/repo"
IDE="windsurf"   # windsurf | antigravity | cursor

# Verify IDE state, record HEAD hash for Phase 2
PREFLIGHT=$(foreman preflight --ide "$IDE" --worktree "$WORKTREE" 2>/dev/null)
echo "$PREFLIGHT"
PRE_HEAD=$(echo "$PREFLIGHT" | python3 -c "import sys,json; print(json.load(sys.stdin)['head'])")
echo "Pre-dispatch HEAD: $PRE_HEAD"
```

**What this checks:**
- IDE bridge is reachable and on the correct workspace (guards Failure 4: wrong window)
- Local branch is what you expect
- Records the HEAD hash — used in Phase 2 to detect NEW commits only (guards Failure 2: --since false trigger)

**If preflight exits 1:** fix the reported issues before dispatching:
- Wrong folder → `foreman preflight` will say so; run `open -a Windsurf "$WORKTREE"` and re-check
- Restricted Mode → click the blue "Yes, I trust the authors" button in Windsurf, then retry
- Bridge unavailable → install foreman-bridge extension from `~/CascadeProjects/claude-foreman/extension/foreman-bridge/`

**Model selection (optional, include in same tool call):**
```bash
python3 -c "
from foreman.models import recommend_for_task, format_recommendation
a, m = recommend_for_task('$TASK_FILE', '$IDE')
print(format_recommendation(a, m))
"
```

---

### Phase 1: Dispatch (1 tool call)

```bash
foreman dispatch-task "$TASK_FILE" \
    --ide "$IDE" \
    --worktree "$WORKTREE"
```

This single command:
1. Opens a fresh `--new-window` in the IDE (eliminates stale-tab failures)
2. Waits 2 seconds for the IDE to settle
3. Sends `dispatch.windsurf_prompt` via `windsurf chat` (primary) or AppleScript (fallback)
4. Attaches the task file via `--add-file` so the agent reads every step (eliminates Failure 6: relative path resolution)

**Do NOT** use raw `osascript` clipboard injection — it is the legacy fallback, subject to 7 documented failure modes. The `foreman dispatch-task` command handles all of this correctly.

---

### Phase 2: Wait (1 tool call — ONE loop, never multiple polls)

```bash
foreman wait \
    --worktree "$WORKTREE" \
    --pre-head "$PRE_HEAD" \
    --timeout 600 \
    --interval 30
```

Blocks until HEAD moves past `$PRE_HEAD`, exits 0 on success, 1 on timeout.

The watcher uses three signals in priority order:
1. `head_changed` — any new commit (fastest, most reliable)
2. `committed` — a `foreman-task-{id}:` commit specifically
3. File stability — fallback for agents that don't commit immediately

**Do NOT** use `git log --since` — it matches the existing HEAD commit (Failure 2).
**Do NOT** poll with multiple separate Bash calls — use one `foreman wait` call.

---

### Phase 3: Verify (1–2 tool calls)

```bash
foreman verify --worktree "$WORKTREE"
```

Prints:
- Files changed
- `git diff --stat`
- TypeScript/lint errors (from foreman-bridge diagnostics)
- Circle detection result (SAME_REGION, SAME_ERROR, NET_ZERO)
- Full diff (truncated to 500 lines)

Claude reads this output and decides:
- ✅ **Clean** → `foreman mark-clean` (or just proceed to next task)
- ⚠️ **Minor fix** → re-dispatch with retry note (handled automatically via `foreman dispatch-task` retry)
- 🔁 **Circle detected** → Claude takeover (max 50 lines, then `foreman mark-takeover N`)
- 🚨 **Blocker** → `foreman mark-escalated "reason"` + Telegram notification

**If extension code changed** (second tool call only):
```bash
cd ~/CascadeProjects/claude-foreman/extension/foreman-bridge && \
npm run compile 2>&1 && \
npx @vscode/vsce package 2>&1 && \
/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf \
    --install-extension foreman-bridge-*.vsix --force 2>&1 && \
osascript -e '
tell application "System Events"
    tell (first process whose bundle identifier is "com.exafunction.windsurf")
        set frontmost to true; delay 0.3
        keystroke "p" using {command down, shift down}; delay 0.5
        set the clipboard to ">Developer: Reload Window"
        keystroke "v" using command down; delay 0.3
        key code 36
    end tell
end tell'
```

---

### Phase 4: Test Bridge (1 tool call — only when extension changed)

```bash
PORT=19854
sleep 5
curl -s "http://127.0.0.1:${PORT}/status" && \
curl -s "http://127.0.0.1:${PORT}/health" && \
curl -s "http://127.0.0.1:${PORT}/git"
```

---

### Phase 5: Token Accounting (MANDATORY after every dispatch)

```
## Foreman Dispatch Report — Task NNN

| Phase | Tool Calls | Est. Tokens |
|-------|-----------|-------------|
| Pre-flight + model select | 1 | ~400 |
| Dispatch | 1 | ~300 |
| Wait | 1 | ~400 |
| Verify | 1–2 | ~600 |
| **Foreman Total** | **4–5** | **~1,700** |

### Savings Estimate
| Metric | Value |
|--------|-------|
| Lines generated by free model | N |
| Files created/modified | N |
| If Claude wrote this directly | ~X tokens |
| Foreman overhead | ~1,700 tokens |
| **Tokens saved** | **~X (Y%)** |
| **Cost equivalent saved** | **~$X.XX** |
```

Pricing: Claude Sonnet output = $15/M tokens ($0.015/K). Free models = $0.

---

## Token Budget

| Phase | Target | Max Tool Calls |
|-------|--------|---------------|
| Pre-flight + model select | ~400 | 1 |
| Dispatch | ~300 | 1 |
| Wait | ~400 | 1 |
| Verify | ~600 | 2 |
| **Total** | **~1,700** | **5** |

---

## Anti-Patterns (NEVER)

1. ❌ Skip Phase 0 — dispatching blind caused the worst failures
2. ❌ Use `git log --since` — matches existing HEAD (Failure 2)
3. ❌ Multiple separate poll calls — use one `foreman wait` call
4. ❌ Raw AppleScript clipboard injection instead of `foreman dispatch-task`
5. ❌ Relative paths in dispatch prompts — `foreman dispatch-task` uses `--add-file` with absolute paths
6. ❌ Dispatch when multiple IDE windows are open without verifying the right one
7. ❌ Quit IDE without checking if agent is still running (check bridge `/files` first)
8. ❌ Assume bridge is on correct project when multiple windows exist
9. ❌ Reimplement phase logic inline with bash — always use the `foreman` CLI

---

## Task File Format

Lives in `.tasks/NNN-slug.md`:

```markdown
# Task N: Title

## What to do

Step-by-step instructions with exact code changes.

### File: `path/to/file.ext`

#### 1. Description

\`\`\`language
exact code
\`\`\`

### Build and verify

\`\`\`bash
commands to verify
\`\`\`

## Commit

\`\`\`bash
git add -A && git commit -m "foreman-task-N: description"
\`\`\`
```

The commit message MUST start with `foreman-task-{id}:` — this is the signal
`foreman wait` uses to confirm the right task finished.

---

## Parallel Dispatch (multiple assistants)

```bash
# Dispatch to Windsurf and Antigravity simultaneously
foreman dispatch-task .tasks/011-frontend.md --ide windsurf --worktree ~/CascadeProjects/dn-windsurf &
foreman dispatch-task .tasks/012-backend.md --ide antigravity --worktree ~/CascadeProjects/dn-antigravity &
wait

# Monitor both (in a single Bash call)
foreman wait --worktree ~/CascadeProjects/dn-windsurf --pre-head "$HEAD_WS" &
foreman wait --worktree ~/CascadeProjects/dn-antigravity --pre-head "$HEAD_AG" &
wait
```

---

## Bridge Endpoints Reference

All served by the `foreman-bridge` VS Code extension (port per IDE).

| Endpoint | Returns | Use For |
|----------|---------|---------|
| `/status` | version, IDE, port | Version check |
| `/health` | alive, sinceLastSaveMs, errorCount | Quick poll |
| `/git` | branch, status, diff, log | Verify correct workspace |
| `/files` | saves (last 20), events | Detect if agent still active |
| `/output` | terminal lines (last 50) | Build output |
| `/diagnostics` | errors, warnings | Compile errors |

---

## Lessons Learned (hard-won)

| # | Failure | Root Cause | Fix in foreman CLI |
|---|---------|------------|-------------------|
| 1 | Dispatched to wrong branch | No pre-dispatch verification | `foreman preflight` is mandatory Phase 0 |
| 2 | Wait loop false-triggered | `git log --since` matched existing HEAD | `foreman wait --pre-head HASH` compares exact hash |
| 3 | AppleScript used wrong command | Guessed command name | Fixed: correct command is `>Switch AI Provider` |
| 4 | Keystroke went to wrong window | Multiple Windsurf windows open | `foreman dispatch-task --new-window` opens clean window |
| 5 | Keystrokes hit editor not Cascade | Cascade panel not focused | `windsurf chat` CLI bypasses focus entirely |
| 6 | Cascade resolved wrong relative path | Prompt used relative path | `--add-file` with absolute path via `foreman dispatch-task` |
| 7 | Cascade input not focused | Electron web DOM invisible to AppleScript | `windsurf chat` CLI is the primary dispatch method |
| 8 | `windsurf chat` opened wrong workspace | Wrong path argument | `foreman dispatch-task` copies task to worktree and uses absolute paths |
| 9 | Quit IDE during active Cascade session | No active-session check | Check bridge `/files` (sinceLastSaveMs < 60s = still active) before quitting |
