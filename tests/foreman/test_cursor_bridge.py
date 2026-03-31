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
