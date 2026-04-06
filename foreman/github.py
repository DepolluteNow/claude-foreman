"""
GitHub integration for Claude Foreman.

Fetches issues via the `gh` CLI (handles auth automatically) and manages
the worktree branch for issue-based dispatch.

Usage:
    from foreman.github import parse_issue_ref, fetch_issue, ensure_branch

    repo, number = parse_issue_ref("depollutenow/depollute-shop#42")
    issue = fetch_issue(repo, number)
    branch = ensure_branch("~/CascadeProjects/dn-windsurf", issue)
"""

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class GitHubIssue:
    number: int
    title: str
    body: str
    url: str
    repo: str


def parse_issue_ref(ref: str) -> tuple[str, int]:
    """Parse an issue reference into (repo, number).

    Accepts:
    - ``owner/repo#123``
    - ``https://github.com/owner/repo/issues/123``
    """
    m = re.match(r'^([\w.-]+/[\w.-]+)#(\d+)$', ref.strip())
    if m:
        return m.group(1), int(m.group(2))
    m = re.search(r'github\.com/([\w.-]+/[\w.-]+)/issues/(\d+)', ref)
    if m:
        return m.group(1), int(m.group(2))
    raise ValueError(
        f"Cannot parse issue reference: {ref!r}\n"
        "Expected format: 'owner/repo#123' or a GitHub issue URL."
    )


