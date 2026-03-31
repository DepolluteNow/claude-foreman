# 🥊 Task 4: Register Cursor in config + IDE driver

## Weight Class: Middleweight (hook)

## What to do

Add Cursor as a third IDE option in the config and register it in the IDE driver's bridge registry.

### File 1: `foreman/config.py`

Add a `cursor` entry to the `ides` dict in `SupervisorConfig.default()`:

```python
"cursor": IDEConfig(
    process_name="Cursor",
    worktree="~/CascadeProjects/dn-cursor",
    models=[
        ModelInfo("cursor-small", "fast", "free"),
        ModelInfo("gpt-4o", "medium", "cheap"),
    ],
    default_model="cursor-small",
    bridge_type="cursor",
),
```

Add it **after** the `"antigravity"` entry, inside the `ides={}` dict.

### File 2: `foreman/drivers/ide_driver.py`

1. Add import at top:
```python
from foreman.drivers.cursor_bridge import CursorBridge
```

2. Add to `BRIDGE_REGISTRY`:
```python
BRIDGE_REGISTRY = {
    "cascade": CascadeBridge,
    "gemini": GeminiBridge,
    "cursor": CursorBridge,
}
```

### File 3: `foreman/ring/router.py`

In the `DEFAULT_ROUTES` dict, add cursor as an alternative for `codebase_specific` tasks. Find the existing routes and update:

```python
DEFAULT_ROUTES = {
    "trivial": ("swe1.5", "windsurf"),
    "standard": ("kimi", "windsurf"),
    "complex": ("gemini-3.1", "antigravity"),
    "codebase_specific": ("kimi", "windsurf"),
}
```

No changes needed to DEFAULT_ROUTES — Cursor is available but not a default route. The adaptive routing will pick it up from learnings if it performs well.

## Verify

```bash
python3 -m pytest tests/foreman/test_config.py tests/foreman/test_router.py -v
```

Some tests asserting only 2 IDEs may need updating — that's Task 007's job.

## Commit

```bash
git add foreman/config.py foreman/drivers/ide_driver.py
git commit -m "feat: register Cursor IDE in config and bridge registry"
```
