import pytest
from unittest.mock import patch, MagicMock
from foreman.drivers.gemini_bridge import GeminiBridge
from foreman.bridge_interface import AIStatus, AIBridgeError


@pytest.fixture
def bridge():
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._detect_method") as mock:
        mock.return_value = "applescript"
        return GeminiBridge()


def test_send_calls_applescript(bridge):
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._applescript_send") as mock:
        bridge.send("create a component")
        mock.assert_called_once_with("create a component")


def test_status_returns_idle(bridge):
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._applescript_status") as mock:
        mock.return_value = "idle"
        assert bridge.status() == AIStatus.IDLE


def test_status_returns_generating(bridge):
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._applescript_status") as mock:
        mock.return_value = "generating"
        assert bridge.status() == AIStatus.GENERATING


def test_read_output(bridge):
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._applescript_read") as mock:
        mock.return_value = "Here is the implementation..."
        assert "implementation" in bridge.read_output()


def test_accept_all(bridge):
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._applescript_accept") as mock:
        bridge.accept_all()
        mock.assert_called_once()


def test_reject(bridge):
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._applescript_reject") as mock:
        bridge.reject()
        mock.assert_called_once()


def test_bridge_error_on_missing_process():
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._detect_method") as mock:
        mock.side_effect = AIBridgeError("Antigravity not running")
        with pytest.raises(AIBridgeError):
            GeminiBridge()
