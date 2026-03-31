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
