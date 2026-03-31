import pytest
from unittest.mock import patch, MagicMock
from foreman.drivers.cascade_bridge import CascadeBridge
from foreman.bridge_interface import AIStatus, AIBridgeError


@pytest.fixture
def bridge():
    """Create a CascadeBridge with mocked detection."""
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._check_http") as mock_http, \
         patch("foreman.drivers.cascade_bridge.CascadeBridge._verify_ide_running"):
        mock_http.return_value = False
        return CascadeBridge(ide_name="windsurf")


@pytest.fixture
def bridge_with_http():
    """Create a CascadeBridge with HTTP bridge available."""
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._check_http") as mock_http, \
         patch("foreman.drivers.cascade_bridge.CascadeBridge._verify_ide_running"):
        mock_http.return_value = True
        b = CascadeBridge(ide_name="windsurf")
        b._http_available = True
        return b


def test_send_calls_applescript(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(returncode=0)
        bridge.send("write a login form")
        assert mock.called


def test_status_returns_idle_without_http(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(stdout="idle\n", returncode=0)
        assert bridge.status() == AIStatus.IDLE


def test_status_via_http(bridge_with_http):
    with patch.object(bridge_with_http, "_http_get") as mock:
        mock.return_value = {"lastFileChangeTime": 0}
        assert bridge_with_http.status() == AIStatus.IDLE


def test_read_output_via_http(bridge_with_http):
    with patch.object(bridge_with_http, "_http_get") as mock:
        mock.return_value = {"lines": ["line1", "line2", "login form created"], "total": 3}
        result = bridge_with_http.read_output(lines=10)
        assert "login form" in result


def test_read_output_without_http(bridge):
    result = bridge.read_output()
    assert "bridge not available" in result


def test_read_diagnostics_via_http(bridge_with_http):
    with patch.object(bridge_with_http, "_http_get") as mock:
        mock.return_value = {"errors": [{"file": "a.ts", "message": "err"}], "warnings": [], "total": 1}
        diags = bridge_with_http.read_diagnostics()
        assert diags["total"] == 1


def test_accept_all(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(returncode=0)
        bridge.accept_all()
        assert mock.called


def test_reject(bridge):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(returncode=0)
        bridge.reject()
        assert mock.called


def test_recalibrate_rechecks_http(bridge):
    with patch.object(bridge, "_check_http", return_value=True):
        bridge.recalibrate()
        assert bridge._http_available is True


def test_bridge_error_on_missing_process():
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._check_http", return_value=False), \
         patch("subprocess.run") as mock:
        mock.return_value = MagicMock(stdout="none\n", returncode=0)
        with pytest.raises(AIBridgeError):
            CascadeBridge(ide_name="windsurf")


def test_port_assignment():
    with patch("foreman.drivers.cascade_bridge.CascadeBridge._check_http", return_value=False), \
         patch("foreman.drivers.cascade_bridge.CascadeBridge._verify_ide_running"):
        b = CascadeBridge(ide_name="windsurf")
        assert b._port == 19854
