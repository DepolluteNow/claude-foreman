"""
Foreman Loop — The orchestrator.

This module provides the mechanical state machine that Claude drives via the SKILL.md protocol.
Claude handles the intelligent parts (decompose, review, takeover); this module handles the
state transitions, timing, dispatching, and persistence.

Usage (from Claude Code skill):
    from foreman.ring.loop import ForemanLoop
    loop = ForemanLoop.from_defaults()
    loop.initialize("implement user auth", task_specs)
    # ... Claude drives the loop via methods below
"""

import json
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from foreman.comms.telegram import (format_completion, format_escalation,
                                    format_takeover, format_task_done,
                                    format_task_start)
from foreman.config import SupervisorConfig
from foreman.ring.learnings import Learnings
from foreman.ring.router import TaskRouter
from foreman.ring.state import SupervisorState, TaskState, TaskStatus
from foreman.ring.takeover import CircleDetector, CircleType
from foreman.ring.watcher import FilesystemWatcher, WatchResult


@dataclass
class ReviewContext:
    """Everything Claude needs to review a completed task."""
    task: TaskState
    total_tasks: int
    files_changed: list[str]
    diff_summary: str
    full_diff: str
    errors: list[str]
    circle_type: Optional[CircleType]


@dataclass
class DispatchResult:
    """Result of dispatching a task to an IDE."""
    task: TaskState
    ide: str
    model: str
    worktree: str
    message: str
    windsurf_prompt: str  # Optimized subagent prompt — pass this directly to bridge.send()


