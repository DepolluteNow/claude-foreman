from foreman.bridge_interface import AIBridge, AIBridgeError, AIStatus
from foreman.drivers.cascade_bridge import CascadeBridge
from foreman.drivers.gemini_bridge import GeminiBridge
from foreman.config import SupervisorConfig


BRIDGE_REGISTRY = {
    "cascade": CascadeBridge,
    "gemini": GeminiBridge,
}


class IDEDriver:
    """Unified driver that routes commands to the correct IDE bridge."""

    def __init__(self, config: SupervisorConfig):
        self.config = config
        self._bridges: dict[str, AIBridge] = {}

    def get_bridge(self, ide_name: str) -> AIBridge:
        if ide_name not in self._bridges:
            ide_config = self.config.ides.get(ide_name)
            if not ide_config:
                raise AIBridgeError(f"Unknown IDE: {ide_name}")
            bridge_cls = BRIDGE_REGISTRY.get(ide_config.bridge_type)
            if not bridge_cls:
                raise AIBridgeError(f"Unknown bridge type: {ide_config.bridge_type}")
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
