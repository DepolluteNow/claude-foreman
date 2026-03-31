import pytest
from unittest.mock import patch, MagicMock
from foreman.drivers.cascade_bridge import CascadeBridge
from foreman.bridge_interface import AIStatus, AIBridgeError


@pytest.fixture
def bridge():
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._detect_method") as mock:
        mock.return_value = "applescript"
        return CascadeBridge()


def test_send_calls_applescript(bridge):
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._applescript_send") as mock:
        bridge.send("write a login form")
        mock.assert_called_once_with("write a login form")


def test_status_returns_idle_when_not_generating(bridge):
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._applescript_status") as mock:
        mock.return_value = "idle"
        assert bridge.status() == AIStatus.IDLE


def test_status_returns_generating(bridge):
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._applescript_status") as mock:
        mock.return_value = "generating"
        assert bridge.status() == AIStatus.GENERATING


def test_read_output_returns_text(bridge):
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._applescript_read") as mock:
        mock.return_value = "Here is the login form component..."
        result = bridge.read_output(lines=10)
        assert "login form" in result


def test_accept_all_calls_applescript(bridge):
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._applescript_accept") as mock:
        bridge.accept_all()
        mock.assert_called_once()


def test_reject_calls_applescript(bridge):
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._applescript_reject") as mock:
        bridge.reject()
        mock.assert_called_once()


def test_recalibrate_rescans(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(returncode=0, stdout="OK")
        bridge.recalibrate()
        # Should not raise


def test_bridge_error_on_missing_process():
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._detect_method") as mock:
        mock.side_effect = AIBridgeError("Windsurf not running")
        with pytest.raises(AIBridgeError):
            CascadeBridge()
