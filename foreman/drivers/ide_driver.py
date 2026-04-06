import importlib
from typing import Optional

from foreman.bridge_interface import AIBridge, AIBridgeError, AIStatus, PreFlightResult
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
            try:
                self._bridges[ide_name] = bridge_cls(ide_name=ide_name)
            except TypeError:
                self._bridges[ide_name] = bridge_cls()
        return self._bridges[ide_name]

    def send(
        self,
        ide: str,
        prompt: str,
        worktree: Optional[str] = None,
        task_file: Optional[str] = None,
    ) -> None:
        self.get_bridge(ide).send(prompt, worktree=worktree, task_file=task_file)

    def pre_flight_check(
        self,
        ide: str,
        worktree: str,
        expected_branch: Optional[str] = None,
    ) -> PreFlightResult:
        return self.get_bridge(ide).pre_flight_check(worktree, expected_branch)

    def open_workspace(self, ide: str, worktree: str) -> None:
        self.get_bridge(ide).open_workspace(worktree)

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
