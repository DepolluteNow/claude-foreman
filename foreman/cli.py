"""
Foreman CLI — the interface between the /claude-foreman skill and the Python library.

The skill calls these commands directly.  Each command is one Phase of the
dispatch cycle, keeping token usage minimal (one tool call per phase).

Commands:
  foreman preflight          Phase 0 — verify IDE/branch/HEAD before dispatch
  foreman dispatch-task      Phase 1 — open workspace, send task file to IDE agent
  foreman dispatch-issue     Phase 1 — fetch GitHub issue, branch, dispatch
  foreman create-and-dispatch Create a new GitHub issue then dispatch it immediately
  foreman wait               Phase 2 — block until commit detected; optional auto-PR
  foreman verify             Phase 3 — diff + diagnostics + closing-ref + test runner
  foreman queue              Run multiple issues sequentially end-to-end
  foreman start/resume/status/stop  — session management
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
    from foreman.github import worktree_is_dirty
    loop = SupervisorLoop.from_defaults()
    result = loop.pre_flight_check(worktree, ide=ide, expected_branch=branch)

    # Dirty worktree guard — uncommitted changes from a previous dispatch
    # would be mixed into the new task, causing silent correctness bugs.
    dirty = worktree_is_dirty(worktree)
    if dirty:
        result.issues.append(
            f"Worktree has {len(dirty)} uncommitted change(s) — clean up before dispatching:\n"
            + "\n".join(f"  {line}" for line in dirty[:10])
        )
        result.ready = False

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


# ── Issue dispatch ───────────────────────────────────────────────────────────

@cli.command("dispatch-issue")
@click.argument("issue_ref")
@_ide_opt
@_worktree_opt
@click.option("--branch", default=None,
              help="Branch name (default: feat/issue-{N}-{slug}).")
@click.option("--new-window/--no-new-window", default=True,
              help="Open a fresh IDE window before dispatching.")
@click.option("--per-worktree/--shared-worktree", default=False,
              help="Create a dedicated worktree for this issue at <base_parent>/dn-issue-{N}.")
@click.option("--comment/--no-comment", default=True,
              help="Post a dispatch comment on the GitHub issue.")
def dispatch_issue(
    issue_ref: str, ide: str, worktree: str, branch: str,
    new_window: bool, per_worktree: bool, comment: bool,
):
    """Dispatch a GitHub issue to the IDE agent.

    ISSUE_REF: owner/repo#123  (or a full GitHub issue URL)

    Fetches the issue, creates/checks out the branch, runs pre-flight,
    optionally posts a GitHub comment, then dispatches via the bridge.

    Prints a JSON result on stdout — pipe through python3 to extract fields:

    \b
    Example (issue dispatch + wait in two calls):
        OUT=$(foreman dispatch-issue owner/repo#42 --ide windsurf \\
                  --worktree ~/CascadeProjects/dn-windsurf)
        PRE_HEAD=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['head'])")
        WORKTREE=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['worktree'])")
        foreman wait --worktree "$WORKTREE" --pre-head "$PRE_HEAD" \\
            --issue owner/repo#42 --auto-pr
    """
    from foreman.github import (parse_issue_ref as _parse, fetch_issue, ensure_branch,
                                ensure_issue_worktree, format_issue_prompt,
                                post_issue_comment, worktree_is_dirty)
    from foreman.drivers.ide_driver import IDEDriver

    # ── Fetch issue ─────────────────────────────────────────────────
    try:
        repo, number = _parse(issue_ref)
    except ValueError as e:
        click.echo(f"❌ {e}", err=True)
        sys.exit(1)

    click.echo(f"Fetching {repo}#{number}...", err=True)
    try:
        issue = fetch_issue(repo, number)
    except RuntimeError as e:
        click.echo(f"❌ {e}", err=True)
        sys.exit(1)

    click.echo(f"  #{issue.number}: {issue.title}", err=True)

    # ── Worktree setup ───────────────────────────────────────────────
    if per_worktree:
        from foreman.github import branch_name as _bn
        used_branch = branch or _bn(issue)
        try:
            worktree = ensure_issue_worktree(issue, worktree, used_branch)
        except RuntimeError as e:
            click.echo(f"❌ {e}", err=True)
        sys.exit(1)
        click.echo(f"  Worktree: {worktree}", err=True)
    else:
        used_branch = branch or ""

    # ── Branch setup ────────────────────────────────────────────────
    try:
        used_branch = ensure_branch(worktree, issue, custom_branch=used_branch)
    except RuntimeError as e:
        click.echo(f"❌ {e}", err=True)
        sys.exit(1)

    click.echo(f"  Branch: {used_branch}", err=True)

    # ── Dirty worktree guard ─────────────────────────────────────────
    dirty = worktree_is_dirty(worktree)
    if dirty:
        click.echo(f"❌ Worktree has {len(dirty)} uncommitted change(s) — clean up first:", err=True)
        for line in dirty[:10]:
            click.echo(f"   {line}", err=True)
        sys.exit(1)

    # ── Pre-flight ──────────────────────────────────────────────────
    loop = SupervisorLoop.from_defaults()
    pf = loop.pre_flight_check(worktree, ide=ide, expected_branch=used_branch)
    if not pf.ready:
        for msg in pf.issues:
            click.echo(f"❌ {msg}", err=True)
        sys.exit(1)
    click.echo(f"  Pre-flight: HEAD {pf.head[:7]} on {pf.local_branch} ✅", err=True)

    # ── GitHub comment: dispatch notice ─────────────────────────────
    if comment:
        try:
            post_issue_comment(repo, number,
                f"🤖 **Dispatched to {ide}** on branch `{used_branch}` "
                f"at {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}.\n\n"
                f"Working autonomously — will post a PR link when done.")
        except Exception as e:
            click.echo(f"⚠️  Could not post dispatch comment: {e}", err=True)

    # ── Open workspace ──────────────────────────────────────────────
    config = SupervisorConfig.default()
    driver = IDEDriver(config)
    if new_window:
        try:
            driver.open_workspace(ide, worktree)
            time.sleep(2)
        except Exception as e:
            click.echo(f"⚠️  open_workspace: {e} — continuing anyway", err=True)

    # ── Dispatch ────────────────────────────────────────────────────
    prompt = format_issue_prompt(issue, worktree, used_branch)
    try:
        driver.send(ide, prompt, worktree=worktree)
    except Exception as e:
        click.echo(f"❌ Dispatch failed: {e}", err=True)
        sys.exit(1)

    click.echo(f"  Dispatched #{issue.number} → {ide} ✅", err=True)

    # JSON on stdout — caller extracts head + worktree for wait/verify
    click.echo(json.dumps({
        "head": pf.head,
        "worktree": worktree,
        "branch": used_branch,
        "repo": repo,
        "number": number,
        "title": issue.title,
    }))


# ── Phase 2: Wait ────────────────────────────────────────────────────────────

@cli.command("wait")
@_worktree_opt
@click.option("--pre-head", default=None,
              help="HEAD hash before dispatch (from dispatch-issue JSON output).")
@click.option("--timeout", default=600, show_default=True,
              help="Seconds before giving up.")
@click.option("--interval", default=30, show_default=True,
              help="Poll interval in seconds.")
@click.option("--issue", default=None,
              help="Issue ref (owner/repo#N) — enables auto-PR and completion comment.")
@click.option("--auto-pr/--no-auto-pr", default=False,
              help="Create a PR automatically on success (requires --issue).")
@click.option("--comment/--no-comment", default=True,
              help="Post a completion comment on the GitHub issue.")
@click.option("--port", default=19854, show_default=True,
              help="foreman-bridge HTTP port (for timeout diagnosis).")
def wait(worktree: str, pre_head: str, timeout: int, interval: int,
         issue: str, auto_pr: bool, comment: bool, port: int):
    """Phase 2: block until agent commits.  Optional auto-PR on completion.

    On timeout: takes a screenshot and queries the bridge health endpoint
    to diagnose whether the agent is still running or stuck.

    \b
    Example:
        foreman wait --worktree ~/CascadeProjects/dn-windsurf \\
            --pre-head abc1234 --issue owner/repo#42 --auto-pr
    """
    import urllib.request
    import urllib.error

    worktree_path = Path(worktree).expanduser()
    deadline = time.time() + timeout
    loop = SupervisorLoop.from_defaults()
    watcher = loop.create_watcher(str(worktree_path), pre_dispatch_head=pre_head)

    while time.time() < deadline:
        result = watcher.check_once()
        if result.stable:
            signal = ("HEAD changed" if result.head_changed
                      else "commit detected" if result.committed
                      else "files stable")
            click.echo(f"✅ Done ({signal})")
            if result.diff_summary:
                click.echo(result.diff_summary)

            # ── Auto-PR ─────────────────────────────────────────────
            if issue and auto_pr:
                from foreman.github import (parse_issue_ref as _parse, fetch_issue,
                                            create_pr, post_issue_comment)
                try:
                    repo, number = _parse(issue)
                    gh_issue = fetch_issue(repo, number)
                    branch_result = subprocess.run(
                        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
                        cwd=worktree_path, capture_output=True, text=True,
                    )
                    branch = branch_result.stdout.strip()
                    pr_url = create_pr(gh_issue, str(worktree_path), branch)
                    click.echo(f"✅ PR created: {pr_url}")
                    if comment:
                        post_issue_comment(repo, number,
                            f"✅ **Implementation complete.** PR: {pr_url}")
                except Exception as e:
                    click.echo(f"⚠️  Auto-PR failed: {e}", err=True)
            elif issue and comment:
                from foreman.github import parse_issue_ref as _parse, post_issue_comment
                try:
                    repo, number = _parse(issue)
                    post_issue_comment(repo, number,
                        "✅ **Implementation complete.** Agent committed — review and create PR.")
                except Exception as e:
                    click.echo(f"⚠️  Comment failed: {e}", err=True)

            sys.exit(0)

        remaining = int(deadline - time.time())
        click.echo(
            f"⏳ {time.strftime('%H:%M:%S')} | "
            f"HEAD {'changed' if result.head_changed else 'stable'} | "
            f"files: {len(result.files)} | {remaining}s left",
            err=True,
        )
        time.sleep(interval)

    # ── Timeout diagnosis ────────────────────────────────────────────
    click.echo(f"⏰ Timeout after {timeout}s — diagnosing...", err=True)

    # Screenshot so the human can see what Windsurf is showing
    screenshot_path = f"/tmp/foreman-timeout-{int(time.time())}.png"
    subprocess.run(["screencapture", "-x", screenshot_path], capture_output=True)
    click.echo(f"  Screenshot: {screenshot_path}", err=True)

    # Bridge health check — is the agent still saving files?
    try:
        resp = urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3)
        health = json.loads(resp.read())
        last_save_s = health.get("sinceLastSaveMs", 0) / 1000
        diag_count = health.get("diagnosticCount", 0)
        click.echo(
            f"  Bridge: last file save {last_save_s:.0f}s ago | "
            f"{diag_count} diagnostic errors",
            err=True,
        )
        if last_save_s < 60:
            click.echo("  → Agent appears still active (recent saves). Try a longer --timeout.", err=True)
        else:
            click.echo("  → No recent saves. Agent may be stuck or waiting for input.", err=True)
    except Exception:
        click.echo("  Bridge not responding — foreman-bridge extension may not be loaded.", err=True)

    # Check git status for any partial work
    git_status = subprocess.run(
        ["git", "status", "--short"],
        cwd=worktree_path, capture_output=True, text=True,
    )
    if git_status.stdout.strip():
        click.echo(f"  Uncommitted changes in worktree:\n{git_status.stdout}", err=True)

    sys.exit(1)


# ── Phase 3: Verify ──────────────────────────────────────────────────────────

@cli.command("verify")
@_worktree_opt
@click.option("--issue", default=None,
              help="Issue ref (owner/repo#N) — validates closing reference in commit.")
@click.option("--run-tests", default=None, metavar="CMD",
              help="Shell command to run tests (e.g. 'npm test' or 'pytest -q').")
@_state_file_opt
def verify(worktree: str, issue: str, run_tests: str, state_file: str):
    """Phase 3: diff + diagnostics + closing-ref check + optional test run.

    Claude reads this output to decide: clean, retry, takeover, or escalate.

    \b
    Examples:
        foreman verify --worktree ~/CascadeProjects/dn-windsurf
        foreman verify --worktree ~/CascadeProjects/dn-windsurf \\
            --issue owner/repo#42 --run-tests "npm test -- --passWithNoTests"
    """
    worktree_path = Path(worktree).expanduser()

    # ── Git diff summary ─────────────────────────────────────────────
    stat = subprocess.run(
        ["git", "diff", "HEAD~1", "--stat"],
        cwd=worktree_path, capture_output=True, text=True,
    )
    # If no HEAD~1 (fresh branch with one commit), diff against empty tree
    if stat.returncode != 0:
        stat = subprocess.run(
            ["git", "show", "--stat", "HEAD"],
            cwd=worktree_path, capture_output=True, text=True,
        )
    click.echo(f"### Diff summary\n{stat.stdout.strip() or '(no changes)'}")

    # ── Latest commit ────────────────────────────────────────────────
    log = subprocess.run(
        ["git", "log", "-3", "--oneline"],
        cwd=worktree_path, capture_output=True, text=True,
    )
    click.echo(f"\n### Recent commits\n{log.stdout.strip()}")

    # ── Closing reference check ──────────────────────────────────────
    if issue:
        from foreman.github import parse_issue_ref as _parse, validate_closing_ref
        try:
            repo, number = _parse(issue)
            found, latest_msg = validate_closing_ref(worktree, number)
            if found:
                click.echo(f"\n### Closing ref: ✅ found 'closes #{number}' in commits")
            else:
                click.echo(
                    f"\n### Closing ref: ⚠️  NOT FOUND — latest commit: '{latest_msg}'\n"
                    f"  The commit should contain 'closes #{number}' for GitHub auto-close."
                )
        except Exception as e:
            click.echo(f"\n### Closing ref check failed: {e}", err=True)

    # ── TypeScript / lint errors (from foreman-bridge or tsc) ────────
    loop = SupervisorLoop.from_defaults()
    ctx = loop.get_review_context(worktree)
    if ctx is None:
        click.echo("\n### TypeScript errors: (no active session — bridge diagnostics unavailable)")
    elif ctx.errors:
        click.echo(f"\n### TypeScript errors ({len(ctx.errors)})")
        for e in ctx.errors:
            click.echo(f"  {e}")
    else:
        click.echo("\n### TypeScript errors: none ✅")

    if ctx and ctx.circle_type:
        click.echo(f"\n### ⚠️  Circle detected: {ctx.circle_type.value}")

    # ── Test runner ──────────────────────────────────────────────────
    if run_tests:
        click.echo(f"\n### Tests: running `{run_tests}`...")
        test_result = subprocess.run(
            run_tests, shell=True, cwd=worktree_path,
            capture_output=True, text=True, timeout=300,
        )
        if test_result.returncode == 0:
            click.echo("### Tests: ✅ passed")
        else:
            click.echo("### Tests: ❌ FAILED")
        # Show last 50 lines of output (stdout + stderr combined)
        combined = (test_result.stdout + test_result.stderr).strip()
        lines = combined.split("\n")
        click.echo("\n".join(lines[-50:]))

    # ── Full diff (for Claude to read) ───────────────────────────────
    if ctx and ctx.full_diff:
        click.echo(f"\n### Full diff\n{ctx.full_diff}")


# ── Create-and-dispatch ──────────────────────────────────────────────────────

@cli.command("create-and-dispatch")
@click.argument("repo")
@click.argument("title")
@click.option("--body", default="", help="Issue body / description.")
@click.option("--body-file", default=None, type=click.Path(exists=True),
              help="Read issue body from a file (overrides --body).")
@_ide_opt
@_worktree_opt
@click.option("--new-window/--no-new-window", default=True)
@click.option("--comment/--no-comment", default=True)
def create_and_dispatch(
    repo: str, title: str, body: str, body_file: str,
    ide: str, worktree: str, new_window: bool, comment: bool,
):
    """Create a new GitHub issue then immediately dispatch it to the IDE agent.

    REPO:  owner/repo  (e.g. depollutenow/depollute-shop)
    TITLE: Issue title (quote it)

    Claude writes the issue spec, calls this command, and gets back a JSON
    result identical to `dispatch-issue` — ready to pipe into `foreman wait`.

    \b
    Example:
        OUT=$(foreman create-and-dispatch depollutenow/depollute-shop \\
                "Add dark mode toggle to settings page" \\
                --body-file /tmp/dark-mode-spec.md \\
                --ide windsurf --worktree ~/CascadeProjects/dn-windsurf)
        PRE_HEAD=$(echo "$OUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['head'])")
        foreman wait --worktree ~/CascadeProjects/dn-windsurf \\
            --pre-head "$PRE_HEAD" --issue "$(echo "$OUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['repo']+'#'+str(d['number']))")" --auto-pr
    """
    # ── Read body ────────────────────────────────────────────────────
    if body_file:
        body = Path(body_file).expanduser().read_text()

    # ── Create issue via gh CLI ──────────────────────────────────────
    click.echo(f"Creating issue in {repo}: {title!r}...", err=True)
    create_result = subprocess.run(
        ["gh", "issue", "create",
         "--repo", repo,
         "--title", title,
         "--body", body or "(no description)",
         "--json", "number,url"],
        capture_output=True, text=True,
    )
    if create_result.returncode != 0:
        click.echo(f"❌ gh issue create failed: {create_result.stderr.strip()}", err=True)
        sys.exit(1)

    created = json.loads(create_result.stdout)
    number = created["number"]
    url = created["url"]
    click.echo(f"  Created #{number}: {url}", err=True)

    # ── Delegate to dispatch-issue logic (invoke as sub-command) ─────
    # Re-use dispatch-issue via Click's invoke mechanism
    from foreman.github import (fetch_issue, ensure_branch, format_issue_prompt,
                                post_issue_comment, worktree_is_dirty)
    from foreman.drivers.ide_driver import IDEDriver

    issue = fetch_issue(repo, number)
    used_branch = ensure_branch(worktree, issue)
    click.echo(f"  Branch: {used_branch}", err=True)

    dirty = worktree_is_dirty(worktree)
    if dirty:
        click.echo("❌ Worktree has uncommitted changes — clean up first.", err=True)
        sys.exit(1)

    loop = SupervisorLoop.from_defaults()
    pf = loop.pre_flight_check(worktree, ide=ide, expected_branch=used_branch)
    if not pf.ready:
        for msg in pf.issues:
            click.echo(f"❌ {msg}", err=True)
        sys.exit(1)
    click.echo(f"  Pre-flight: HEAD {pf.head[:7]} ✅", err=True)

    if comment:
        try:
            post_issue_comment(repo, number,
                f"🤖 **Dispatched to {ide}** on branch `{used_branch}` "
                f"at {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}.")
        except Exception as e:
            click.echo(f"⚠️  Comment failed: {e}", err=True)

    config = SupervisorConfig.default()
    driver = IDEDriver(config)
    if new_window:
        try:
            driver.open_workspace(ide, worktree)
            time.sleep(2)
        except Exception as e:
            click.echo(f"⚠️  open_workspace: {e}", err=True)

    prompt = format_issue_prompt(issue, worktree, used_branch)
    try:
        driver.send(ide, prompt, worktree=worktree)
    except Exception as e:
        click.echo(f"❌ Dispatch failed: {e}", err=True)
        sys.exit(1)

    click.echo(f"  Dispatched #{number} → {ide} ✅", err=True)

    click.echo(json.dumps({
        "head": pf.head,
        "worktree": worktree,
        "branch": used_branch,
        "repo": repo,
        "number": number,
        "title": title,
        "url": url,
    }))


# ── Queue ─────────────────────────────────────────────────────────────────────

@cli.command("queue")
@click.argument("issue_refs", nargs=-1, required=True)
@_ide_opt
@_worktree_opt
@click.option("--per-worktree/--shared-worktree", default=True,
              help="Each issue gets its own worktree (default). Prevents cross-issue contamination.")
@click.option("--auto-pr/--no-auto-pr", default=True,
              help="Create a PR automatically after each clean issue.")
@click.option("--run-tests", default=None, metavar="CMD",
              help="Test command to run after each dispatch (e.g. 'npm test').")
@click.option("--timeout", default=600, show_default=True)
@click.option("--interval", default=30, show_default=True)
@click.option("--stop-on-failure/--continue-on-failure", default=True,
              help="Stop the queue if any issue fails verify (default: stop).")
@click.option("--comment/--no-comment", default=True)
def queue(
    issue_refs: tuple, ide: str, worktree: str,
    per_worktree: bool, auto_pr: bool, run_tests: str,
    timeout: int, interval: int, stop_on_failure: bool, comment: bool,
):
    """Dispatch multiple GitHub issues sequentially, end-to-end.

    Each issue goes through: dispatch → wait → verify → (auto-PR).
    With --per-worktree (default), each issue gets an isolated worktree
    at <base_parent>/dn-issue-{N} — no cross-contamination.

    \b
    Example:
        foreman queue owner/repo#42 owner/repo#43 owner/repo#44 \\
            --ide windsurf \\
            --worktree ~/CascadeProjects/dn-windsurf \\
            --auto-pr --run-tests "npm test"
    """
    from foreman.github import (parse_issue_ref as _parse, fetch_issue, ensure_branch,
                                ensure_issue_worktree, format_issue_prompt,
                                post_issue_comment, create_pr, validate_closing_ref,
                                worktree_is_dirty, branch_name as _bn)
    from foreman.drivers.ide_driver import IDEDriver

    config = SupervisorConfig.default()
    driver = IDEDriver(config)
    loop = SupervisorLoop.from_defaults()

    results = []  # {"ref": ..., "status": "ok"|"failed"|"skipped", "pr": ...}

    click.echo(f"Queue: {len(issue_refs)} issue(s) → {ide}", err=True)
    click.echo("=" * 60, err=True)

    for ref in issue_refs:
        click.echo(f"\n▶ {ref}", err=True)

        # ── Fetch ───────────────────────────────────────────────────
        try:
            repo, number = _parse(ref)
            issue = fetch_issue(repo, number)
        except Exception as e:
            click.echo(f"  ❌ Fetch failed: {e}", err=True)
            results.append({"ref": ref, "status": "failed", "reason": str(e)})
            if stop_on_failure:
                break
            continue

        click.echo(f"  #{issue.number}: {issue.title}", err=True)

        # ── Worktree ─────────────────────────────────────────────────
        issue_worktree = worktree
        used_branch = _bn(issue)
        if per_worktree:
            try:
                issue_worktree = ensure_issue_worktree(issue, worktree, used_branch)
                click.echo(f"  Worktree: {issue_worktree}", err=True)
            except Exception as e:
                click.echo(f"  ❌ Worktree failed: {e}", err=True)
                results.append({"ref": ref, "status": "failed", "reason": str(e)})
                if stop_on_failure:
                    break
                continue

        try:
            used_branch = ensure_branch(issue_worktree, issue, custom_branch=used_branch)
        except Exception as e:
            click.echo(f"  ❌ Branch failed: {e}", err=True)
            results.append({"ref": ref, "status": "failed", "reason": str(e)})
            if stop_on_failure:
                break
            continue

        # ── Pre-flight ───────────────────────────────────────────────
        dirty = worktree_is_dirty(issue_worktree)
        if dirty:
            click.echo(f"  ❌ Dirty worktree ({len(dirty)} files) — skipping", err=True)
            results.append({"ref": ref, "status": "failed", "reason": "dirty worktree"})
            if stop_on_failure:
                break
            continue

        pf = loop.pre_flight_check(issue_worktree, ide=ide, expected_branch=used_branch)
        if not pf.ready:
            for msg in pf.issues:
                click.echo(f"  ❌ {msg}", err=True)
            results.append({"ref": ref, "status": "failed", "reason": "; ".join(pf.issues)})
            if stop_on_failure:
                break
            continue

        # ── GitHub dispatch comment ──────────────────────────────────
        if comment:
            try:
                post_issue_comment(repo, number,
                    f"🤖 **Queued dispatch to {ide}** (position {issue_refs.index(ref)+1}/{len(issue_refs)}) "
                    f"on branch `{used_branch}`.")
            except Exception:
                pass

        # ── Open workspace + dispatch ────────────────────────────────
        try:
            driver.open_workspace(ide, issue_worktree)
            time.sleep(2)
        except Exception:
            pass

        prompt = format_issue_prompt(issue, issue_worktree, used_branch)
        try:
            driver.send(ide, prompt, worktree=issue_worktree)
        except Exception as e:
            click.echo(f"  ❌ Dispatch failed: {e}", err=True)
            results.append({"ref": ref, "status": "failed", "reason": str(e)})
            if stop_on_failure:
                break
            continue

        click.echo(f"  Dispatched ✅  waiting up to {timeout}s...", err=True)

        # ── Wait ─────────────────────────────────────────────────────
        watcher = loop.create_watcher(issue_worktree, pre_dispatch_head=pf.head)
        deadline = time.time() + timeout
        done = False
        while time.time() < deadline:
            watch_result = watcher.check_once()
            if watch_result.stable:
                done = True
                break
            remaining = int(deadline - time.time())
            click.echo(
                f"  ⏳ {time.strftime('%H:%M:%S')} | files: {len(watch_result.files)} | {remaining}s",
                err=True,
            )
            time.sleep(interval)

        if not done:
            click.echo(f"  ❌ Timeout after {timeout}s", err=True)
            results.append({"ref": ref, "status": "failed", "reason": "timeout"})
            if stop_on_failure:
                break
            continue

        # ── Closing ref check ────────────────────────────────────────
        closing_ok, latest_msg = validate_closing_ref(issue_worktree, number)
        if not closing_ok:
            click.echo(
                f"  ⚠️  Closing ref missing in commits. Latest: '{latest_msg}'",
                err=True,
            )

        # ── Test runner ──────────────────────────────────────────────
        test_ok = True
        if run_tests:
            test_result = subprocess.run(
                run_tests, shell=True,
                cwd=Path(issue_worktree).expanduser(),
                capture_output=True, text=True, timeout=300,
            )
            test_ok = test_result.returncode == 0
            click.echo(f"  Tests: {'✅' if test_ok else '❌'}", err=True)
            if not test_ok:
                combined = (test_result.stdout + test_result.stderr).strip()
                click.echo("\n".join(combined.split("\n")[-20:]), err=True)

        if not test_ok:
            results.append({"ref": ref, "status": "failed", "reason": "tests failed"})
            if stop_on_failure:
                break
            continue

        # ── Auto-PR ──────────────────────────────────────────────────
        pr_url = None
        if auto_pr:
            try:
                pr_url = create_pr(issue, issue_worktree, used_branch)
                click.echo(f"  PR: {pr_url} ✅", err=True)
                if comment:
                    post_issue_comment(repo, number,
                        f"✅ **Done.** PR: {pr_url}")
            except Exception as e:
                click.echo(f"  ⚠️  PR failed: {e}", err=True)

        results.append({"ref": ref, "status": "ok", "pr": pr_url})
        click.echo("  ✅ Complete", err=True)

    # ── Summary ──────────────────────────────────────────────────────
    click.echo("\n" + "=" * 60)
    click.echo(f"Queue complete: {sum(1 for r in results if r['status']=='ok')}/{len(results)} succeeded")
    for r in results:
        icon = "✅" if r["status"] == "ok" else "❌"
        pr = f" → {r['pr']}" if r.get("pr") else ""
        reason = f" ({r.get('reason', '')})" if r.get("reason") else ""
        click.echo(f"  {icon} {r['ref']}{pr}{reason}")


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
    config = SupervisorConfig.default()
    loop = SupervisorLoop(
        config=config,
        state_path=Path(state_file).expanduser(),
        learnings_path=Path(config.learnings_file).expanduser(),
    )
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
