# AGENTS.md — Rules for AI agents working on claude-foreman

## Mandatory workflow for every task

1. **Read the issue spec** — `gh issue view <N> --comments` for the grilled brief + acceptance criteria + latest Coach instructions
2. **Check for existing PRs** — `gh pr list --search "<N>" --state all`. If a PR exists, the issue is taken. Do not open another unless the Coach explicitly instructs fusion mode.
3. **Check the status label** — `gh issue view <N> --json labels --jq '.labels[].name'`. If any of `status:dispatched`, `status:claimed`, `status:in-review`, `status:approved`, `status:merged-staging`, or `status:done` is present, stand down — the issue is taken.
4. **Create a branch** — `feat/issue-<N>-<slug>` or `fix/issue-<N>-<slug>`
5. **Implement** — follow existing code conventions, check imports/interfaces
6. **Test** — `npm run build && npm test` must be green before pushing
7. **Open a PR** — body must contain `Closes #N`
8. **Post the done-signal** — `gh pr comment <PR> --body "@hayssamhob ✅ #N done — <one sentence>"`
   - This is MANDATORY. The Coach loop gates on it. Without it, automerge never fires.
   - See `gotchas.md` G7 for details.

## Status label lifecycle

Every dispatchable issue carries a `status:*` label reflecting its real state. The Coach applies labels at each transition; Fighters MUST check the label before picking up work.

| Label | Meaning | Who sets it | When |
|-------|---------|-------------|------|
| `status:queued` | Task ready for dispatch, not yet assigned | Coach | Issue creation |
| `status:dispatched` | Fighter assigned, work started, no PR yet | Coach | At dispatch |
| `status:claimed` | Fighter has pushed a branch / opened a PR | Fighter | PR creation |
| `status:in-review` | PR under Coach review | Coach | Review started |
| `status:changes-requested` | Coach requested changes | Coach | Review feedback |
| `status:approved` | Coach approved, waiting for CI/merge | Coach | Approval |
| `status:merged-staging` | Merged to a staging branch, awaiting promotion to main | Coach | After staging merge |
| `status:done` | Merged to main, issue closed | Coach | After main merge |
| `status:failed` | Fighter failed, task returned to queue | Coach | After failure |
| `status:stopped` | Halted by owner, relaunch returns to queued | Coach | Manual stop |

**Anti-collision rule (G10)**: Before picking up any issue, a Fighter MUST verify all three:
1. `gh issue view <N> --comments` — read the latest comments for Coach instructions
2. `gh pr list --search "<N>" --state all` — if a PR exists, the issue is taken
3. `gh issue view <N> --json labels --jq '.labels[].name'` — if any taken-status label is present, stand down

**Coach responsibility for staging workflows**: Merges to `staging` do not trigger GitHub auto-close. The Coach MUST manually close the issue and apply `status:merged-staging` immediately after the staging merge, not later.

## Done-contract checklist

For every PR, before you consider the task done:

- [ ] Branch created with correct naming
- [ ] Code follows existing conventions (check neighboring files)
- [ ] `npm run build` passes (TypeScript compiles)
- [ ] `npm test` passes (all tests green)
- [ ] PR opened with `Closes #N` in the body
- [ ] **Done-signal comment posted on the PR**: `@hayssamhob ✅ #N done — <sentence>`

## Key files

- `gotchas.md` — project-specific pitfalls (READ THIS, every mistake is documented here)
- `SPEC.md` — the full specification (§5.7, §6.3, §8 for acceptance criteria)
- `src/dispatch/adapter.ts` — the `FighterAdapter` interface that all adapters implement
- `src/protocol/labels.ts` — label conventions (`agent:X`, `status:X`, `trust:L1/L2/L3`)
- `src/automerge.ts` — the merge gate (CI, threads, hold, trust, preview)

## Test framework

- **Vitest** (not Jest) — use `vi.mock`, `vi.fn`, `vi.stubGlobal`, `vi.stubEnv`
- Run: `npm test` or `npx vitest run <file>`

## CI

- GitHub Actions matrix: ubuntu-latest, macos-latest, windows-latest
- Windows fails on `better-sqlite3` (needs Visual Studio) — this is a known false negative
- Use `gh pr merge --admin` to override if Windows is the only failure

## Resolving PR review threads

GitHub PR review threads do NOT auto-resolve when you push fixes. Use the GraphQL API:

```bash
gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:"THREAD_ID"}) { thread { id isResolved } } }'
```
