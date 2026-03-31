import pytest
from click.testing import CliRunner
from foreman.cli import cli


@pytest.fixture
def runner():
    return CliRunner()


def test_status_no_state(runner, tmp_path):
    result = runner.invoke(cli, ["status", "--state-file", str(tmp_path / "nope.json")])
    assert "No active supervisor session" in result.output


def test_status_with_state(runner, tmp_path):
    from foreman.ring.state import SupervisorState, TaskStatus
    state = SupervisorState.new(goal="test goal")
    state.add_task(spec="task1", complexity="standard", ide="windsurf", model="kimi")
    state.tasks[0].status = TaskStatus.COMPLETED
    state.tasks[0].result = "clean"
    state.add_task(spec="task2", complexity="complex", ide="antigravity", model="gemini-3.1")
    path = tmp_path / "state.json"
    state.save(path)

    result = runner.invoke(cli, ["status", "--state-file", str(path)])
    assert "test goal" in result.output
    assert "1/2" in result.output or "completed" in result.output.lower()
