---
name: claude-foreman
version: 1.0.0
description: |
  Autonomous coding supervisor — Claude thinks and reviews, free models (Kimi, Gemini)
  do the typing. Dispatch task files to AI assistants running in Windsurf, Antigravity,
  or Cursor. Smart model selection per task. Token accounting after every dispatch.
  Invoke with: /claude-foreman [task-file] [assistant]
  Proactively invoke when the user says "send this to Kimi", "have Windsurf do it",
  "dispatch to Gemini", "use foreman", or writes a .tasks/ file.
allowed-tools:
  - Bash
  - Read
  - Glob
---

# Claude Foreman — Autonomous Coding Supervisor

Claude thinks. Free models type. Foreman makes sure it's done right.

**Goal: minimise Claude tokens per dispatch cycle.**
Every phase is ONE tool call. Never poll in multiple calls. Never read entire files.

## Plugin

All logic lives in the `claude-foreman` Python package.
Install path: `~/CascadeProjects/claude-foreman/`

```bash
# Verify the CLI is available
cd ~/CascadeProjects/claude-foreman && pip install -e . -q
foreman --help
```

## Arguments

- `$ARGUMENTS[0]` — GitHub issue ref (`owner/repo#123`) **or** task file path (`.tasks/NNN-slug.md`)
- `$ARGUMENTS[1]` — assistant: `windsurf` | `antigravity` | `cursor` (default: `windsurf`)

**Prefer GitHub issues over task files.** Issues are already in your workflow,
visible on GitHub, and auto-close when merged. Task files are the fallback
for work that doesn't map to a single issue.

## IDE Configuration

| Assistant | IDE | Port |
|-----------|-----|------|
| Windsurf (Kimi/GPT-4.1) | Windsurf | 19854 |
| Antigravity (Gemini) | Antigravity | 19855 |
| Cursor | Cursor | 19856 |

---

## Workflow A — GitHub Issue (preferred)

One command replaces Phase 0 + Phase 1: pre-flight, branch setup, and dispatch
are all handled by `foreman dispatch-issue`.

```bash
WORKTREE="/absolute/path/to/worktree"
IDE="windsurf"

# Fetch issue, create branch, pre-flight, dispatch — all in one call.
# Prints the pre-dispatch HEAD hash on stdout for Phase 2.
PRE_HEAD=$(foreman dispatch-issue owner/repo#123 \
    --ide "$IDE" \
    --worktree "$WORKTREE")

# Phase 2: wait for agent to commit
foreman wait \
    --worktree "$WORKTREE" \
    --pre-head "$PRE_HEAD" \
    --timeout 600

# Phase 3: review
foreman verify --worktree "$WORKTREE"
```

**What `dispatch-issue` does internally:**
1. Fetches issue via `gh issue view` (title, body, URL)
2. Creates branch `feat/issue-{N}-{slug}` from `origin/main` if needed
3. Runs `foreman preflight` — exits 1 if IDE not ready
4. Opens a fresh IDE window (`--new-window`)
5. Sends the issue body as the agent prompt via `windsurf chat` (primary) or AppleScript (fallback)
6. The commit message will contain `closes #N` — GitHub auto-closes the issue on merge

**Model selection (add to same tool call as needed):**
```bash
python3 -c "
from foreman.models import recommend_for_task, format_recommendation
# For issue-based work, pass the issue title as a string proxy
import tempfile, os
with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
    f.write('# fix: issue title here\n')
    tmp = f.name
a, m = recommend_for_task(tmp, '$IDE')
print(format_recommendation(a, m))
os.unlink(tmp)
"
```

---

## Workflow B — Task File (fallback)

### Phase 0: Pre-flight (1 tool call — HARD GATE, never skip)

```bash
cd ~/CascadeProjects/claude-foreman

# Returns JSON with ready, head, local_branch, bridge_branch, issues
PREFLIGHT=$(foreman preflight \
  --ide windsurf \
  --worktree /absolute/path/to/worktree)
echo "$PREFLIGHT"

# Extract HEAD hash for Phase 2
PRE_HEAD=$(echo "$PREFLIGHT" | python3 -c "import sys,json; print(json.load(sys.stdin)['head'])")
echo "Pre-dispatch HEAD: $PRE_HEAD"
```

**If `ready: false`:** fix the issues listed before proceeding.
Common fixes:
- Wrong folder: reopen IDE on correct path
- Restricted Mode: click "Yes, I trust the authors" in Windsurf
- Wrong branch: `git worktree add ~/CascadeProjects/dn-<slug> -b feat/<slug> origin/main`

### Phase 1: Dispatch — Task File (1 tool call)

```bash
cd ~/CascadeProjects/claude-foreman

foreman dispatch-task /absolute/path/to/.tasks/NNN-slug.md \
  --ide windsurf \
  --worktree /absolute/path/to/worktree
```

The plugin:
1. Opens a fresh IDE window (`windsurf --new-window`) — eliminates stale-tab failures
2. Sends the subagent prompt via `windsurf chat` CLI with `--add-file` — eliminates AppleScript failures
3. Falls back to AppleScript clipboard injection if CLI unavailable
4. Marks the task IN_PROGRESS in state

### Phase 2: Wait (1 tool call — never multiple polls)

```bash
cd ~/CascadeProjects/claude-foreman

foreman wait \
  --worktree /absolute/path/to/worktree \
  --pre-head "$PRE_HEAD" \
  --timeout 600 \
  --interval 30
```

