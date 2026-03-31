import pytest
import subprocess
from pathlib import Path
from unittest.mock import patch, MagicMock
from foreman.ring.watcher import FilesystemWatcher, WatchResult


@pytest.fixture
def watcher(tmp_path):
    return FilesystemWatcher(worktree=tmp_path, poll_interval=1, stability_polls=2)


def test_no_changes_detected(watcher, tmp_path):
    subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True)
    subprocess.run(["git", "commit", "--allow-empty", "-m", "init"], cwd=tmp_path, capture_output=True)
    result = watcher.check_once()
    assert result.changed is False
    assert result.files == []


def test_changes_detected(watcher, tmp_path):
    subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True)
    subprocess.run(["git", "commit", "--allow-empty", "-m", "init"], cwd=tmp_path, capture_output=True)
    (tmp_path / "new_file.ts").write_text("console.log('hello')")
    result = watcher.check_once()
    assert result.changed is True
    assert "new_file.ts" in result.files


def test_diff_summary(watcher, tmp_path):
    subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True)
    (tmp_path / "file.ts").write_text("line1")
    subprocess.run(["git", "add", "."], cwd=tmp_path, capture_output=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=tmp_path, capture_output=True)
    (tmp_path / "file.ts").write_text("line1\nline2\nline3")
    result = watcher.check_once()
    assert result.changed is True
    assert result.diff_summary != ""


def test_stability_requires_consecutive_same_state(watcher, tmp_path):
    subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True)
    subprocess.run(["git", "commit", "--allow-empty", "-m", "init"], cwd=tmp_path, capture_output=True)
    (tmp_path / "file.ts").write_text("v1")

    # First check: changed
    r1 = watcher.check_once()
    assert r1.changed is True
    assert r1.stable is False

    # Second check without further changes: stable
    r2 = watcher.check_once()
    assert r2.changed is True
    assert r2.stable is True
