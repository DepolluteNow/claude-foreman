import pytest
from foreman.ring.learnings import Learnings
from foreman.ring.state import SupervisorState, TaskStatus


@pytest.fixture
def empty_learnings(tmp_path):
    path = tmp_path / "learnings.json"
    return Learnings(path)


@pytest.fixture
def completed_state():
    state = SupervisorState.new(goal="test project")
    state.add_task(spec="rename var in src/a.ts", complexity="trivial", ide="windsurf", model="swe1.5")
    state.tasks[0].status = TaskStatus.COMPLETED
    state.tasks[0].result = "clean"
    state.tasks[0].retries = 0

    state.add_task(spec="create component", complexity="standard", ide="windsurf", model="kimi")
    state.tasks[1].status = TaskStatus.COMPLETED
    state.tasks[1].result = "clean"
    state.tasks[1].retries = 0

    state.add_task(spec="refactor auth across 3 files", complexity="complex", ide="antigravity", model="gemini-3.1")
    state.tasks[2].status = TaskStatus.COMPLETED
    state.tasks[2].result = "minor_fix"
    state.tasks[2].retries = 2

    return state


def test_new_learnings_has_version_1(empty_learnings):
    data = empty_learnings.load()
    assert data["version"] == 1
    assert data["first_try_rate_history"] == []


def test_record_retrospective(empty_learnings, completed_state):
    empty_learnings.record_retrospective(completed_state)
    data = empty_learnings.load()
    assert len(data["first_try_rate_history"]) == 1
    assert data["first_try_rate_history"][0] == pytest.approx(2 / 3, rel=0.01)


def test_model_performance_updated(empty_learnings, completed_state):
    empty_learnings.record_retrospective(completed_state)
    data = empty_learnings.load()
    perf = data["model_performance"]
    assert perf["swe1.5"]["trivial"] == 1.0
    assert perf["kimi"]["standard"] == 1.0
    assert perf["gemini-3.1"]["complex"] == 0.0  # needed retries


def test_regression_guard_reverts(empty_learnings, completed_state):
    # First run: good rate
    empty_learnings.record_retrospective(completed_state)

    # Second run: worse rate (all tasks needed retries)
    bad_state = SupervisorState.new(goal="bad project")
    bad_state.add_task(spec="t1", complexity="standard", ide="windsurf", model="kimi")
    bad_state.tasks[0].status = TaskStatus.COMPLETED
    bad_state.tasks[0].result = "minor_fix"
    bad_state.tasks[0].retries = 2
    empty_learnings.record_retrospective(bad_state)

    data = empty_learnings.load()
    # Regression detected — rate dropped, so reverted patterns
    assert len(data.get("regressions_reverted", [])) >= 1


def test_save_and_reload(empty_learnings, completed_state, tmp_path):
    empty_learnings.record_retrospective(completed_state)
    reloaded = Learnings(tmp_path / "learnings.json")
    data = reloaded.load()
    assert data["version"] >= 1
    assert len(data["first_try_rate_history"]) == 1
