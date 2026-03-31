from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum


class AIStatus(Enum):
    IDLE = "idle"
    GENERATING = "generating"
    WAITING_INPUT = "waiting_input"
    ERROR = "error"


@dataclass
class AIResponse:
    text: str
    status: AIStatus
    files_changed: list[str]


class AIBridgeError(Exception):
    """Raised when the bridge cannot communicate with the IDE's AI panel."""
    pass


class AIBridge(ABC):
    """Interface all AI bridges must implement."""

    @abstractmethod
    def send(self, prompt: str) -> None:
        """Send a prompt to the AI panel."""
        ...

    @abstractmethod
    def status(self) -> AIStatus:
        """Check if the AI is generating, idle, or waiting for input."""
        ...

    @abstractmethod
    def read_output(self, lines: int = 50) -> str:
        """Read the last N lines of the AI panel's response."""
        ...

    @abstractmethod
    def accept_all(self) -> None:
        """Accept all proposed code changes."""
        ...

    @abstractmethod
    def reject(self) -> None:
        """Reject proposed code changes."""
        ...

    @abstractmethod
    def recalibrate(self) -> None:
        """Re-scan accessibility tree after IDE update."""
        ...
