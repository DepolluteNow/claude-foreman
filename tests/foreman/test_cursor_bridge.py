import pytest
from unittest.mock import patch, MagicMock
from foreman.drivers.cursor_bridge import CursorBridge
from foreman.bridge_interface import AIBridgeError, AIStatus


@pytest.fixture
def bridge():
    with patch("foreman.drivers.cursor_bridge.CursorBridge._check_http") as mock_http, \
         patch("foreman.drivers.cursor_bridge.CursorBridge._verify_ide_running"):
        mock_http.return_value = False
        return CursorBridge(ide_name="cursor")


def test_send_calls_applescript(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(returncode=0)
        bridge.send("hello")
        assert mock.called


def test_status_returns_idle(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(stdout="idle\n", returncode=0)
        assert bridge.status() == AIStatus.IDLE


def test_bridge_error_on_missing_process():
    with patch("foreman.drivers.cursor_bridge.CursorBridge._check_http", return_value=False), \
         patch("subprocess.run") as mock:
        mock.return_value = MagicMock(stdout="none\n", returncode=0)
        with pytest.raises(AIBridgeError):
            CursorBridge(ide_name="cursor")


def test_port_assignment():
    with patch("foreman.drivers.cursor_bridge.CursorBridge._check_http", return_value=False), \
         patch("foreman.drivers.cursor_bridge.CursorBridge._verify_ide_running"):
        b = CursorBridge(ide_name="cursor")
        assert b._port == 19856


def test_read_output_without_http(bridge):
    result = bridge.read_output()
    assert "bridge not available" in result
