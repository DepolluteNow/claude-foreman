import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class WatchResult:
    changed: bool    # Uncommitted changes exist in the worktree
    stable: bool     # Task is done (head_changed, committed, or file-stable)
    files: list[str]
    diff_summary: str
    head_changed: bool = False  # HEAD moved past pre_dispatch_head (primary signal)
    committed: bool = False     # foreman-task-{id}: commit detected (secondary signal)


class FilesystemWatcher:
    """Polls a git worktree for task completion.

    Completion is detected in priority order:
    1. ``head_changed`` — HEAD moved past the pre-dispatch hash recorded in
       Phase 0.  Most reliable: any new commit (from any agent) is sufficient.
    2. ``committed`` — A commit whose message starts with
       ``foreman-task-{task_id}:`` exists.  Confirms the *right* task finished.
    3. File stability — the same set of modified files appears on two
       consecutive polls.  Fallback for agents that don't commit on completion.
    """

    def __init__(
        self,
        worktree: Path,
        poll_interval: int = 15,
        stability_polls: int = 2,
        task_id: Optional[int] = None,
        pre_dispatch_head: Optional[str] = None,
    ):
        self.worktree = Path(worktree)
        self.poll_interval = poll_interval
        self.stability_polls = stability_polls
        self._task_id = task_id
        self._pre_dispatch_head = pre_dispatch_head
        self._previous_files: Optional[list[str]] = None
        self._stable_count: int = 0

    def check_once(self) -> WatchResult:
        # Primary signal: HEAD moved (any new commit = done)
        head_changed = self._check_head_changed() if self._pre_dispatch_head else False
        # Secondary signal: correct foreman-task commit present
        committed = self._check_committed() if self._task_id else False

        files = self._get_changed_files()
        diff_summary = self._get_diff_summary() if files else ""
        changed = len(files) > 0

        # File-stability fallback
        if files == self._previous_files and changed:
            self._stable_count += 1
        else:
            self._stable_count = 0 if not changed else 1
        self._previous_files = files

        stable = head_changed or committed or self._stable_count >= self.stability_polls

        return WatchResult(
            changed=changed,
            stable=stable,
            files=files,
            diff_summary=diff_summary,
            head_changed=head_changed,
            committed=committed,
        )

    def _check_head_changed(self) -> bool:
        """Return True if HEAD has moved past the pre-dispatch snapshot."""
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.worktree,
            capture_output=True,
            text=True,
        )
        current = result.stdout.strip()
        return bool(current) and current != self._pre_dispatch_head

    def _check_committed(self) -> bool:
        """Return True if a foreman-task-{id}: commit exists."""
        result = subprocess.run(
            ["git", "log", "--oneline", "-20",
             f"--grep=foreman-task-{self._task_id}:"],
            cwd=self.worktree,
            capture_output=True,
            text=True,
        )
        return bool(result.stdout.strip())

    def _get_changed_files(self) -> list[str]:
        result = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=self.worktree,
            capture_output=True,
            text=True,
        )
        tracked = [f.strip() for f in result.stdout.strip().split("\n") if f.strip()]

        result_untracked = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard"],
            cwd=self.worktree,
            capture_output=True,
            text=True,
        )
        untracked = [f.strip() for f in result_untracked.stdout.strip().split("\n") if f.strip()]

        return sorted(set(tracked + untracked))

    def _get_diff_summary(self) -> str:
        result = subprocess.run(
            ["git", "diff", "--stat", "HEAD"],
            cwd=self.worktree,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()

    def reset(self) -> None:
        self._previous_files = None
        self._stable_count = 0
