# 🥊 Task 3: Cursor IDE bridge

## Weight Class: Middleweight (hook)

## What to do

Create a new bridge for Cursor IDE at `foreman/drivers/cursor_bridge.py`. Follow the exact same pattern as `cascade_bridge.py` (Windsurf) — same structure, same methods, targeting Cursor instead.

### Create `foreman/drivers/cursor_bridge.py`

```python
import subprocess
from pathlib import Path
from typing import Optional

from foreman.bridge_interface import AIBridge, AIBridgeError, AIStatus

APPLESCRIPT_DIR = Path(__file__).parent / "applescript"


class CursorBridge(AIBridge):
    """Bridge to Cursor IDE's AI panel via AppleScript."""

    def __init__(self):
        self._method = self._detect_method()

    def _detect_method(self) -> str:
        """Detect if Cursor is running."""
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "detect_ide.scpt")],
            capture_output=True,
            text=True,
        )
        ide = result.stdout.strip()
        if ide != "Cursor":
            raise AIBridgeError(f"Cursor not running (detected: {ide})")

        ipc_path = self._find_ipc_socket()
        if ipc_path:
            return "ipc"
        return "applescript"

    def _find_ipc_socket(self) -> Optional[str]:
        """Check for Cursor's VS Code Extension Host socket."""
        import glob
        sockets = glob.glob("/tmp/vscode-ipc-*.sock") + glob.glob("/tmp/cursor-ipc-*.sock")
        # IPC client not implemented yet — always fall back to AppleScript
        return None

    def send(self, prompt: str) -> None:
        if self._method == "applescript":
            self._applescript_send(prompt)
        else:
            raise AIBridgeError(f"Unknown method: {self._method}")

    def status(self) -> AIStatus:
        if self._method == "applescript":
            raw = self._applescript_status()
            return AIStatus(raw) if raw in ("idle", "generating", "waiting_input") else AIStatus.IDLE
        raise AIBridgeError(f"Unknown method: {self._method}")

    def read_output(self, lines: int = 50) -> str:
        if self._method == "applescript":
            return self._applescript_read()
        raise AIBridgeError(f"Unknown method: {self._method}")

    def accept_all(self) -> None:
        if self._method == "applescript":
            self._applescript_accept()
        else:
            raise AIBridgeError(f"Unknown method: {self._method}")

    def reject(self) -> None:
        if self._method == "applescript":
            self._applescript_reject()
        else:
            raise AIBridgeError(f"Unknown method: {self._method}")

    def recalibrate(self) -> None:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "cursor_composer.scpt"), "recalibrate"],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AIBridgeError(f"Recalibrate failed: {result.stderr}")

    # ── AppleScript helpers ─────────────────────────────────────

    def _applescript_send(self, prompt: str) -> None:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "cursor_composer.scpt"), "send", prompt],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AIBridgeError(f"Send failed: {result.stderr}")

    def _applescript_status(self) -> str:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "cursor_composer.scpt"), "status"],
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()

    def _applescript_read(self) -> str:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "cursor_composer.scpt"), "read"],
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()

    def _applescript_accept(self) -> None:
        subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "cursor_composer.scpt"), "accept"],
            capture_output=True,
            text=True,
        )

    def _applescript_reject(self) -> None:
        subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "cursor_composer.scpt"), "reject"],
            capture_output=True,
            text=True,
        )
```

### Create test file `tests/foreman/test_cursor_bridge.py`

Follow the same pattern as `test_cascade_bridge.py` but for CursorBridge:

```python
import pytest
from unittest.mock import patch, MagicMock
from foreman.drivers.cursor_bridge import CursorBridge
from foreman.bridge_interface import AIBridgeError, AIStatus


@patch("foreman.drivers.cursor_bridge.subprocess.run")
def test_detect_cursor_running(mock_run):
    mock_run.return_value = MagicMock(stdout="Cursor\n", returncode=0)
    bridge = CursorBridge()
    assert bridge._method == "applescript"


@patch("foreman.drivers.cursor_bridge.subprocess.run")
def test_detect_cursor_not_running(mock_run):
    mock_run.return_value = MagicMock(stdout="Windsurf\n", returncode=0)
    with pytest.raises(AIBridgeError, match="Cursor not running"):
        CursorBridge()


@patch("foreman.drivers.cursor_bridge.subprocess.run")
def test_send_calls_applescript(mock_run):
    mock_run.return_value = MagicMock(stdout="Cursor\n", returncode=0)
    bridge = CursorBridge()
    bridge.send("hello")
    # Second call should be the send
    assert mock_run.call_count >= 2


@patch("foreman.drivers.cursor_bridge.subprocess.run")
def test_status_returns_idle(mock_run):
    mock_run.return_value = MagicMock(stdout="Cursor\n", returncode=0)
    bridge = CursorBridge()
    mock_run.return_value = MagicMock(stdout="idle\n", returncode=0)
    assert bridge.status() == AIStatus.IDLE
```

### Notes

- The AppleScript file `cursor_composer.scpt` doesn't need to exist yet (it's a placeholder for macOS automation) — the bridge just calls it
- Pattern matches `cascade_bridge.py` exactly — same structure, same error handling
- The `_find_ipc_socket` looks for `/tmp/cursor-ipc-*.sock` in addition to `/tmp/vscode-ipc-*.sock`

## Verify

```bash
python3 -m pytest tests/foreman/test_cursor_bridge.py -v
```

## Commit

```bash
git add foreman/drivers/cursor_bridge.py tests/foreman/test_cursor_bridge.py
git commit -m "feat: add Cursor IDE bridge"
```
