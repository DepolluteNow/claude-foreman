import click
from pathlib import Path
from foreman.config import SupervisorConfig
from foreman.ring.state import SupervisorState


@click.group()
def cli():
    """Autonomous Supervisor — route coding tasks to free AI models."""
    pass


@cli.command()
@click.argument("goal")
@click.option("--state-file", default="~/.claude/supervisor-state.json")
def start(goal: str, state_file: str):
    """Start a new supervisor session with the given goal."""
    path = Path(state_file).expanduser()
    existing = SupervisorState.load(path)
    if existing and not existing.paused:
        click.echo(f"Supervisor already active: {existing.goal}")
        click.echo("Use 'supervisor resume' or 'supervisor stop' first.")
        return

    state = SupervisorState.new(goal=goal)
    state.save(path)
    click.echo(f"Supervisor started. Goal: {goal}")
    click.echo(f"State file: {path}")
    click.echo("Run DECOMPOSE to create task specs.")


@cli.command()
@click.option("--state-file", default="~/.claude/supervisor-state.json")
def resume(state_file: str):
    """Resume a paused supervisor session."""
    path = Path(state_file).expanduser()
    state = SupervisorState.load(path)
    if not state:
        click.echo("No supervisor session found.")
        return
    state.paused = False
    state.pause_reason = None
    state.save(path)
    current = state.current_task()
    if current:
        click.echo(f"Resumed. Next task: {current.id} — {current.spec[:60]}")
    else:
        click.echo("Resumed. All tasks completed.")


@cli.command()
@click.option("--state-file", default="~/.claude/supervisor-state.json")
def status(state_file: str):
    """Show current supervisor status."""
    path = Path(state_file).expanduser()
    state = SupervisorState.load(path)
    if not state:
        click.echo("No active supervisor session.")
        return

    summary = state.progress_summary()
    click.echo(f"Goal: {state.goal}")
    click.echo(f"Progress: {summary['completed']}/{summary['total']} tasks")
    click.echo(f"Status: {'PAUSED — ' + (state.pause_reason or '') if state.paused else 'ACTIVE'}")
    click.echo(f"Tokens: {state.total_claude_tokens:,}")

    current = state.current_task()
    if current:
        click.echo(f"Current: Task {current.id} — {current.spec[:60]} ({current.ide}/{current.model})")


@cli.command()
@click.option("--state-file", default="~/.claude/supervisor-state.json")
def stop(state_file: str):
    """Stop and clear the supervisor session."""
    path = Path(state_file).expanduser()
    if path.exists():
        path.unlink()
        click.echo("Supervisor session cleared.")
    else:
        click.echo("No session to clear.")


if __name__ == "__main__":
    cli()
