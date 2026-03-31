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


class FilesystemWatcher:
    def __init__(self, worktree: Path, poll_interval: int = 15, stability_polls: int = 2):
        self.worktree = Path(worktree)
        self.poll_interval = poll_interval
        self.stability_polls = stability_polls
        self._previous_files: Optional[list[str]] = None
        self._stable_count: int = 0

    def check_once(self) -> WatchResult:
        files = self._get_changed_files()
        diff_summary = self._get_diff_summary() if files else ""

        changed = len(files) > 0

        # Stability: same set of changed files as last check
        if files == self._previous_files and changed:
            self._stable_count += 1
        else:
            self._stable_count = 0 if not changed else 1

        self._previous_files = files
        stable = self._stable_count >= self.stability_polls

        return WatchResult(
            changed=changed,
            stable=stable,
            files=files,
            diff_summary=diff_summary,
        )

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
