from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum
from typing import Optional


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


@dataclass
class PreFlightResult:
    """Result of a pre-dispatch IDE verification check (Phase 0)."""
    ready: bool                      # All checks passed — safe to dispatch
    head: str                        # Current HEAD hash (record before dispatch)
    local_branch: str                # Branch the worktree is on
    bridge_branch: str               # Branch the HTTP bridge reports (may differ)
    issues: list[str]                # Human-readable problems found


class AIBridgeError(Exception):
    """Raised when the bridge cannot communicate with the IDE's AI panel."""
    pass


class AIBridge(ABC):
    """Interface all AI bridges must implement."""

    @abstractmethod
    def send(
        self,
        prompt: str,
        worktree: Optional[str] = None,
        task_file: Optional[str] = None,
    ) -> None:
        """Send a prompt to the AI panel.

        Args:
            prompt:    The message to send.
            worktree:  Absolute path to the target workspace.  When provided,
                       implementations should prefer the IDE CLI (e.g.
                       ``windsurf chat``) over fragile AppleScript clipboard
                       injection.
            task_file: Absolute path to a task file to attach as context
                       (passed via ``--add-file`` to the IDE CLI).
        """
        ...

    @abstractmethod
    def pre_flight_check(
        self,
        worktree: str,
        expected_branch: Optional[str] = None,
    ) -> PreFlightResult:
        """Verify the IDE is on the correct workspace/branch before dispatch.

        Records the current HEAD hash so the caller can pass it to the
        watcher for reliable completion detection.
        """
        ...

    @abstractmethod
    def open_workspace(self, worktree: str) -> None:
        """Open the worktree in a fresh IDE window."""
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
