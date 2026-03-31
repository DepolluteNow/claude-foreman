# 🥊 Task 8: Run full test suite, fix all failures

## Weight Class: Middleweight (hook)

## What to do

Run the entire test suite and fix any remaining failures. This is the final cleanup task — after this, all tests must pass green.

### Step 1: Run the full suite

```bash
python3 -m pytest tests/foreman/ -v 2>&1
```

### Step 2: Fix any failures

Common issues you might find (from tasks 1-7):

1. **Import errors** — If any `from foreman.xxx` import fails, check that `__init__.py` files exist and module names are correct.

2. **Assertion mismatches** — If a test asserts a string that was changed in tasks 1-2, update the assertion to match the new string.

3. **Missing mock patches** — If new imports were added (e.g., CursorBridge), mock patches in tests might need updating. Patch strings must match the actual import path:
   - `patch("foreman.drivers.cursor_bridge.subprocess.run")` — correct
   - `patch("subprocess.run")` — wrong (patches globally)

4. **New test files not discovered** — Make sure `tests/foreman/__init__.py` exists (it should already).

5. **Config changes breaking router tests** — Task 4 added cursor to config. If router tests assume exactly 2 IDEs, update them.

### Step 3: Verify full green

```bash
python3 -m pytest tests/foreman/ -v --tb=short
```

ALL tests must pass. Zero failures, zero errors.

### Step 4: Quick import check

```bash
python3 -c "from foreman.config import SupervisorConfig; print('config OK')"
python3 -c "from foreman.cli import cli; print('cli OK')"
python3 -c "from foreman.ring.loop import SupervisorLoop; print('loop OK')"
python3 -c "from foreman.drivers.ide_driver import IDEDriver; print('driver OK')"
python3 -c "from foreman.drivers.cursor_bridge import CursorBridge; print('cursor OK')"
python3 -c "from foreman.comms.telegram import format_task_start; print('telegram OK')"
```

All should print "OK".

### Implementation notes

- This task is about debugging, not writing new features
- Read the error message carefully before fixing — don't guess
- If a test is fundamentally wrong (testing removed behavior), delete it and add a replacement
- Run the suite after EACH fix to avoid regressions

## Verify

```bash
python3 -m pytest tests/foreman/ -v
# Expected: ALL PASSED, 0 failures
```

## Commit

```bash
git add -A
git commit -m "test: fix all test failures for v1.1"
```
