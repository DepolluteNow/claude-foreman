# 🥊 Task 7: Update tests for renamed paths and boxing emojis

## Weight Class: Middleweight (hook)

## What to do

Previous tasks renamed "supervisor" to "foreman" and changed emojis to boxing-themed. The tests still assert the OLD values. Update them.

### File 1: `tests/foreman/test_config.py`

#### Change test_config_state_file_path:
```python
# Before
assert config.state_file == "~/.claude/supervisor-state.json"
# After
assert config.state_file == "~/.claude/foreman-state.json"
```

#### Change test_config_learnings_file_path:
```python
# Before
assert config.learnings_file == "~/.claude/supervisor-learnings.json"
# After
assert config.learnings_file == "~/.claude/foreman-learnings.json"
```

#### Add test for cursor IDE:
```python
def test_cursor_ide_config():
    config = SupervisorConfig.default()
    assert "cursor" in config.ides
    cursor = config.ides["cursor"]
    assert cursor.process_name == "Cursor"
    assert cursor.bridge_type == "cursor"
```

### File 2: `tests/foreman/test_cli.py`

#### Change test_status_no_state:
```python
# Before
assert "No active supervisor session" in result.output
# After
assert "No active foreman session" in result.output
```

### File 3: `tests/foreman/test_loop.py`

#### Change docstring:
```python
# Before
"""Tests for the supervisor loop orchestrator — mechanical parts only."""
# After
"""Tests for the foreman loop orchestrator — mechanical parts only."""
```

#### Update emoji assertions in test_mark_clean:
```python
# Before
assert "✅" in msg or "done" in msg.lower()
# After
assert "🏆" in msg or "KO" in msg
```

#### Update emoji assertion in test_complete_updates_learnings:
```python
# Before
assert "🏁" in msg or "complete" in msg.lower()
# After
assert "🏆" in msg or "FIGHT OVER" in msg
```

#### Update emoji assertion in test_mark_takeover:
```python
# Before (just checks "12 lines")
assert "12 lines" in msg
# After
assert "12 lines" in msg
assert "🔔" in msg or "Corner steps in" in msg
```

### Implementation notes

- Only change assertions, not test logic
- Don't rename test functions (they describe what's tested, not internal names)
- All tests should pass after this task + tasks 1-6

## Verify

```bash
python3 -m pytest tests/foreman/ -v
```

Some tests may still fail if they depend on runtime behavior from tasks 1-6. That's fine — Task 8 does the final fix-up.

## Commit

```bash
git add tests/foreman/test_config.py tests/foreman/test_cli.py tests/foreman/test_loop.py
git commit -m "test: update assertions for foreman rebrand and boxing emojis"
```