The plugin polls `git rev-parse HEAD` every 30s and exits as soon as HEAD
moves past `$PRE_HEAD`.  This is the most reliable signal — avoids the
`--since` false-trigger failure mode.

Exit 0 = done. Exit 1 = timeout (check IDE for errors or input wait).

### Phase 3: Verify (1 tool call)

```bash
cd ~/CascadeProjects/claude-foreman

foreman verify --worktree /absolute/path/to/worktree
```

Prints: files changed, diff summary, TypeScript errors, circle detection.

**Claude reviews the output and decides:**
- ✅ Clean → `foreman` marks complete internally; move to next task
- ⚠️ Minor issues → re-dispatch (max 2 retries)
- 🔁 Circle detected → Claude takes over (max 50 lines)
- 🚨 Major blocker → escalate to human via Telegram

---

## Smart Model Selection (before Phase 0)

```bash
cd ~/CascadeProjects/claude-foreman
python3 -c "
from foreman.models import recommend_for_task, format_recommendation
a, m = recommend_for_task('/absolute/path/to/.tasks/NNN-slug.md', 'windsurf')
print(format_recommendation(a, m))
"
```

Use the recommended model — it minimises retries and saves Claude tokens.

---

## Token Budget

**Workflow A — GitHub issue (preferred):**

| Phase | Command | Tool calls | Est. tokens |
|-------|---------|-----------|-------------|
| Dispatch (fetch + branch + preflight + send) | `foreman dispatch-issue` | 1 | ~400 |
| Wait | `foreman wait` | 1 | ~400 |
| Verify | `foreman verify` | 1 | ~500 |
| **Total** | | **3** | **~1,300** |

**Workflow B — Task file:**

| Phase | Command | Tool calls | Est. tokens |
|-------|---------|-----------|-------------|
| Model selection | `python3 -c "from foreman.models..."` | 1 | ~200 |
| Pre-flight | `foreman preflight` | 1 | ~300 |
| Dispatch | `foreman dispatch-task` | 1 | ~300 |
| Wait | `foreman wait` | 1 | ~400 |
| Verify | `foreman verify` | 1 | ~500 |
| **Total** | | **5** | **~1,700** |

---

## Token Accounting (run after every dispatch)

After `foreman verify`, produce this table:

```
## Foreman Dispatch Report — Task NNN

| Phase | Tool Calls | Est. Tokens |
|-------|-----------|-------------|
| Model selection | 1 | ~200 |
| Pre-flight | 1 | ~300 |
| Dispatch | 1 | ~300 |
| Wait | 1 | ~400 |
| Verify | 1 | ~500 |
| **Foreman Total** | **5** | **~1,700** |

### Savings vs. Claude doing it directly

| Metric | Value |
|--------|-------|
| Lines generated by free model | N |
| If Claude wrote this directly | ~X tokens |
| Foreman overhead | ~1,700 tokens |
| **Tokens saved** | **~X (Y%)** |
| **Cost avoided** | **~$X.XX** |
```

Pricing reference: Claude Sonnet output = $15/M tokens ($0.015 per 1K).
Delegated work to Kimi/Gemini = $0 (free tier).

---

## Anti-Patterns

1. ❌ Skip Phase 0 — dispatching without verifying branch/folder caused the worst failures
2. ❌ Multiple poll calls — `foreman wait` is ONE blocking call
3. ❌ `git log --since` — matches existing HEAD; always compare against saved hash
4. ❌ Relative paths in task files — always use absolute paths
5. ❌ Dispatch when IDE has multiple windows open — `foreman dispatch-task` handles this via `--new-window`
6. ❌ Read full files to verify — `foreman verify` shows only what matters
7. ❌ Quit IDE without checking if agent is still running — check bridge `/files` first

## Failure Reference

| # | What happened | Fix |
|---|---------------|-----|
| 1 | Wrong branch dispatch | Phase 0 pre-flight is mandatory |
| 2 | Wait loop false trigger | `--pre-head` comparison, not `--since` |
| 3 | Model switch wrong command | Use `foreman` CLI, not AppleScript guesses |
| 4 | Multi-window dispatch went to wrong project | `--new-window` in dispatch-task |
| 5 | Keystrokes hit editor, not Cascade | `windsurf chat` CLI avoids this entirely |
| 6 | Relative path resolved against wrong workspace | Absolute paths + `--add-file` |
| 7 | Cascade input not focused | `windsurf chat` avoids this entirely |
| 8 | `windsurf chat` opened wrong workspace | Always pass absolute worktree path |
| 9 | Quit Windsurf while Cascade was running | Check bridge `/files` before quitting |

## Task File Format

Task files live in `.tasks/NNN-slug.md`:

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
git add -A && git commit -m "type: description"
\`\`\`
```

## Bridge HTTP Endpoints (for manual inspection)

```bash
PORT=19854  # 19854=windsurf, 19855=antigravity, 19856=cursor
curl -s http://127.0.0.1:$PORT/status    # version check
curl -s http://127.0.0.1:$PORT/git       # branch, log
curl -s http://127.0.0.1:$PORT/health    # alive, last save age
curl -s http://127.0.0.1:$PORT/files     # recent saves
curl -s http://127.0.0.1:$PORT/diagnostics  # TypeScript errors
```
