"""
Foreman CLI — the interface between the /claude-foreman skill and the Python library.

The skill calls these commands directly.  Each command is one Phase of the
dispatch cycle, keeping token usage minimal (one tool call per phase).

Commands:
  foreman preflight     Phase 0 — verify IDE/branch/HEAD before dispatch
  foreman dispatch-task Phase 1 — open workspace, send prompt to IDE agent
  foreman wait          Phase 2 — block until new commit detected
  foreman verify        Phase 3 — diff + diagnostics summary
  foreman start         Start a new foreman session
  foreman resume        Resume a paused session
  foreman status        Show current session status
  foreman stop          Clear the current session
"""

import json
import subprocess
import sys
import time
from pathlib import Path

import click

from foreman.config import SupervisorConfig
from foreman.ring.loop import SupervisorLoop
from foreman.ring.state import SupervisorState


# ── Shared options ───────────────────────────────────────────────────────────

_state_file_opt = click.option(
    "--state-file", default="~/.claude/foreman-state.json",
    help="Path to the session state file.",
)
_worktree_opt = click.option(
    "--worktree", required=True,
    help="Absolute path to the target git worktree.",
)
_ide_opt = click.option(
    "--ide", default="windsurf",
    type=click.Choice(["windsurf", "antigravity", "cursor"]),
    help="Target IDE.",
)


# ── CLI group ────────────────────────────────────────────────────────────────

@click.group()
def cli():
    """Autonomous Foreman — Claude thinks, free models type."""
    pass


# ── Phase 0: Pre-flight ──────────────────────────────────────────────────────

@cli.command("preflight")
@_ide_opt
@_worktree_opt
@click.option("--branch", default=None, help="Expected branch name (optional).")
@_state_file_opt
def preflight(ide: str, worktree: str, branch: str, state_file: str):
    """Phase 0: verify IDE state before dispatch.

    Checks that the IDE is on the correct workspace/branch and records the
    current HEAD hash.  Prints a JSON result — the skill reads `head` and
    passes it to `foreman wait --pre-head`.

    Exit code 1 if not ready (issues found).

    \b
    Example:
        HEAD=$(foreman preflight --ide windsurf --worktree ~/CascadeProjects/dn-windsurf | python3 -c "import sys,json; print(json.load(sys.stdin)['head'])")
    """
    loop = SupervisorLoop.from_defaults()
    result = loop.pre_flight_check(worktree, ide=ide, expected_branch=branch)

    output = {
        "ready": result.ready,
        "head": result.head,
        "local_branch": result.local_branch,
        "bridge_branch": result.bridge_branch,
        "issues": result.issues,
    }
    click.echo(json.dumps(output, indent=2))

    if not result.ready:
        for issue in result.issues:
            click.echo(f"❌ {issue}", err=True)
        sys.exit(1)

    click.echo(f"✅ Pre-flight passed — HEAD {result.head[:7]} on {result.local_branch}", err=True)


# ── Phase 1: Dispatch ────────────────────────────────────────────────────────

@cli.command("dispatch-task")
@click.argument("task_file")
@_ide_opt
@_worktree_opt
@click.option("--new-window/--no-new-window", default=True,
              help="Open a fresh IDE window before dispatching.")
@_state_file_opt
def dispatch_task(task_file: str, ide: str, worktree: str, new_window: bool, state_file: str):
    """Phase 1: dispatch a task file to the IDE agent.

    TASK_FILE is the absolute path to a .tasks/*.md file.

    Opens a fresh workspace window (unless --no-new-window), then sends
    the subagent prompt via the bridge.  The task file is attached as context
    via --add-file (windsurf chat) so the agent can read every step.

    \b
    Example:
        foreman dispatch-task /path/to/.tasks/010-slug.md \\
            --ide windsurf --worktree ~/CascadeProjects/dn-windsurf
    """
    task_file = str(Path(task_file).expanduser().resolve())
    if not Path(task_file).exists():
        click.echo(f"❌ Task file not found: {task_file}", err=True)
        sys.exit(1)

    config = SupervisorConfig.default()
    loop = SupervisorLoop.from_defaults()

    # Open a clean workspace window (eliminates stale-tab failures)
    if new_window:
        from foreman.drivers.ide_driver import IDEDriver
        driver = IDEDriver(config)
        try:
            driver.open_workspace(ide, worktree)
            time.sleep(2)  # let IDE settle before dispatching
        except Exception as e:
            click.echo(f"⚠️  Could not open workspace: {e} — continuing anyway", err=True)

    # Get or create dispatch result
    dispatch = loop.dispatch_next(task_file=task_file)
    if not dispatch:
        click.echo("No pending tasks.", err=True)
        sys.exit(0)

    # Send to IDE via bridge
    from foreman.drivers.ide_driver import IDEDriver
    driver = IDEDriver(config)
    try:
        driver.send(
            ide,
            dispatch.windsurf_prompt,
            worktree=worktree,
            task_file=task_file,
        )
        click.echo(f"✅ Dispatched Task {dispatch.task.id} → {ide} ({dispatch.model})", err=True)
        click.echo(dispatch.message)  # Telegram notification on stdout
    except Exception as e:
        click.echo(f"❌ Dispatch failed: {e}", err=True)
        sys.exit(1)


# ── Phase 2: Wait ────────────────────────────────────────────────────────────

