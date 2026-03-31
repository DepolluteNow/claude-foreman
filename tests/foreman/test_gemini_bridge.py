import pytest
from unittest.mock import patch, MagicMock
from foreman.drivers.gemini_bridge import GeminiBridge
from foreman.bridge_interface import AIStatus, AIBridgeError


@pytest.fixture
def bridge():
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._check_http") as mock_http, \
         patch("foreman.drivers.gemini_bridge.GeminiBridge._verify_ide_running"):
        mock_http.return_value = False
        return GeminiBridge(ide_name="antigravity")


@pytest.fixture
def bridge_with_http():
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._check_http") as mock_http, \
         patch("foreman.drivers.gemini_bridge.GeminiBridge._verify_ide_running"):
        mock_http.return_value = True
        b = GeminiBridge(ide_name="antigravity")
        b._http_available = True
        return b


def test_send_calls_applescript(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(returncode=0)
        bridge.send("refactor the auth module")
        assert mock.called


def test_status_returns_idle(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(stdout="idle\n", returncode=0)
        assert bridge.status() == AIStatus.IDLE


def test_status_returns_generating(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(stdout="generating\n", returncode=0)
        assert bridge.status() == AIStatus.GENERATING


def test_read_output(bridge_with_http):
    with patch.object(bridge_with_http, "_http_get") as mock:
        mock.return_value = {"lines": ["compiled OK", "tests passed"], "total": 2}
        result = bridge_with_http.read_output()
        assert "tests passed" in result


def test_accept_all(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(returncode=0)
        bridge.accept_all()


def test_reject(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(returncode=0)
        bridge.reject()


def test_bridge_error_on_missing_process():
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._check_http", return_value=False), \
         patch("subprocess.run") as mock:
        mock.return_value = MagicMock(stdout="none\n", returncode=0)
        with pytest.raises(AIBridgeError):
            GeminiBridge(ide_name="antigravity")


def test_port_assignment():
    with patch("foreman.drivers.gemini_bridge.GeminiBridge._check_http", return_value=False), \
         patch("foreman.drivers.gemini_bridge.GeminiBridge._verify_ide_running"):
        b = GeminiBridge(ide_name="antigravity")
        assert b._port == 19855
