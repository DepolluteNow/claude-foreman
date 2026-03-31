from foreman.ring.state import SupervisorState, TaskState, TaskStatus


def format_task_start(task: TaskState, total: int) -> str:
    return f"▶️ Task {task.id}/{total} starting: {task.spec[:80]}  →  {task.model} in {task.ide}"


def format_task_done(task: TaskState, total: int, duration_sec: int) -> str:
    retries = f", {task.retries} retries" if task.retries > 0 else ""
    return f"✅ Task {task.id}/{total} done: {task.spec[:60]} ({duration_sec}s, {task.model}{retries})"


def format_takeover(task: TaskState, total: int, lines_changed: int) -> str:
    return (
        f"⚡ Took over task {task.id}/{total} — "
        f"{task.model} looped on {task.spec[:40]}, "
        f"fixed in {lines_changed} lines. Resuming."
    )


def format_escalation(task: TaskState, total: int, reason: str, diff_summary: str) -> str:
    return (
        f"🔴 Task {task.id}/{total} PAUSED: {task.spec[:60]}\n"
        f"{reason}\n"
        f"Diff: {diff_summary[:200]}\n\n"
        f"Reply with:\n"
        f"• guidance (e.g. \"use Users collection\")\n"
        f"• \"skip\" to move on\n"
        f"• \"stop\" to save and quit"
    )


def format_completion(state: SupervisorState, duration_min: int) -> str:
    summary = state.progress_summary()
    takeovers = sum(1 for t in state.tasks if t.result == "takeover")
    escalations = sum(1 for t in state.tasks if t.result == "escalated")
    return (
        f"🏁 All {summary['completed']}/{summary['total']} tasks complete.\n"
        f"{duration_min}min | {state.total_claude_tokens:,} Claude tokens | "
        f"{escalations} escalations | {takeovers} takeovers\n"
        f"Branch ready for review."
    )
