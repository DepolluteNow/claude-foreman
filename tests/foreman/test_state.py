import json
import pytest
from pathlib import Path
from foreman.ring.state import SupervisorState, TaskState, TaskStatus


def test_create_new_state():
    state = SupervisorState.new(goal="implement user auth")
    assert state.goal == "implement user auth"
    assert state.tasks == []
    assert state.paused is False


def test_add_task():
    state = SupervisorState.new(goal="test")
    state.add_task(spec="create login form", complexity="standard", ide="windsurf", model="kimi")
    assert len(state.tasks) == 1
    assert state.tasks[0].status == TaskStatus.PENDING
    assert state.tasks[0].ide == "windsurf"
    assert state.tasks[0].model == "kimi"


def test_current_task_returns_first_pending():
    state = SupervisorState.new(goal="test")
    state.add_task(spec="task1", complexity="trivial", ide="windsurf", model="swe1.5")
    state.add_task(spec="task2", complexity="standard", ide="windsurf", model="kimi")
    state.tasks[0].status = TaskStatus.COMPLETED
    current = state.current_task()
    assert current.spec == "task2"


def test_current_task_returns_none_when_all_done():
    state = SupervisorState.new(goal="test")
    state.add_task(spec="task1", complexity="trivial", ide="windsurf", model="swe1.5")
    state.tasks[0].status = TaskStatus.COMPLETED
    assert state.current_task() is None


def test_save_and_load(tmp_path):
    path = tmp_path / "state.json"
    state = SupervisorState.new(goal="implement auth")
    state.add_task(spec="login form", complexity="standard", ide="windsurf", model="kimi")
    state.tasks[0].status = TaskStatus.IN_PROGRESS
    state.tasks[0].retries = 1
    state.save(path)

    loaded = SupervisorState.load(path)
    assert loaded.goal == "implement auth"
    assert len(loaded.tasks) == 1
    assert loaded.tasks[0].status == TaskStatus.IN_PROGRESS
    assert loaded.tasks[0].retries == 1


def test_load_nonexistent_returns_none(tmp_path):
    path = tmp_path / "nope.json"
    assert SupervisorState.load(path) is None


def test_progress_summary():
    state = SupervisorState.new(goal="test")
    state.add_task(spec="t1", complexity="trivial", ide="windsurf", model="swe1.5")
    state.add_task(spec="t2", complexity="standard", ide="windsurf", model="kimi")
    state.add_task(spec="t3", complexity="complex", ide="antigravity", model="gemini-3.1")
    state.tasks[0].status = TaskStatus.COMPLETED
    state.tasks[0].result = "clean"
    state.tasks[1].status = TaskStatus.IN_PROGRESS

    summary = state.progress_summary()
    assert summary["completed"] == 1
    assert summary["in_progress"] == 1
    assert summary["pending"] == 1
    assert summary["total"] == 3