class SupervisorLoop:
    """
    Mechanical state machine for the autonomous foreman.

    Claude drives this via SKILL.md. The loop handles:
    - State persistence (crash recovery)
    - Task routing (heuristic + adaptive)
    - Filesystem watching (completion detection)
    - Circle detection (going-in-circles guard)
    - Telegram message formatting

    Claude handles:
    - DECOMPOSE: Breaking goals into task specs
    - REVIEW: Reading diffs and classifying issues
    - TAKEOVER: Writing targeted fixes (max 50 lines)
    - ESCALATE: Deciding when to ask the human
    """

    def __init__(
        self,
        config: SupervisorConfig,
        state_path: Path,
        learnings_path: Path,
    ):
        self.config = config
        self.state_path = state_path
        self.learnings_path = learnings_path
        self.router = TaskRouter(config)
        self.learnings = Learnings(learnings_path)
        self.circle_detector = CircleDetector()
        self._task_start_time: Optional[float] = None
        self._session_start_time: float = time.time()

        # Load existing state or start fresh
        self.state: Optional[SupervisorState] = SupervisorState.load(state_path)

    @staticmethod
    def from_defaults() -> "SupervisorLoop":
        """Create a loop with default config paths."""
        config = SupervisorConfig.default()
        return SupervisorLoop(
            config=config,
            state_path=Path(config.state_file).expanduser(),
            learnings_path=Path(config.learnings_file).expanduser(),
        )

    # ── INITIALIZE ──────────────────────────────────────────────────

    def initialize(self, goal: str, task_specs: list[str]) -> str:
        """
        Create a new foreman session from decomposed task specs.

        Args:
            goal: The high-level goal (e.g., "implement user auth for DN")
            task_specs: List of task specification strings from DECOMPOSE phase

        Returns:
            Summary string with task count and routing breakdown
        """
        # Load learnings for adaptive routing
        learnings_data = self.learnings.load()
        model_perf = learnings_data.get("model_performance") or None

        self.state = SupervisorState.new(goal)

        routing_summary = {"windsurf": 0, "antigravity": 0}
        for spec in task_specs:
            classification = self.router.classify(spec, model_performance=model_perf)
            self.state.add_task(
                spec=spec,
                complexity=classification.complexity,
                ide=classification.ide,
                model=classification.model,
            )
            routing_summary[classification.ide] = routing_summary.get(classification.ide, 0) + 1

        self.state.save(self.state_path)
        self._session_start_time = time.time()

        return (
            f"Initialized {len(task_specs)} tasks. "
            f"Windsurf: {routing_summary.get('windsurf', 0)}, "
            f"Antigravity: {routing_summary.get('antigravity', 0)}"
        )

    # ── PROMPT FORMATTING ───────────────────────────────────────────

    def _format_windsurf_prompt(self, task: TaskState, worktree: str) -> str:
        """
        Format an optimized subagent prompt for Windsurf/Cascade.

        Frames Windsurf as an autonomous coding subagent with:
        - Clear task spec and acceptance criteria
        - A deterministic commit message prefix for reliable completion detection
        - Explicit no-questions boundary (avoids WAITING_INPUT stalls)
        """
        total = len(self.state.tasks) if self.state else "?"
        # First non-empty line of spec as brief description for the commit message
        brief = next((line.strip() for line in task.spec.splitlines() if line.strip()), "task")[:60]
        commit_prefix = f"foreman-task-{task.id}"

        retry_note = ""
        if task.retries > 0:
            retry_note = (
                f"\n> NOTE: This is retry {task.retries}. "
                "A previous attempt did not fully satisfy the acceptance criteria. "
                "Read the task carefully and ensure all steps are completed.\n"
            )

        return (
            f"You are an autonomous coding subagent. Complete the task below without asking "
            f"for clarification. Work in the worktree at: {worktree}\n"
            f"{retry_note}\n"
            f"## Task {task.id}/{total} [{task.complexity}]\n\n"
            f"{task.spec}\n\n"
            f"## Completion\n\n"
            f"When all steps are done, commit every changed file with this exact message:\n\n"
            f"    git add -A && git commit -m \"{commit_prefix}: {brief}\"\n\n"
            f"The commit message MUST start with `{commit_prefix}:` — this is how the "
            f"supervisor knows you finished.\n\n"
            f"## Rules\n\n"
            f"- Work autonomously — do not ask questions or wait for confirmation\n"
            f"- Do not modify files outside the scope of this task\n"
            f"- Do not push — commit only\n"
            f"- If you hit a compile error, fix it before committing\n"
        )

    # ── DISPATCH ────────────────────────────────────────────────────

    def dispatch_next(self) -> Optional[DispatchResult]:
        """
        Get the next pending task, mark it in-progress, and return dispatch info.

        Returns:
            DispatchResult with task info and worktree path, or None if all done.
        """
        if not self.state:
            return None

        task = self.state.current_task()
        if not task:
            return None

        task.status = TaskStatus.IN_PROGRESS
        self.state.save(self.state_path)
        self._task_start_time = time.time()
        self.circle_detector.reset()

        ide_config = self.config.ides.get(task.ide)
        worktree = ide_config.worktree if ide_config else "unknown"

        return DispatchResult(
            task=task,
            ide=task.ide,
            model=task.model,
            worktree=worktree,
            message=format_task_start(task, len(self.state.tasks)),
            windsurf_prompt=self._format_windsurf_prompt(task, worktree),
        )

    # ── WAIT ────────────────────────────────────────────────────────

    def poll_completion(self, worktree_path: str) -> WatchResult:
        """
        Single poll of the filesystem watcher.

        Claude calls this in a loop with sleep between calls.
        Returns WatchResult with .stable = True when model appears done.
        WatchResult.committed = True means the foreman-task-{id} commit was detected.
        """
        task = self.state.current_task() if self.state else None
        watcher = FilesystemWatcher(
            worktree=Path(worktree_path).expanduser(),
            poll_interval=self.config.poll_interval,
            stability_polls=self.config.stability_polls,
            task_id=task.id if task else None,
        )
        return watcher.check_once()

    def create_watcher(self, worktree_path: str) -> FilesystemWatcher:
        """
        Create a persistent watcher for repeated polling.

        Better than poll_completion() for actual waiting — maintains state
        across consecutive checks for stability detection.
        WatchResult.committed = True is the primary completion signal when
        the subagent used the expected foreman-task-{id}: commit prefix.
        """
        task = self.state.current_task() if self.state else None
        return FilesystemWatcher(
            worktree=Path(worktree_path).expanduser(),
            poll_interval=self.config.poll_interval,
            stability_polls=self.config.stability_polls,
            task_id=task.id if task else None,
        )

    def is_timed_out(self) -> bool:
        """Check if current task has exceeded the timeout."""
        if not self._task_start_time:
            return False
        elapsed = time.time() - self._task_start_time
        return elapsed > (self.config.timeout_minutes * 60)

    # ── REVIEW CONTEXT ──────────────────────────────────────────────

    def get_review_context(self, worktree_path: str) -> Optional[ReviewContext]:
        """
        Gather everything Claude needs to review the current task's output.

        Reads git diff, checks for TypeScript/lint errors, runs circle detection.
        Returns ReviewContext for Claude to analyze.
        """
        if not self.state:
            return None

        task = self.state.current_task()
        if not task:
            return None

        worktree = Path(worktree_path).expanduser()

        # Get changed files
        files_result = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=worktree, capture_output=True, text=True,
        )
        files = [f.strip() for f in files_result.stdout.strip().split("\n") if f.strip()]

        # Add untracked files
        untracked_result = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard"],
            cwd=worktree, capture_output=True, text=True,
        )
        untracked = [f.strip() for f in untracked_result.stdout.strip().split("\n") if f.strip()]
        all_files = sorted(set(files + untracked))

        # Get diff summary
        stat_result = subprocess.run(
            ["git", "diff", "--stat", "HEAD"],
            cwd=worktree, capture_output=True, text=True,
        )
        diff_summary = stat_result.stdout.strip()

        # Get full diff (truncated to 500 lines for context)
        diff_result = subprocess.run(
            ["git", "diff", "HEAD"],
            cwd=worktree, capture_output=True, text=True,
        )
        full_diff = diff_result.stdout
        diff_lines = full_diff.split("\n")
        if len(diff_lines) > 500:
            full_diff = "\n".join(diff_lines[:500]) + f"\n... ({len(diff_lines) - 500} more lines)"

        # Check for TypeScript errors (if .ts/.tsx files changed)
        errors = []
        ts_files = [f for f in all_files if f.endswith((".ts", ".tsx"))]
        if ts_files:
            tsc_result = subprocess.run(
                ["npx", "tsc", "--noEmit", "--pretty", "false"],
                cwd=worktree, capture_output=True, text=True, timeout=60,
            )
            if tsc_result.returncode != 0:
                # Extract error lines
                for line in tsc_result.stdout.split("\n"):
                    if any(f in line for f in all_files) and "error" in line.lower():
                        errors.append(line.strip())

        # Circle detection
        circle = self.circle_detector.check(
            attempt=task.retries + 1,
            changed_files=all_files,
            diff=full_diff,
            errors=errors,
        )

        return ReviewContext(
            task=task,
            total_tasks=len(self.state.tasks),
            files_changed=all_files,
            diff_summary=diff_summary,
            full_diff=full_diff,
            errors=errors,
            circle_type=circle,
        )

    # ── RECORD RESULTS ──────────────────────────────────────────────

    def mark_clean(self) -> str:
        """Mark current task as completed cleanly. Returns Telegram message."""
        task = self.state.current_task()
        if not task:
            return "No active task"

        task.status = TaskStatus.COMPLETED
        task.result = "clean"
        self.state.save(self.state_path)

        duration = int(time.time() - self._task_start_time) if self._task_start_time else 0
        return format_task_done(task, len(self.state.tasks), duration)

    def mark_minor_fix(self) -> str:
        """Mark current task as completed with minor corrections needed. Returns retry prompt."""
        task = self.state.current_task()
        if not task:
            return "No active task"

        task.retries += 1
        task.result = "minor_fix"

        if task.retries > self.config.max_retries:
            # Too many retries — escalate
            task.status = TaskStatus.FAILED
            self.state.save(self.state_path)
            return f"Task {task.id} exceeded max retries ({self.config.max_retries}). Escalating."

        self.state.save(self.state_path)
        return f"Task {task.id} needs correction (retry {task.retries}/{self.config.max_retries})"

    def mark_takeover(self, lines_changed: int) -> str:
        """Mark current task as taken over by Claude. Returns Telegram message."""
        task = self.state.current_task()
        if not task:
            return "No active task"

        task.status = TaskStatus.COMPLETED
        task.result = "takeover"
        self.state.save(self.state_path)

        return format_takeover(task, len(self.state.tasks), lines_changed)

    def mark_escalated(self, reason: str) -> str:
        """Mark current task as escalated. Returns Telegram message."""
        task = self.state.current_task()
        if not task:
            return "No active task"

        task.result = "escalated"
        self.state.paused = True
        self.state.pause_reason = reason
        self.state.save(self.state_path)

        # Get diff summary for the message
        ide_config = self.config.ides.get(task.ide)
        diff_summary = ""
        if ide_config:
            result = subprocess.run(
                ["git", "diff", "--stat", "HEAD"],
                cwd=Path(ide_config.worktree).expanduser(),
                capture_output=True, text=True,
            )
            diff_summary = result.stdout.strip()

        return format_escalation(task, len(self.state.tasks), reason, diff_summary)

    def mark_skipped(self) -> str:
        """Skip current task and move on."""
        task = self.state.current_task()
        if not task:
            return "No active task"

        task.status = TaskStatus.SKIPPED
        task.result = "skipped"
        self.state.save(self.state_path)
        return f"Task {task.id} skipped: {task.spec[:60]}"

    # ── COMPLETION ──────────────────────────────────────────────────

    def is_complete(self) -> bool:
        """Check if all tasks are done (completed, skipped, or failed)."""
        if not self.state:
            return True
        return self.state.current_task() is None

    def complete(self) -> str:
        """
        Run retrospective and return completion message.

        Called when all tasks are done. Updates learnings file,
        returns summary for Telegram.
        """
        if not self.state:
            return "No active session"

        # Run retrospective
        self.learnings.record_retrospective(self.state)

        # Calculate duration
        duration_min = int((time.time() - self._session_start_time) / 60)

        msg = format_completion(self.state, duration_min)

        # Clear state file (session done)
        self.state_path.unlink(missing_ok=True)

        return msg

    # ── STATUS ──────────────────────────────────────────────────────

    def get_status(self) -> dict:
        """Return current status for display."""
        if not self.state:
            return {"active": False}

        summary = self.state.progress_summary()
        current = self.state.current_task()
        elapsed = int((time.time() - self._session_start_time) / 60)

        return {
            "active": True,
            "goal": self.state.goal,
            "progress": f"{summary['completed']}/{summary['total']}",
            "current_task": {
                "id": current.id,
                "spec": current.spec[:80],
                "ide": current.ide,
                "model": current.model,
                "retries": current.retries,
            } if current else None,
            "paused": self.state.paused,
            "pause_reason": self.state.pause_reason,
            "tokens": self.state.total_claude_tokens,
            "elapsed_min": elapsed,
        }

    def get_learnings_context(self) -> str:
        """
        Return learnings for the DECOMPOSE phase prompt.

        Claude reads this to apply "always" patterns and avoid "never" patterns
        when writing task specs.
        """
        data = self.learnings.load()
        parts = []

        always = data.get("patterns", {}).get("always", [])
        if always:
            parts.append("ALWAYS include in task specs:")
            for p in always:
                parts.append(f"  - {p}")

        never = data.get("patterns", {}).get("never", [])
        if never:
            parts.append("NEVER do in task specs:")
            for p in never:
                parts.append(f"  - {p}")

        perf = data.get("model_performance", {})
        if perf:
            parts.append("Model performance (first-try rate):")
            for model, scores in perf.items():
                score_str = ", ".join(f"{k}: {v:.0%}" for k, v in scores.items())
                parts.append(f"  {model}: {score_str}")

        history = data.get("first_try_rate_history", [])
        if history:
            parts.append(f"Historical first-try rate: {' → '.join(f'{r:.0%}' for r in history[-5:])}")

        return "\n".join(parts) if parts else "No learnings yet (first run)."

    # ── RESUME ──────────────────────────────────────────────────────

    def resume(self) -> Optional[str]:
        """
        Resume from a saved state file.

        Returns status message or None if no saved state.
        """
        self.state = SupervisorState.load(self.state_path)
        if not self.state:
            return None

        self.state.paused = False
        self.state.pause_reason = None
        self.state.save(self.state_path)
        self._session_start_time = time.time()

        current = self.state.current_task()
        summary = self.state.progress_summary()

        if current:
            return (
                f"Resumed: {self.state.goal}\n"
                f"Progress: {summary['completed']}/{summary['total']} tasks\n"
                f"Next: Task {current.id} — {current.spec[:60]} ({current.ide}/{current.model})"
            )
        return f"Resumed but all tasks done. Run complete()."
