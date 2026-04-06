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
    # owner/repo#123
    m = re.match(r'^([\w.-]+/[\w.-]+)#(\d+)$', ref.strip())
    if m:
        return m.group(1), int(m.group(2))
    # GitHub URL
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

    # Does the branch already exist locally?
    existing = subprocess.run(
        ["git", "rev-parse", "--verify", target],
        cwd=worktree_path,
        capture_output=True,
    )
    if existing.returncode == 0:
        subprocess.run(
            ["git", "checkout", target],
            cwd=worktree_path,
            capture_output=True,
        )
        return target

    # Create fresh from the best available base
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


def format_issue_prompt(issue: GitHubIssue, worktree: str, branch: str) -> str:
    """Format the subagent prompt for a GitHub issue dispatch.

    The prompt is intentionally short — the issue body contains all detail.
    The commit message uses ``closes #{N}`` so GitHub auto-closes the issue.
    """
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