@cli.command("wait")
@_worktree_opt
@click.option("--pre-head", default=None,
              help="HEAD hash recorded before dispatch (from `foreman preflight`).")
@click.option("--timeout", default=600, show_default=True,
              help="Seconds to wait before giving up.")
@click.option("--interval", default=30, show_default=True,
              help="Poll interval in seconds.")
def wait(worktree: str, pre_head: str, timeout: int, interval: int):
    """Phase 2: block until the agent commits (one tool call).

    Polls git every INTERVAL seconds until HEAD moves past PRE_HEAD, a
    foreman-task commit is detected, or TIMEOUT is reached.

    Exits 0 on success, 1 on timeout.

    \b
    Example:
        foreman wait --worktree ~/CascadeProjects/dn-windsurf \\
            --pre-head abc1234 --timeout 600
    """
    worktree_path = Path(worktree).expanduser()
    deadline = time.time() + timeout
    loop = SupervisorLoop.from_defaults()

    watcher = loop.create_watcher(str(worktree_path), pre_dispatch_head=pre_head)

    while time.time() < deadline:
        result = watcher.check_once()
        if result.stable:
            signal = "HEAD changed" if result.head_changed else ("commit detected" if result.committed else "files stable")
            click.echo(f"✅ Done ({signal})")
            if result.diff_summary:
                click.echo(result.diff_summary)
            sys.exit(0)
        remaining = int(deadline - time.time())
        click.echo(
            f"⏳ {time.strftime('%H:%M:%S')} | "
            f"HEAD {'changed' if result.head_changed else 'unchanged'} | "
            f"files: {len(result.files)} | "
            f"timeout in {remaining}s",
            err=True,
        )
        time.sleep(interval)

    click.echo(f"⏰ Timeout after {timeout}s — no commit detected.", err=True)
    sys.exit(1)


# ── Phase 3: Verify ──────────────────────────────────────────────────────────

@cli.command("verify")
@_worktree_opt
@_state_file_opt
def verify(worktree: str, state_file: str):
    """Phase 3: diff summary + diagnostics after agent commits.

    Prints git diff --stat and any TypeScript/lint errors.  Claude reads this
    output to decide: clean, retry, takeover, or escalate.

    \b
    Example:
        foreman verify --worktree ~/CascadeProjects/dn-windsurf
    """
    loop = SupervisorLoop.from_defaults()
    ctx = loop.get_review_context(worktree)
    if not ctx:
        click.echo("No active task or no state file.", err=True)
        sys.exit(1)

    click.echo(f"## Task {ctx.task.id}/{ctx.total_tasks} — {ctx.task.complexity}\n")
    click.echo(f"### Files changed ({len(ctx.files_changed)})")
    for f in ctx.files_changed:
        click.echo(f"  {f}")

    click.echo(f"\n### Diff summary\n{ctx.diff_summary or '(no changes)'}")

    if ctx.errors:
        click.echo(f"\n### Errors ({len(ctx.errors)})")
        for e in ctx.errors:
            click.echo(f"  {e}")
    else:
        click.echo("\n### Errors: none ✅")

    if ctx.circle_type:
        click.echo(f"\n### ⚠️  Circle detected: {ctx.circle_type.value}")

    # Print truncated diff for Claude to review
    if ctx.full_diff:
        click.echo(f"\n### Full diff\n{ctx.full_diff}")


# ── Session management ───────────────────────────────────────────────────────

@cli.command()
@click.argument("goal")
@_state_file_opt
def start(goal: str, state_file: str):
    """Start a new foreman session with the given goal."""
    path = Path(state_file).expanduser()
    existing = SupervisorState.load(path)
    if existing and not existing.paused:
        click.echo(f"Foreman already active: {existing.goal}")
        click.echo("Use 'foreman resume' or 'foreman stop' first.")
        return
    state = SupervisorState.new(goal=goal)
    state.save(path)
    click.echo(f"Foreman started. Goal: {goal}")
    click.echo(f"State file: {path}")
    click.echo("Run DECOMPOSE to create task specs, then use `foreman dispatch-task`.")


@cli.command()
@_state_file_opt
def resume(state_file: str):
    """Resume a paused foreman session."""
    loop = SupervisorLoop.from_defaults()
    msg = loop.resume()
    if not msg:
        click.echo("No foreman session found.")
        return
    click.echo(msg)


@cli.command()
@_state_file_opt
def status(state_file: str):
    """Show current foreman status."""
    loop = SupervisorLoop.from_defaults()
    s = loop.get_status()
    if not s.get("active"):
        click.echo("No active foreman session.")
        return
    click.echo(f"Goal: {s['goal']}")
    click.echo(f"Progress: {s['progress']}")
    click.echo(f"Status: {'PAUSED — ' + (s.get('pause_reason') or '') if s['paused'] else 'ACTIVE'}")
    click.echo(f"Tokens: {s['tokens']:,}")
    if s.get("current_task"):
        t = s["current_task"]
        click.echo(f"Current: Task {t['id']} — {t['spec']} ({t['ide']}/{t['model']}, retries: {t['retries']})")


@cli.command()
@_state_file_opt
def stop(state_file: str):
    """Stop and clear the foreman session."""
    path = Path(state_file).expanduser()
    if path.exists():
        path.unlink()
        click.echo("Foreman session cleared.")
    else:
        click.echo("No session to clear.")


if __name__ == "__main__":
    cli()
