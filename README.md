<p align="center">
  <img src="docs/assets/social-preview.png" alt="Foreman — The Coach thinks. open weight models type. Foreman makes sure it's done right." width="760">
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2ea44f">
  <a href="https://github.com/hayssamhob/claude-foreman/issues"><img alt="open issues" src="https://img.shields.io/github/issues/hayssamhob/claude-foreman?color=58a6ff"></a>
  <a href="https://github.com/hayssamhob/claude-foreman/issues?q=is%3Aissue+label%3A%22good+first+issue%22"><img alt="good first issues" src="https://img.shields.io/github/issues/hayssamhob/claude-foreman/good%20first%20issue?label=good%20first%20issues&color=7057ff"></a>
  <img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-39d0d8">
  <img alt="building in public" src="https://img.shields.io/badge/status-building%20in%20public-f0b72f">
</p>

# Claude Foreman

> The Coach thinks. open weight models type. Foreman makes sure it's done right.

Foreman is a **GitHub-native autonomous coding supervisor**. It is a [Probot](https://probot.github.io/)
GitHub App that watches a repository's issues and labels, wakes the matching **Fighter** adapter
to implement a grilled issue brief, opens a PR, and gates the merge behind Coach review and a
deterministic Referee gate. Work flows as a queue of GitHub issues:
**dispatch → grill → implement → review → merge**.

Dispatch is driven by **GitHub labels** (`agent:devin`, `agent:cursor`, `agent:ollama`,
`agent:devin-local`, `agent:api`), not by local IDE automation. Each label maps to a pluggable
Fighter adapter that knows how to wake one runtime. The Coach (a senior model) stays strategic —
scope, briefs, review — while free/cheap Fighters do the tactical typing.

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="How Foreman works — the governed loop: a GitHub issue goes to the Corner (Claude plans), into the Ring (open weight models write the code), through the Referee (tests + Coach verdict gate), and out as a merged PR or an escalation to you." width="100%">
</p>

**Manage whole projects on GitHub** — the board shows which fighter is on which issue, live:

<p align="center">
  <img src="docs/assets/fleet-board.svg" alt="Foreman fleet board — a GitHub Projects kanban (Backlog, In the Ring, Needs You, Shipped) where every card shows the agent working it." width="100%">
</p>

## Requirements

- **Node.js** (a modern LTS, ≥ 20) and npm
- A **GitHub App** installed on the target repository, with:
  - App ID
  - Private key
  - Webhook secret
  - These are supplied to the Probot app via the standard Probot environment variables
    (`APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`). Never commit real secrets to the repo —
    provide them through your runtime secret store / GitHub Actions secrets.
- **[`gh` CLI](https://cli.github.com/)** — authenticated (`gh auth login`), for local dev and testing

## Install & Run

```bash
git clone https://github.com/hayssamhob/claude-foreman.git
cd claude-foreman
npm install
npm run build
```

Run the Probot app in production (requires the Probot env vars above):

```bash
npm run start
```

Run locally with hot-reload via `tsx` (no build step needed):

```bash
npm run dev
```

The app reacts to GitHub webhook events (issue labels, comments, pull requests, PR closes) and
drives the loop. It is **not** a slash-command CLI — there is no `foreman dispatch` or
`foreman wait`; dispatch, review, and merge are the App's job, triggered by GitHub events.

## CLI: `foreman` (scaffolding helper)

The `foreman` binary (installed from `bin/foreman.js` via `package.json`) is a **scaffolding
helper**, not a dispatch CLI. It does not dispatch, wait, or verify issues — that is the App's
job. It currently supports:

```bash
foreman init                 # scaffold loop-budget.md + loop-run-log.md in the current repo
foreman init --pattern <name># scaffold a standing GitHub Actions workflow + README from a recipe in recipes/
foreman patterns             # list available recipes from recipes/
```

Recipes live in `recipes/` (e.g. `pr-babysitter`, `daily-triage`, `ci-sweeper`,
`dependency-sweeper`, `issue-triage`, `post-merge-cleanup`, `changelog-drafter`).

## Architecture

```
src/
├── index.ts              # Probot app entry — webhook handlers, sweepers, worker/junior loops
├── automerge.ts          # the merge gate: CI, threads, hold label, trust tier, preview
├── handlers.ts           # webhook event handlers (comments, epic labels, PRs, PR close)
├── github.ts             # GitHub API wrappers (post messages, set labels, split repo)
├── threads.ts            # PR review-thread / CI / changed-files state
├── dashboard.ts          # live fleet board rendering
├── config.ts             # runtime config (DB path, installation id, etc.)
├── dispatch/             # wake-up layer — one FighterAdapter per runtime
│   ├── adapter.ts        #   the FighterAdapter contract + shared scope-exclusion helper
│   ├── devin.ts          #   agent:devin — Devin cloud
│   ├── devin-local.ts    #   agent:devin-local — Devin CLI, detached local spawn
│   ├── cursor.ts         #   agent:cursor — Cursor CLI
│   ├── ollama.ts         #   agent:ollama — local Ollama via HTTP API
│   ├── api.ts            #   agent:api — BYO-key OpenAI-compatible endpoint
│   ├── fusion.ts         #   fusion:on — two Fighters on one issue
│   └── capacity.ts       #   per-agent concurrency limits
├── drivers/              # Coach + Fighter driver implementations
│   ├── coach.ts          #   Coach driver contract
│   ├── coach-claude.ts   #   Claude Coach
│   ├── coach-codex.ts    #   Codex CLI Coach
│   ├── coach-gemini.ts   #   Gemini CLI Coach
│   ├── council.ts        #   council recipe (multi-Coach)
│   ├── fighter.ts        #   Fighter driver
│   ├── api.ts            #   BYO-key API driver (OpenAI-compatible)
│   ├── claude.ts         #   Claude driver
│   ├── fusion.ts         #   fusion driver
│   └── recipe-router.ts  #   routes a recipe to the right driver
├── referee/              # the merge gate's checks
│   ├── checks.ts         #   CI / threads / hold / trust / preview gate checks
│   ├── trust-gate.ts     #   risk classification + trust gate
│   ├── trust-tier.ts     #   trust:L1/L2/L3 ladder
│   ├── claimcheck.ts     #   deterministic claim verification (no senior tokens)
│   ├── circle.ts         #   circle detection (same-region / same-error / net-zero)
│   ├── readiness.ts      #   PR readiness state
│   ├── stall.ts          #   stall detection
│   ├── prefilter.ts      #   pre-review filter
│   ├── outcome.ts        #   outcome classification
│   ├── evolution.ts      #   routing-weight evolution
│   ├── preview-mcp.ts    #   MCP preview gate
│   └── test-grounded-judge.ts # test-grounded verdict
├── guard/                # safety guards
│   ├── bash.ts           #   shell command guard
│   ├── exclusion.ts      #   hard-scope exclusion (auth/payments/secrets/migrations)
│   ├── secretscan.ts     #   secret-scan hook on Fighter output
│   └── untrusted.ts      #   untrusted-input handling (G3: never feed raw issue/PR text)
├── loop/
│   └── discovery.ts      # loop queue discovery
├── manager/              # the Coach loop worker
│   ├── worker.ts         #   the manager worker (polls the queue, drives the loop)
│   ├── runner.ts         #   run loop iteration
│   └── prompts.ts        #   Coach prompt assembly
├── junior/               # the junior/Fighter runner
│   ├── runner.ts         #   junior loop runner
│   ├── git.ts            #   git operations
│   └── prompts.ts        #   Fighter prompt assembly
├── state/                # SQLite-backed state (better-sqlite3)
│   ├── db.ts             #   the Store: tasks, PRs, leases, cache
│   └── sync.ts           #   crash recovery + cache rebuild from GitHub
├── protocol/             # label + message conventions
│   ├── labels.ts         #   agent:X, status:X, trust:L1/L2/L3, epic:M*, branch naming
│   └── messages.ts       #   canonical comment templates
└── skill/
    └── foreman-skill.ts  # foreman skill generation

bin/foreman.js            # the `foreman` CLI binary (scaffolding only — see CLI section)
recipes/                  # standing-loop recipes consumed by `foreman init --pattern`
test/                     # Vitest test suite
```

## Tests

```bash
npm test        # vitest run
```

CI runs on Ubuntu, macOS, and Windows via GitHub Actions. (Windows can fail on the native
`better-sqlite3` build — a known false negative, not a real regression.)

## License

MIT — Built by [Depollute Now!](https://depollutenow.com)
