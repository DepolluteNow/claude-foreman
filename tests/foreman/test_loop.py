"""Tests for the foreman loop orchestrator — mechanical parts only."""

import json
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

from foreman.ring.loop import SupervisorLoop, ReviewContext, DispatchResult
from foreman.ring.state import SupervisorState, TaskStatus
from foreman.ring.takeover import CircleType
from foreman.config import SupervisorConfig


@pytest.fixture
def loop(tmp_path):
    """Create a loop with temp paths for state and learnings."""
    config = SupervisorConfig.default()
    return SupervisorLoop(
        config=config,
        state_path=tmp_path / "state.json",
        learnings_path=tmp_path / "learnings.json",
    )


@pytest.fixture
def initialized_loop(loop):
    """Loop with 3 tasks initialized."""
    loop.initialize("implement user auth", [
        "Rename getUserData to fetchUserData in src/utils/api.ts",
        "Create component LoginForm at src/components/LoginForm.tsx",
        "Refactor auth middleware across src/a.ts, src/b.ts, and src/c.ts",
    ])
    return loop


# ── INITIALIZE ──────────────────────────────────────────────────

def test_initialize_creates_state(loop, tmp_path):
    result = loop.initialize("test goal", ["task A", "task B"])
    assert "2 tasks" in result
    assert loop.state is not None
    assert loop.state.goal == "test goal"
    assert len(loop.state.tasks) == 2


def test_initialize_routes_tasks(initialized_loop):
    tasks = initialized_loop.state.tasks
    # "Rename" → trivial → swe1.5
    assert tasks[0].complexity == "trivial"
    assert tasks[0].model == "swe1.5"
    # "Create component" → standard → kimi
    assert tasks[1].complexity == "standard"
    assert tasks[1].model == "kimi"
    # "Refactor...3 files" → complex → gemini-3.1
    assert tasks[2].complexity == "complex"
    assert tasks[2].model == "gemini-3.1"


def test_initialize_saves_state(loop, tmp_path):
    loop.initialize("save test", ["one task"])
    state_file = tmp_path / "state.json"
    assert state_file.exists()
    data = json.loads(state_file.read_text())
    assert data["goal"] == "save test"


def test_initialize_uses_adaptive_routing(loop, tmp_path):
    # Pre-seed learnings with performance data that overrides defaults
    learnings = {
        "version": 1,
        "first_try_rate_history": [],
        "patterns": {"always": [], "never": []},
        "model_performance": {
            "gemini-3.1": {"standard": 0.95},
            "kimi": {"standard": 0.40},
        },
        "templates": {},
        "regressions_reverted": [],
    }
    learnings_path = tmp_path / "learnings.json"
    learnings_path.write_text(json.dumps(learnings))

    loop.initialize("adaptive test", [
        "Create component LoginForm at src/components/LoginForm.tsx",
    ])
    # Should route to gemini-3.1 instead of default kimi
    assert loop.state.tasks[0].model == "gemini-3.1"


# ── DISPATCH ────────────────────────────────────────────────────

def test_dispatch_returns_first_task(initialized_loop):
    result = initialized_loop.dispatch_next()
    assert result is not None
    assert result.task.id == 1
    assert result.ide == "windsurf"
    assert result.model == "swe1.5"
    assert "dn-windsurf" in result.worktree


def test_dispatch_marks_in_progress(initialized_loop):
    initialized_loop.dispatch_next()
    assert initialized_loop.state.tasks[0].status == TaskStatus.IN_PROGRESS


def test_dispatch_returns_none_when_all_done(initialized_loop):
    for task in initialized_loop.state.tasks:
        task.status = TaskStatus.COMPLETED
    result = initialized_loop.dispatch_next()
    assert result is None


# ── MARK RESULTS ────────────────────────────────────────────────

def test_mark_clean(initialized_loop):
    initialized_loop.dispatch_next()
    msg = initialized_loop.mark_clean()
    assert "🏆" in msg or "KO" in msg
    assert initialized_loop.state.tasks[0].status == TaskStatus.COMPLETED
    assert initialized_loop.state.tasks[0].result == "clean"


def test_mark_minor_fix_increments_retries(initialized_loop):
    initialized_loop.dispatch_next()
    msg = initialized_loop.mark_minor_fix()
    assert "correction" in msg.lower() or "retry" in msg.lower()
    assert initialized_loop.state.tasks[0].retries == 1


