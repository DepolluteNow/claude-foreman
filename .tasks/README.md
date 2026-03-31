# Claude Foreman v1.1 — Task List

## CRITICAL RULES

1. **Run tests from repo root**: `python3 -m pytest tests/foreman/ -v`
2. **The `tests/conftest.py` handles sys.path** — `from foreman.xxx` just works
3. **Use `python3`** not `python`
4. **Execute tasks in order** (1 → 8)
5. **Commit after each task**

## Tasks

| # | What | Weight Class |
|---|------|:---:|
| 001 | Rebrand supervisor → foreman in paths/messages | Flyweight |
| 002 | Boxing-themed emojis in Telegram messages | Middleweight |
| 003 | Cursor IDE bridge | Middleweight |
| 004 | Register Cursor in config + IDE driver | Middleweight |
| 005 | GitHub Actions CI workflow | Middleweight |
| 006 | Generic bridge factory (importlib) | Heavyweight |
| 007 | Update tests for renamed paths | Middleweight |
| 008 | Run full test suite, fix failures | Middleweight |

## Project Structure

```
foreman/                    # Main package
├── ring/                   # Core logic (loop, router, watcher, etc.)
├── drivers/                # IDE bridges
│   └── applescript/        # macOS automation
└── comms/                  # Telegram formatting
tests/foreman/              # All tests
```
