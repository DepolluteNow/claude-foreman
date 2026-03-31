# 🥊 Task 1: Rebrand supervisor → foreman

## Weight Class: Flyweight (jab)

## What to do

Replace all remaining "supervisor" references with "foreman" in three files.

### File 1: `foreman/config.py`

Change:
```python
state_file: str = "~/.claude/supervisor-state.json"
learnings_file: str = "~/.claude/supervisor-learnings.json"
```
To:
```python
state_file: str = "~/.claude/foreman-state.json"
learnings_file: str = "~/.claude/foreman-learnings.json"
```

### File 2: `foreman/cli.py`

Replace ALL occurrences:
- `"~/.claude/supervisor-state.json"` → `"~/.claude/foreman-state.json"`
- `"Supervisor already active"` → `"Foreman already active"`
- `"Use 'supervisor resume'"` → `"Use 'foreman resume'"`
- `"No supervisor session found."` → `"No foreman session found."`
- `"No active supervisor session."` → `"No active foreman session."`
- `"Supervisor started."` → `"Foreman started."`
- `"Supervisor session cleared."` → `"Foreman session cleared."`
- `"No session to clear."` → stays the same
- All docstrings: "supervisor" → "foreman"

### File 3: `foreman/ring/loop.py`

Update docstrings only — replace "supervisor" with "foreman" in comments and docstrings. Don't rename class/method names.

## Verify

```bash
python3 -m pytest tests/foreman/test_config.py tests/foreman/test_cli.py -v
```

Note: tests will FAIL because they still assert old paths. That's expected — Task 007 updates the tests.

## Commit

```bash
git add foreman/config.py foreman/cli.py foreman/ring/loop.py
git commit -m "feat: rebrand supervisor references to foreman"
```
