# 🥊 Task 2: Boxing-themed emojis in Telegram messages

## Weight Class: Middleweight (hook)

## What to do

Replace generic emojis in `foreman/comms/telegram.py` with boxing-themed ones. Keep all message logic the same — just swap emojis and add a boxing flavor to the language.

### Changes to `foreman/comms/telegram.py`

Replace each function's emoji and phrasing:

#### `format_task_start`
```python
# Before
f"▶️ Task {task.id}/{total} starting: {task.spec[:80]}  →  {task.model} in {task.ide}"
# After
f"🥊 Round {task.id}/{total} — FIGHT! {task.spec[:80]}  →  {task.model} in {task.ide}"
```

#### `format_task_done`
```python
# Before
f"✅ Task {task.id}/{total} done: ..."
# After — clean win = KO, with retries = decision
# If no retries:
f"🏆 Round {task.id}/{total} — KO! {task.spec[:60]} ({duration_sec}s, {task.model})"
# If retries > 0:
f"🏆 Round {task.id}/{total} — Won by decision! {task.spec[:60]} ({duration_sec}s, {task.model}, {task.retries} standing counts)"
```

#### `format_takeover`
```python
# Before
f"⚡ Took over task {task.id}/{total} — ..."
# After
f"🔔 Round {task.id}/{total} — Corner steps in! {task.model} was on the ropes at {task.spec[:40]}, fixed in {lines_changed} lines. Fight continues."
```

#### `format_escalation`
```python
# Before
f"🔴 Task {task.id}/{total} PAUSED: ..."
# After
f"🛑 Round {task.id}/{total} — REFEREE STOP! {task.spec[:60]}\n"
f"{reason}\n"
f"Scorecard: {diff_summary[:200]}\n\n"
f"Corner instructions:\n"
f"• guidance (e.g. \"use Users collection\")\n"
f"• \"throw in the towel\" to skip\n"
f"• \"stop the fight\" to save and quit"
```

#### `format_completion`
```python
# Before
f"🏁 All {summary['completed']}/{summary['total']} tasks complete.\n..."
# After
f"🏆🥊 FIGHT OVER! {summary['completed']}/{summary['total']} rounds won.\n"
f"Fight time: {duration_min}min | Corner tokens: {state.total_claude_tokens:,} | "
f"Referee stops: {escalations} | Corner takeovers: {takeovers}\n"
f"The champ's record is updated. Branch ready for judges."
```

### Implementation notes

- Keep the function signatures identical
- Keep all imports the same
- The return types stay `str`
- Retries → "standing counts", escalations → "referee stops", takeover → "corner steps in"

## Verify

```bash
python3 -m pytest tests/foreman/test_loop.py -v -k "mark"
```

Tests that check for specific emoji characters (`✅`, `🏁`) will break — that's expected. Task 007 updates the test assertions.

## Commit

```bash
git add foreman/comms/telegram.py
git commit -m "feat: boxing-themed emojis in telegram messages"
```