def test_mark_minor_fix_escalates_after_max_retries(initialized_loop):
    initialized_loop.dispatch_next()
    task = initialized_loop.state.tasks[0]
    task.retries = initialized_loop.config.max_retries  # already at max
    msg = initialized_loop.mark_minor_fix()
    assert "exceeded" in msg.lower() or "escalat" in msg.lower()
    assert task.status == TaskStatus.FAILED


def test_mark_takeover(initialized_loop):
    initialized_loop.dispatch_next()
    msg = initialized_loop.mark_takeover(lines_changed=12)
    assert "12 lines" in msg
    assert "🔔" in msg or "Corner steps in" in msg
    assert initialized_loop.state.tasks[0].result == "takeover"


def test_mark_skipped(initialized_loop):
    initialized_loop.dispatch_next()
    msg = initialized_loop.mark_skipped()
    assert "skipped" in msg.lower()
    assert initialized_loop.state.tasks[0].status == TaskStatus.SKIPPED


# ── COMPLETION ──────────────────────────────────────────────────

def test_is_complete_false_when_pending(initialized_loop):
    assert initialized_loop.is_complete() is False


def test_is_complete_true_when_all_done(initialized_loop):
    for task in initialized_loop.state.tasks:
        task.status = TaskStatus.COMPLETED
    assert initialized_loop.is_complete() is True


def test_complete_updates_learnings(initialized_loop, tmp_path):
    for task in initialized_loop.state.tasks:
        task.status = TaskStatus.COMPLETED
        task.result = "clean"
    msg = initialized_loop.complete()
    assert "�" in msg or "FIGHT OVER" in msg
    # Learnings file should exist
    learnings_path = tmp_path / "learnings.json"
    assert learnings_path.exists()


# ── STATUS ──────────────────────────────────────────────────────

def test_get_status_active(initialized_loop):
    status = initialized_loop.get_status()
    assert status["active"] is True
    assert status["goal"] == "implement user auth"
    assert status["progress"] == "0/3"


def test_get_status_inactive(loop):
    status = loop.get_status()
    assert status["active"] is False


# ── LEARNINGS CONTEXT ───────────────────────────────────────────

def test_get_learnings_first_run(loop):
    ctx = loop.get_learnings_context()
    assert "No learnings yet" in ctx


def test_get_learnings_with_data(loop, tmp_path):
    learnings = {
        "version": 2,
        "first_try_rate_history": [0.7, 0.8],
        "patterns": {
            "always": ["specify exact file paths"],
            "never": ["say 'fix the bug' without error message"],
        },
        "model_performance": {"kimi": {"standard": 0.85}},
        "templates": {},
        "regressions_reverted": [],
    }
    (tmp_path / "learnings.json").write_text(json.dumps(learnings))
    ctx = loop.get_learnings_context()
    assert "specify exact file paths" in ctx
    assert "fix the bug" in ctx
    assert "kimi" in ctx
    assert "70%" in ctx or "80%" in ctx


# ── RESUME ──────────────────────────────────────────────────────

def test_resume_from_saved_state(loop, tmp_path):
    # Create and save a state
    state = SupervisorState.new(goal="resume test")
    state.add_task(spec="t1", complexity="standard", ide="windsurf", model="kimi")
    state.tasks[0].status = TaskStatus.COMPLETED
    state.add_task(spec="t2", complexity="complex", ide="antigravity", model="gemini-3.1")
    state.save(tmp_path / "state.json")

    msg = loop.resume()
    assert msg is not None
    assert "resume test" in msg
    assert "Task 2" in msg


def test_resume_no_state(loop):
    msg = loop.resume()
    assert msg is None


# ── DISPATCH + MARK CYCLE ───────────────────────────────────────

def test_full_dispatch_mark_cycle(initialized_loop):
    """Simulate a complete task lifecycle."""
    # Dispatch task 1
    d1 = initialized_loop.dispatch_next()
    assert d1.task.id == 1

    # Mark clean
    initialized_loop.mark_clean()

    # Dispatch task 2
    d2 = initialized_loop.dispatch_next()
    assert d2.task.id == 2

    # Mark with minor fix, then clean
    initialized_loop.mark_minor_fix()
    # Task stays in_progress for retry — dispatch_next returns same task
    d2_retry = initialized_loop.dispatch_next()
    assert d2_retry.task.id == 2

    initialized_loop.mark_clean()

    # Dispatch task 3
    d3 = initialized_loop.dispatch_next()
    assert d3.task.id == 3

    initialized_loop.mark_clean()

    # All done
    assert initialized_loop.is_complete()
