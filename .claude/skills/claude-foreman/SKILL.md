---
name: claude-foreman
version: 1.1.0
description: |
  Autonomous coding supervisor — Claude thinks and reviews, free models (Kimi, Gemini)
  do the typing. Dispatch GitHub issues or task files to Windsurf, Antigravity, or Cursor.
  Create new issues and dispatch them in one shot. Run queues of issues end-to-end.
  Invoke with: /claude-foreman [issue-ref|task-file] [assistant]
  Proactively invoke when the user says "send this to Kimi", "have Windsurf do it",
  "dispatch to Gemini", "use foreman", "create an issue for X", or writes a .tasks/ file.
allowed-tools:
  - Bash
  - Read
  - Glob
---

# Claude Foreman — Autonomous Coding Supervisor

Claude thinks. Free models type. Foreman makes sure it's done right.

**Goal: minimise Claude tokens per dispatch cycle.**
Every phase is ONE Bash tool call. Never poll in multiple calls. Never read full files.

## Plugin

All logic lives in the `claude-foreman` Python package.
Source: `~/CascadeProjects/claude-foreman/`

```bash
foreman --help   # verify CLI is installed
```

## Arguments

- `$ARGUMENTS[0]` — one of:
  - GitHub issue ref: `owner/repo#123` or full issue URL
  - Task file path: `/abs/path/to/.tasks/NNN-slug.md`
  - Nothing — check for pending `.tasks/*.md` and ask
- `$ARGUMENTS[1]` — `windsurf` | `antigravity` | `cursor` (default: `windsurf`)

## IDE Ports

| IDE | Port |
|-----|------|
| Windsurf | 19854 |
| Antigravity | 19855 |
| Cursor | 19856 |

---

## Choosing a Workflow

| Situation | Command |
|-----------|---------|
| Issue already exists on GitHub | `foreman dispatch-issue` |
| Need to CREATE the issue first | `foreman create-and-dispatch` |
| Multiple issues, run sequentially | `foreman queue` |
| Detailed task file (no GitHub issue) | `foreman dispatch-task` |

---

## Workflow A — Dispatch Existing Issue (3 tool calls)

```bash
REPO="depollutenow/depollute-shop"
IDE="windsurf"
WORKTREE="/absolute/path/to/worktree"

# Phase 1: fetch + branch + dirty-check + preflight + open IDE + dispatch
# JSON output on stdout — extract head + worktree for Phase 2
OUT=$(foreman dispatch-issue "$REPO#42" \
    --ide "$IDE" --worktree "$WORKTREE" \
    --comment)                          # posts "🤖 Dispatched..." on GitHub issue
PRE_HEAD=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['head'])")

# Phase 2: block until agent commits; create PR automatically on success
foreman wait \
    --worktree "$WORKTREE" \
    --pre-head "$PRE_HEAD" \
    --issue "$REPO#42" \
    --auto-pr \                         # runs gh pr create, posts PR link as comment
    --timeout 600

# Phase 3: diff + closing-ref check + TypeScript errors + optional tests
foreman verify \
    --worktree "$WORKTREE" \
    --issue "$REPO#42" \
    --run-tests "npm test -- --passWithNoTests"
```

**Safety guards built into every dispatch:**
- Dirty worktree check — refuses to dispatch if uncommitted changes exist
- Pre-flight — verifies IDE is on the correct workspace/branch (no wrong-window dispatch)
- `--new-window` — opens a fresh IDE window (no stale tabs)
- `windsurf chat` CLI — avoids all AppleScript focus failures
- HEAD-hash comparison in wait — no `--since` false triggers
- Timeout diagnosis — screenshot + bridge health check on timeout

**On timeout:** `foreman wait` automatically takes a screenshot to `/tmp/foreman-timeout-*.png`
and queries the bridge `/health` endpoint to tell you if the agent is still saving files or stuck.

---

## Workflow B — Create Issue Then Dispatch (3 tool calls)

Use this when the work isn't tracked on GitHub yet. Claude writes the spec,
this command creates the issue and dispatches it in one shot.

```bash
# Claude writes the issue body to a temp file first:
cat > /tmp/issue-spec.md << 'EOF'
## What to do
Implement dark mode toggle in the settings page.

### Steps
1. Add `darkMode` boolean to user preferences schema
2. Add toggle UI in `Settings.tsx`
3. Apply `dark` class to `<html>` based on preference

### Acceptance criteria
- Toggle persists across page reloads (localStorage)
- All existing tests pass
EOF

# Create GitHub issue + dispatch in one call
OUT=$(foreman create-and-dispatch depollutenow/depollute-shop \
    "Add dark mode toggle to settings page" \
    --body-file /tmp/issue-spec.md \
    --ide windsurf \
    --worktree ~/CascadeProjects/dn-windsurf \
    --comment)

# Extract fields from JSON output
PRE_HEAD=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['head'])")
ISSUE_REF=$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['repo']+'#'+str(d['number']))")
echo "Created and dispatched: $ISSUE_REF"

# Wait + auto-PR (same as Workflow A)
foreman wait \
    --worktree ~/CascadeProjects/dn-windsurf \
    --pre-head "$PRE_HEAD" \
    --issue "$ISSUE_REF" \
    --auto-pr

foreman verify \
    --worktree ~/CascadeProjects/dn-windsurf \
    --issue "$ISSUE_REF"
```

**When to use `create-and-dispatch` vs writing a task file:**
- Use `create-and-dispatch` when the work should be tracked on GitHub (most cases)
- Use `dispatch-task` for purely internal/infra work that doesn't need a GitHub record

---

## Workflow C — Queue (1 tool call for N issues)

