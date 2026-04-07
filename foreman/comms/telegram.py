from foreman.ring.state import SupervisorState, TaskState


def format_task_start(task: TaskState, total: int) -> str:
    return f"🥊 Round {task.id}/{total} — FIGHT! {task.spec[:80]}  →  {task.model} in {task.ide}"


def format_task_done(task: TaskState, total: int, duration_sec: int) -> str:
    if task.retries == 0:
        return f"🏆 Round {task.id}/{total} — KO! {task.spec[:60]} ({duration_sec}s, {task.model})"
    else:
        return f"🏆 Round {task.id}/{total} — Won by decision! {task.spec[:60]} ({duration_sec}s, {task.model}, {task.retries} standing counts)"


def format_takeover(task: TaskState, total: int, lines_changed: int) -> str:
    return (
        f"🔔 Round {task.id}/{total} — Corner steps in! {task.model} was on the ropes at {task.spec[:40]}, "
        f"fixed in {lines_changed} lines. Fight continues."
    )


def format_escalation(task: TaskState, total: int, reason: str, diff_summary: str) -> str:
    return (
        f"� Round {task.id}/{total} — REFEREE STOP! {task.spec[:60]}\n"
        f"{reason}\n"
        f"Scorecard: {diff_summary[:200]}\n\n"
        f"Corner instructions:\n"
        f"• guidance (e.g. \"use Users collection\")\n"
        f"• \"throw in the towel\" to skip\n"
        f"• \"stop the fight\" to save and quit"
    )


def format_completion(state: SupervisorState, duration_min: int) -> str:
    summary = state.progress_summary()
    takeovers = sum(1 for t in state.tasks if t.result == "takeover")
    escalations = sum(1 for t in state.tasks if t.result == "escalated")
    return (
        f"�🥊 FIGHT OVER! {summary['completed']}/{summary['total']} rounds won.\n"
        f"Fight time: {duration_min}min | Corner tokens: {state.total_claude_tokens:,} | "
        f"Referee stops: {escalations} | Corner takeovers: {takeovers}\n"
        f"The champ's record is updated. Branch ready for judges."
    )
