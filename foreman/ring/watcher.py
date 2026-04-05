import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class WatchResult:
    changed: bool
    stable: bool
    files: list[str]
    diff_summary: str
    committed: bool = False  # True when the expected foreman-task-{id} commit is detected


class FilesystemWatcher:
    def __init__(
        self,
        worktree: Path,
        poll_interval: int = 15,
        stability_polls: int = 2,
        task_id: Optional[int] = None,
    ):
        self.worktree = Path(worktree)
        self.poll_interval = poll_interval
        self.stability_polls = stability_polls
        self._task_id = task_id
        self._previous_files: Optional[list[str]] = None
        self._stable_count: int = 0

    def check_once(self) -> WatchResult:
        # Check for deterministic commit first — fastest path to done
        committed = self._check_committed() if self._task_id else False

        files = self._get_changed_files()
        diff_summary = self._get_diff_summary() if files else ""

        changed = len(files) > 0

        # Stability: same set of changed files as last check (fallback when no commit yet)
        if files == self._previous_files and changed:
            self._stable_count += 1
        else:
            self._stable_count = 0 if not changed else 1

        self._previous_files = files
        # Committed is the primary signal; file stability is the fallback
        stable = committed or self._stable_count >= self.stability_polls

        return WatchResult(
            changed=changed,
            stable=stable,
            files=files,
            diff_summary=diff_summary,
            committed=committed,
        )

    def _check_committed(self) -> bool:
        """Return True if a commit with the foreman-task-{id} prefix exists."""
        result = subprocess.run(
            ["git", "log", "--oneline", "-20", f"--grep=foreman-task-{self._task_id}:"],
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
