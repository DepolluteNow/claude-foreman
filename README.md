# Claude Foreman

> Claude thinks. Free models type. Foreman makes sure it's done right.

An autonomous coding supervisor that routes tasks to free AI models while you sleep. Named after George Foreman — because every coding session deserves a heavyweight champion in your corner.

## The Fight Card

Claude Foreman is your **corner coach**. It decomposes your goal into tasks, dispatches each as a **jab**, **hook**, or **uppercut** to the right sparring partner (free AI model), watches the round play out, and steps into the ring when your partner goes in circles.

```
                                  CORNER (Claude)
                          decompose | review | takeover
                                    |
                    +---------+-----+-----+---------+
                    |                                |
            WINDSURF RING                    ANTIGRAVITY RING
            +-----------+                    +--------------+
            | Kimi      |                    | Gemini 3.1   |
            | SWE 1.5   |                    | Gemini Flash |
            +-----------+                    +--------------+
              jab/hook                        uppercut/cross
          (quick, standard)                (complex, multi-file)
```

## Weight Classes

| Weight Class | Punch | Sparring Partner | When |
|:---:|:---:|:---:|:---|
| **Flyweight** | Jab | SWE 1.5 (Windsurf) | Rename, move, add import, boilerplate |
| **Middleweight** | Hook | Kimi (Windsurf) | New component, API route, write test |
| **Heavyweight** | Uppercut | Gemini 3.1 (Antigravity) | Refactor, migrate, 3+ files |
| **Champion** | Cross | Kimi (Windsurf) | Payload CMS, codebase-specific patterns |

## Rounds

Every task goes through rounds:

1. **DECOMPOSE** — Claude breaks the goal into ordered task specs (one Opus turn)
2. **ROUTE** — Heuristic classifies each task by weight class (zero cost)
3. **DISPATCH** — Sends the punch to the right ring (near-zero tokens)
4. **WAIT** — Watches the sparring partner work via `git diff` polling (zero tokens)
5. **REVIEW** — Claude reads the diff, scores the round (one Sonnet turn)
6. **DECISION** —
   - **Clean round** — Next task
   - **Standing 8-count** — Minor fix, retry (max 2)
   - **Going in circles** — Claude takes over (max 50 lines)
   - **Throw in the towel** — Escalate to human via Telegram

## Token Budget (per 10-task bout)

| Phase | Tokens | Notes |
|-------|--------|-------|
| DECOMPOSE | ~5K (once) | Front-load all thinking |
| ROUTE | 0 | Heuristic only |
| DISPATCH | ~500 | Format prompt |
| WAIT | 0 | Shell polling |
| REVIEW | ~3K | Read diff |
| TAKEOVER | ~2K (rare) | Write fix |
| **Total** | **~35-50K** | Free models do all the coding |

## Quick Start

### Install

```bash
pip install claude-foreman
# or
git clone https://github.com/DepolluteNow/claude-foreman.git
cd claude-foreman && pip install -e .
```

### Launch (in Claude Code)

```bash
claude --channels plugin:telegram@claude-plugins-official \
       --dangerously-load-development-channels server:claude-peers
```

Then tell Claude:
```
Start supervisor. Goal: implement user authentication.
Use Windsurf (Kimi) and Antigravity (Gemini 3.1).
```

### Resume after crash
```
Resume supervisor.
```

State persists to `~/.claude/foreman-state.json`. Survives context compression, session crashes, and Mac sleep.

## Self-Improvement (The Training Camp)

After each bout, Foreman runs a **retrospective**:
- Measures first-try rate per model per task type
- Updates routing weights (adaptive routing)
- Guards against regressions (if rate drops, reverts changes)
- Persists learnings to `~/.claude/foreman-learnings.json`

Each project makes the next one cheaper and faster. The system cannot degrade over time.

```json
{
  "first_try_rate_history": [0.50, 0.65, 0.72, 0.80],
  "model_performance": {
    "kimi": {"standard": 0.85, "complex": 0.55},
    "gemini-3.1": {"complex": 0.78, "standard": 0.80}
  },
  "patterns": {
    "always": ["specify exact file paths", "paste relevant context"],
    "never": ["say 'fix the bug' without the error message"]
  }
}
```

## Circle Detection (Going in Circles Guard)

Foreman detects three patterns that mean the sparring partner is looping:

| Pattern | Detection | Action |
|---------|-----------|--------|
| **Same Region** | Same file + same line range edited twice | Takeover |
| **Same Error** | Same TypeScript/lint error on retry | Takeover |
| **Net Zero** | Adding what was previously removed | Takeover |

When detected, Claude steps into the ring and writes the fix directly (max 50 lines). If the fix would be larger, it escalates to you via Telegram.

## Architecture

```
foreman/
├── bridge_interface.py     # Abstract interface for AI panel bridges
├── config.py               # IDE registry, model catalog, paths
├── cli.py                  # Click CLI: foreman start/resume/status/stop
├── ring/                   # The Ring — where the fight happens
│   ├── loop.py             # Main state machine (the referee)
│   ├── router.py           # Smart task router (the matchmaker)
│   ├── watcher.py          # Filesystem watcher (the judges)
│   ├── state.py            # State persistence (the scorecard)
│   ├── takeover.py         # Circle detection + takeover (the corner)
│   └── learnings.py        # Self-improvement loop (the training camp)
├── drivers/                # IDE Bridges — how punches land
│   ├── cascade_bridge.py   # Windsurf (Cascade AI panel)
│   ├── gemini_bridge.py    # Antigravity (Gemini AI panel)
│   ├── ide_driver.py       # Unified driver (routes to right ring)
│   └── applescript/        # macOS automation scripts
│       ├── detect_ide.scpt
│       ├── windsurf_cascade.scpt
│       └── antigravity_gemini.scpt
└── comms/
    └── telegram.py         # Message formatting for Telegram channel
```

## Adding a New Ring (IDE Support)

Claude Foreman works with any VS Code fork. To add support for a new IDE (e.g., Cursor):

1. Create `foreman/drivers/cursor_bridge.py` implementing `AIBridge`
2. Create `foreman/drivers/applescript/cursor_ai.scpt`
3. Register in `foreman/drivers/ide_driver.py` BRIDGE_REGISTRY
4. Add IDE config in `foreman/config.py`

The bridge interface is 6 methods: `send`, `status`, `read_output`, `accept_all`, `reject`, `recalibrate`.

## Tests

```bash
python3 -m pytest tests/foreman/ -v
# 83 tests, <0.5s
```

## Why "Foreman"?

George Foreman was known for his **devastating power** and **relentless pressure**. He didn't dance around — he moved forward and delivered. That's what this tool does: it doesn't waste tokens on ceremony. It decomposes, dispatches, reviews, and moves on.

And like George Foreman's famous grill, it just works. Set it up, let it run, come back to done work.

## Philosophy

> *"The question isn't who is going to let me; it's who is going to stop me."* — George Foreman (attributed)

Claude Foreman embodies **sovereign abundance through automation**: the best quality for the least cost. Claude's intelligence is expensive and precious — use it for thinking, not typing. Let the free models type.

## License

MIT

## Credits

Built by [Depollute Now!](https://depollutenow.com) — the human movement for planetary restoration.
