import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional


class TaskStatus(Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    SKIPPED = "skipped"
    FAILED = "failed"


@dataclass
class TaskState:
    id: int
    spec: str
    complexity: str
    ide: str
    model: str
    status: TaskStatus = TaskStatus.PENDING
    retries: int = 0
    result: Optional[str] = None  # "clean", "minor_fix", "takeover", "escalated"


@dataclass
class SupervisorState:
    goal: str
    tasks: list[TaskState]
    started_at: str
    paused: bool = False
    pause_reason: Optional[str] = None
    total_claude_tokens: int = 0

    @staticmethod
    def new(goal: str) -> "SupervisorState":
        return SupervisorState(
            goal=goal,
            tasks=[],
            started_at=datetime.now(timezone.utc).isoformat(),
        )

    def add_task(self, spec: str, complexity: str, ide: str, model: str) -> TaskState:
        task = TaskState(
            id=len(self.tasks) + 1,
            spec=spec,
            complexity=complexity,
            ide=ide,
            model=model,
        )
        self.tasks.append(task)
        return task

    def current_task(self) -> Optional[TaskState]:
        for task in self.tasks:
            if task.status in (TaskStatus.PENDING, TaskStatus.IN_PROGRESS):
                return task
        return None

    def progress_summary(self) -> dict:
        counts = {"completed": 0, "in_progress": 0, "pending": 0, "skipped": 0, "failed": 0}
        for task in self.tasks:
            counts[task.status.value] = counts.get(task.status.value, 0) + 1
        counts["total"] = len(self.tasks)
        return counts

    def save(self, path: Path) -> None:
        data = {
            "goal": self.goal,
            "started_at": self.started_at,
            "paused": self.paused,
            "pause_reason": self.pause_reason,
            "total_claude_tokens": self.total_claude_tokens,
            "tasks": [
                {
                    "id": t.id,
                    "spec": t.spec,
                    "complexity": t.complexity,
                    "ide": t.ide,
                    "model": t.model,
                    "status": t.status.value,
                    "retries": t.retries,
                    "result": t.result,
                }
                for t in self.tasks
            ],
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, indent=2))

    @staticmethod
    def load(path: Path) -> Optional["SupervisorState"]:
        if not path.exists():
            return None
        data = json.loads(path.read_text())
        state = SupervisorState(
            goal=data["goal"],
            started_at=data["started_at"],
            paused=data.get("paused", False),
            pause_reason=data.get("pause_reason"),
            total_claude_tokens=data.get("total_claude_tokens", 0),
            tasks=[
                TaskState(
                    id=t["id"],
                    spec=t["spec"],
                    complexity=t["complexity"],
                    ide=t["ide"],
                    model=t["model"],
                    status=TaskStatus(t["status"]),
                    retries=t.get("retries", 0),
                    result=t.get("result"),
                )
                for t in data["tasks"]
            ],
        )
        return state
