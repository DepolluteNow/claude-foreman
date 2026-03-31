# 🥊 Task 6: Generic bridge factory (importlib)

## Weight Class: Heavyweight (uppercut)

## What to do

Replace the hardcoded `BRIDGE_REGISTRY` in `foreman/drivers/ide_driver.py` with a dynamic factory that uses `importlib` to load bridge classes by name. This makes adding new IDEs a zero-code change — just add to config.

### File 1: `foreman/drivers/ide_driver.py` — Full rewrite

```python
import importlib
from foreman.bridge_interface import AIBridge, AIBridgeError, AIStatus
from foreman.config import SupervisorConfig


# Maps bridge_type → (module_path, class_name)
# New bridges only need an entry here + the module file
BRIDGE_REGISTRY: dict[str, tuple[str, str]] = {
    "cascade": ("foreman.drivers.cascade_bridge", "CascadeBridge"),
    "gemini": ("foreman.drivers.gemini_bridge", "GeminiBridge"),
    "cursor": ("foreman.drivers.cursor_bridge", "CursorBridge"),
}


def _load_bridge_class(bridge_type: str) -> type[AIBridge]:
    """
    Dynamically load a bridge class using importlib.

    Looks up (module_path, class_name) from BRIDGE_REGISTRY,
    imports the module, and returns the class.

    Raises AIBridgeError if the bridge type is unknown or import fails.
    """
    entry = BRIDGE_REGISTRY.get(bridge_type)
    if not entry:
        raise AIBridgeError(
            f"Unknown bridge type: {bridge_type}. "
            f"Available: {', '.join(sorted(BRIDGE_REGISTRY.keys()))}"
        )

    module_path, class_name = entry
    try:
        module = importlib.import_module(module_path)
        cls = getattr(module, class_name)
    except (ImportError, AttributeError) as e:
        raise AIBridgeError(f"Failed to load bridge '{bridge_type}': {e}") from e

    if not issubclass(cls, AIBridge):
        raise AIBridgeError(f"Bridge class {class_name} does not implement AIBridge")

    return cls


class IDEDriver:
    """Unified driver that routes commands to the correct IDE bridge.

    Bridges are loaded lazily via importlib — only imported when first used.
    This means a missing Cursor install doesn't break Windsurf users.
    """

    def __init__(self, config: SupervisorConfig):
        self.config = config
        self._bridges: dict[str, AIBridge] = {}

    def get_bridge(self, ide_name: str) -> AIBridge:
        """Get or create the bridge for the given IDE."""
        if ide_name not in self._bridges:
            ide_config = self.config.ides.get(ide_name)
            if not ide_config:
                raise AIBridgeError(f"Unknown IDE: {ide_name}")
            bridge_cls = _load_bridge_class(ide_config.bridge_type)
            self._bridges[ide_name] = bridge_cls()
        return self._bridges[ide_name]

    def send(self, ide: str, prompt: str) -> None:
        self.get_bridge(ide).send(prompt)

    def status(self, ide: str) -> AIStatus:
        return self.get_bridge(ide).status()

    def read_output(self, ide: str, lines: int = 50) -> str:
        return self.get_bridge(ide).read_output(lines)

    def accept_all(self, ide: str) -> None:
        self.get_bridge(ide).accept_all()

    def reject(self, ide: str) -> None:
        self.get_bridge(ide).reject()

    def recalibrate(self, ide: str) -> None:
        self.get_bridge(ide).recalibrate()
```

### Key design decisions

1. **`BRIDGE_REGISTRY` is now a dict of `(module_path, class_name)` tuples** — no more direct imports at module level
2. **`_load_bridge_class()` uses `importlib.import_module()`** — lazy loading means missing bridge modules don't crash the app
3. **`issubclass` check** ensures loaded class actually implements `AIBridge`
4. **Clear error messages** — tells you which bridge types are available when one is unknown
5. **Same public API** — `IDEDriver` methods are identical, tests still work

### Test additions: `tests/foreman/test_ide_driver.py` (new file)

```python
import pytest
from unittest.mock import patch, MagicMock
from foreman.drivers.ide_driver import _load_bridge_class, IDEDriver, BRIDGE_REGISTRY
from foreman.bridge_interface import AIBridge, AIBridgeError
from foreman.config import SupervisorConfig


def test_bridge_registry_has_all_types():
    """All known bridge types are in the registry."""
    assert "cascade" in BRIDGE_REGISTRY
    assert "gemini" in BRIDGE_REGISTRY
    assert "cursor" in BRIDGE_REGISTRY


def test_load_bridge_class_unknown_type():
    """Unknown bridge type raises AIBridgeError."""
    with pytest.raises(AIBridgeError, match="Unknown bridge type"):
        _load_bridge_class("nonexistent")


def test_load_bridge_class_import_error():
    """ImportError is wrapped in AIBridgeError."""
    with patch.dict(BRIDGE_REGISTRY, {"bad": ("nonexistent.module", "Cls")}):
        with pytest.raises(AIBridgeError, match="Failed to load"):
            _load_bridge_class("bad")


def test_load_bridge_class_not_subclass():
    """Class that doesn't implement AIBridge raises error."""
    with patch.dict(BRIDGE_REGISTRY, {"fake": ("builtins", "str")}):
        with pytest.raises(AIBridgeError, match="does not implement"):
            _load_bridge_class("fake")


def test_ide_driver_unknown_ide():
    """Unknown IDE name raises error."""
    config = SupervisorConfig.default()
    driver = IDEDriver(config)
    with pytest.raises(AIBridgeError, match="Unknown IDE"):
        driver.get_bridge("vscode")


def test_ide_driver_caches_bridges():
    """Bridge instances are cached (same object returned twice)."""
    config = SupervisorConfig.default()
    driver = IDEDriver(config)
    # Mock the bridge class to avoid needing actual IDE
    mock_cls = MagicMock(return_value=MagicMock(spec=AIBridge))
    with patch("foreman.drivers.ide_driver._load_bridge_class", return_value=mock_cls):
        b1 = driver.get_bridge("windsurf")
        b2 = driver.get_bridge("windsurf")
        assert b1 is b2
        assert mock_cls.call_count == 1  # only instantiated once
```

## Verify

```bash
python3 -m pytest tests/foreman/test_ide_driver.py -v
```

## Commit

```bash
git add foreman/drivers/ide_driver.py tests/foreman/test_ide_driver.py
git commit -m "feat: generic bridge factory with importlib lazy loading"
```