Runs multiple issues sequentially end-to-end: dispatch → wait → verify → PR.
Each issue gets its own isolated worktree (`dn-issue-{N}`) by default.

```bash
foreman queue \
    depollutenow/depollute-shop#42 \
    depollutenow/depollute-shop#43 \
    depollutenow/depollute-shop#44 \
    --ide windsurf \
    --worktree ~/CascadeProjects/dn-windsurf \
    --auto-pr \
    --run-tests "npm test -- --passWithNoTests" \
    --timeout 600 \
    --stop-on-failure     # halt if any issue fails (default)
```

Queue prints a summary at the end:
```
✅ depollutenow/depollute-shop#42 → https://github.com/.../pull/101
✅ depollutenow/depollute-shop#43 → https://github.com/.../pull/102
❌ depollutenow/depollute-shop#44 (tests failed)
```

**Queue is the power move.** While you sleep, Foreman dispatches all three,
waits for each, verifies, creates PRs, and stops if anything needs human attention.

---

## Workflow D — Task File (fallback, no GitHub issue)

```bash
# Phase 0: preflight (also checks for dirty worktree)
PREFLIGHT=$(foreman preflight \
    --ide windsurf \
    --worktree /abs/path/to/worktree \
    --branch feat/my-branch)
PRE_HEAD=$(echo "$PREFLIGHT" | python3 -c "import sys,json; print(json.load(sys.stdin)['head'])")

# Phase 1: dispatch task file
foreman dispatch-task /abs/path/to/.tasks/010-slug.md \
    --ide windsurf \
    --worktree /abs/path/to/worktree

# Phase 2: wait
foreman wait --worktree /abs/path/to/worktree --pre-head "$PRE_HEAD"

# Phase 3: verify
foreman verify --worktree /abs/path/to/worktree --run-tests "npm test"
```

---

## Token Budget

| Workflow | Tool calls | Est. tokens |
|----------|-----------|-------------|
| A — dispatch-issue + wait + verify | 3 | ~1,300 |
| B — create-and-dispatch + wait + verify | 3 | ~1,400 |
| C — queue (N issues) | 1 | ~500 + N×200 |
| D — task file (preflight + dispatch + wait + verify) | 4 | ~1,600 |

Queue is the most token-efficient for multiple issues.

---

## After `foreman verify` — Claude's Decision

| Signal | Action |
|--------|--------|
| No errors, closing ref present, tests pass | ✅ Mark clean, next issue |
| Missing `closes #N` in commit | Ask agent to amend commit |
| TypeScript errors | Re-dispatch with error context |
| Circle detected | Claude takes over (max 50 lines) |
| Tests failing | Re-dispatch or escalate |
| Timeout + bridge shows no recent saves | Agent stuck — check screenshot, retry |

---

## Token Accounting (after every dispatch)

```
## Foreman Report — [issue ref or task]

| Phase | Calls | Tokens |
|-------|-------|--------|
| Dispatch | 1 | ~400 |
| Wait | 1 | ~400 |
| Verify | 1 | ~500 |
| Total | 3 | ~1,300 |

Free model generated: N lines across M files
If Claude wrote directly: ~X tokens
Savings: ~Y% (~$Z.ZZ avoided)
```

Pricing: Claude Sonnet = $15/M tokens. Kimi/Gemini = $0 (free tier).

---

## Anti-Patterns

1. ❌ Multiple poll calls — `foreman wait` is ONE blocking call
2. ❌ `git log --since` — use `--pre-head` hash comparison instead
3. ❌ Relative paths — always absolute paths to task files and worktrees
4. ❌ Dispatch to a dirty worktree — `foreman` will catch it, but don't ignore the error
5. ❌ Skip `--issue` on `foreman wait` — without it, no auto-PR and no GitHub comment
6. ❌ Read full files to verify — `foreman verify` shows only what matters
7. ❌ Quit IDE while agent is running — check bridge `/health` first

## Failure Reference

| # | What happened | Fix in Foreman |
|---|---------------|----------------|
| 1 | Wrong branch dispatch | Dirty worktree guard + preflight (now in every command) |
| 2 | Wait loop false trigger | `--pre-head` HEAD comparison |
| 3 | Model switch wrong command | Use `foreman` CLI |
| 4 | Multi-window dispatch to wrong project | `--new-window` + `--per-worktree` in queue |
| 5 | Keystrokes hit editor not Cascade | `windsurf chat` CLI primary path |
| 6 | Relative path resolved against wrong workspace | Absolute paths + `--add-file` |
| 7 | Cascade input not focused | `windsurf chat` CLI avoids entirely |
| 8 | `windsurf chat` opened wrong workspace | Absolute worktree path enforced |
| 9 | Quit Windsurf while Cascade running | Timeout diagnosis checks bridge `/health` |
| 10 | No GitHub record of what was dispatched | `--comment` posts dispatch + completion |
| 11 | Commit missing `closes #N` | `foreman verify --issue` validates closing ref |
| 12 | Tests passed locally but CI fails | `--run-tests CMD` runs suite before marking clean |

## Bridge HTTP Endpoints (for manual inspection)

```bash
PORT=19854  # 19855=antigravity, 19856=cursor
curl -s http://127.0.0.1:$PORT/status      # version, uptime
curl -s http://127.0.0.1:$PORT/git         # branch, log
curl -s http://127.0.0.1:$PORT/health      # alive, sinceLastSaveMs, diagnosticCount
curl -s http://127.0.0.1:$PORT/files       # recent saves (last 20)
curl -s http://127.0.0.1:$PORT/diagnostics # TypeScript errors
```