def fetch_issue(repo: str, number: int) -> GitHubIssue:
    """Fetch a GitHub issue using the `gh` CLI.

    Requires `gh` to be authenticated (`gh auth status`).
    """
    result = subprocess.run(
        ["gh", "issue", "view", str(number),
         "--repo", repo,
         "--json", "number,title,body,url"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Failed to fetch {repo}#{number}: {result.stderr.strip()}\n"
            "Make sure `gh` is installed and authenticated (`gh auth status`)."
        )
    data = json.loads(result.stdout)
    return GitHubIssue(
        number=data["number"],
        title=data["title"],
        body=(data.get("body") or "").strip(),
        url=data["url"],
        repo=repo,
    )


def branch_name(issue: GitHubIssue) -> str:
    """Derive a git branch name from the issue: ``feat/issue-{N}-{slug}``."""
    slug = re.sub(r"[^\w\s-]", "", issue.title.lower())
    slug = re.sub(r"[\s_]+", "-", slug.strip())
    slug = re.sub(r"-+", "-", slug)[:40].rstrip("-")
    return f"feat/issue-{issue.number}-{slug}"


def ensure_branch(worktree: str, issue: GitHubIssue, custom_branch: str = "") -> str:
    """Create the issue branch in the worktree if it doesn't exist, then check it out.

    Returns the branch name used.
    """
    target = custom_branch or branch_name(issue)
    worktree_path = Path(worktree).expanduser()

    existing = subprocess.run(
        ["git", "rev-parse", "--verify", target],
        cwd=worktree_path,
        capture_output=True,
    )
    if existing.returncode == 0:
        subprocess.run(["git", "checkout", target], cwd=worktree_path, capture_output=True)
        return target

    for base in ["origin/main", "origin/master", "main", "master"]:
        r = subprocess.run(
            ["git", "checkout", "-b", target, base],
            cwd=worktree_path,
            capture_output=True,
        )
        if r.returncode == 0:
            return target

    raise RuntimeError(
        f"Could not create branch {target!r} in {worktree}. "
        "Check that origin/main or main exists."
    )


def get_main_repo(from_worktree: str) -> str:
    """Return the main repo path by inspecting `git worktree list` from any worktree.

    The first entry in the list is always the original (main) checkout.
    """
    result = subprocess.run(
        ["git", "worktree", "list", "--porcelain"],
        cwd=Path(from_worktree).expanduser(),
        capture_output=True,
        text=True,
    )
    for line in result.stdout.splitlines():
        if line.startswith("worktree "):
            return line[len("worktree "):]
    raise RuntimeError(f"Cannot determine main repo from worktree: {from_worktree}")


def ensure_issue_worktree(issue: GitHubIssue, base_worktree: str, branch: str) -> str:
    """Create a per-issue git worktree at ``<base_parent>/dn-issue-{N}``.

    Uses the main repo (derived from ``base_worktree``) to run
    ``git worktree add``.  Returns the absolute path of the new worktree.

    Idempotent — if the path already exists, returns it unchanged.
    """
    base = Path(base_worktree).expanduser()
    issue_worktree = base.parent / f"dn-issue-{issue.number}"

    if issue_worktree.exists():
        return str(issue_worktree)

    main_repo = get_main_repo(str(base))

    for origin_base in ["origin/main", "origin/master", "main", "master"]:
        r = subprocess.run(
            ["git", "worktree", "add", str(issue_worktree), "-b", branch, origin_base],
            cwd=main_repo,
            capture_output=True,
            text=True,
        )
        if r.returncode == 0:
            return str(issue_worktree)

    raise RuntimeError(
        f"git worktree add failed for issue #{issue.number}. "
        f"stderr: {r.stderr.strip()}"
    )


def post_issue_comment(repo: str, number: int, body: str) -> None:
    """Post a comment on a GitHub issue via the `gh` CLI."""
    result = subprocess.run(
        ["gh", "issue", "comment", str(number), "--repo", repo, "--body", body],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"gh issue comment failed: {result.stderr.strip()}")


def create_pr(issue: GitHubIssue, worktree: str, branch: str, base: str = "main") -> str:
    """Create a pull request for the issue branch via the `gh` CLI.

    Returns the PR URL.
    """
    body = (
        f"Closes #{issue.number}\n\n"
        f"Implemented autonomously by [Claude Foreman](https://github.com/DepolluteNow/claude-foreman)."
    )
    result = subprocess.run(
        [
            "gh", "pr", "create",
            "--repo", issue.repo,
            "--title", f"feat: {issue.title}",
            "--body", body,
            "--head", branch,
            "--base", base,
        ],
        capture_output=True,
        text=True,
        cwd=Path(worktree).expanduser(),
    )
    if result.returncode != 0:
        raise RuntimeError(f"gh pr create failed: {result.stderr.strip()}")
    return result.stdout.strip()


def validate_closing_ref(worktree: str, issue_number: int) -> tuple[bool, str]:
    """Check if recent commits contain a GitHub closing reference for the issue.

    Accepts ``closes``, ``fixes``, or ``resolves`` (case-insensitive).
    Returns (found, latest_commit_subject).
    """
    # Search last 10 commits (agent may have made several)
    log = subprocess.run(
        ["git", "log", "-10", "--format=%s%n%b"],
        cwd=Path(worktree).expanduser(),
        capture_output=True,
        text=True,
    )
    text = log.stdout.lower()
    patterns = [f"closes #{issue_number}", f"fixes #{issue_number}", f"resolves #{issue_number}"]
    found = any(p in text for p in patterns)

    latest = subprocess.run(
        ["git", "log", "-1", "--format=%s"],
        cwd=Path(worktree).expanduser(),
        capture_output=True,
        text=True,
    )
    return found, latest.stdout.strip()


def worktree_is_dirty(worktree: str) -> list[str]:
    """Return list of dirty files in the worktree, or empty list if clean."""
    result = subprocess.run(
        ["git", "status", "--short"],
        cwd=Path(worktree).expanduser(),
        capture_output=True,
        text=True,
    )
    return [line for line in result.stdout.splitlines() if line.strip()]


def format_issue_prompt(issue: GitHubIssue, worktree: str, branch: str) -> str:
    """Format the subagent prompt for a GitHub issue dispatch."""
    title_slug = issue.title[:60]
    return (
        f"You are an autonomous coding subagent. Implement the following GitHub issue "
        f"exactly as described. Do not ask questions.\n\n"
        f"Issue:    {issue.url}\n"
        f"Title:    {issue.title}\n"
        f"Branch:   {branch}\n"
        f"Worktree: {worktree}\n\n"
        f"--- Issue Body ---\n\n"
        f"{issue.body}\n\n"
        f"--- End Issue Body ---\n\n"
        f"When every requirement is met and the code compiles:\n\n"
        f'    git add -A && git commit -m "feat: {title_slug} (closes #{issue.number})"\n\n'
        f"Rules:\n"
        f"- Work autonomously on branch `{branch}` — do not switch branches\n"
        f"- Do not push — commit only\n"
        f"- Fix any compile or lint errors before committing\n"
        f"- The commit message MUST contain `closes #{issue.number}`\n"
    )


import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path


