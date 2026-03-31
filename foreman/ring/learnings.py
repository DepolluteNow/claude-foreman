import json
from copy import deepcopy
from pathlib import Path
from typing import Optional

from foreman.ring.state import SupervisorState, TaskStatus


DEFAULT_LEARNINGS = {
    "version": 1,
    "first_try_rate_history": [],
    "patterns": {"always": [], "never": []},
    "model_performance": {},
    "templates": {},
    "regressions_reverted": [],
}


class Learnings:
    def __init__(self, path: Path):
        self.path = Path(path)

    def load(self) -> dict:
        if not self.path.exists():
            return deepcopy(DEFAULT_LEARNINGS)
        return json.loads(self.path.read_text())

    def save(self, data: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, indent=2))

    def record_retrospective(self, state: SupervisorState) -> None:
        data = self.load()
        previous_patterns = deepcopy(data.get("patterns", {"always": [], "never": []}))

        # Calculate first-try rate
        completed = [t for t in state.tasks if t.status == TaskStatus.COMPLETED]
        if not completed:
            return

        clean_first_try = sum(1 for t in completed if t.result == "clean" and t.retries == 0)
        first_try_rate = clean_first_try / len(completed)
        data["first_try_rate_history"].append(round(first_try_rate, 3))

        # Update model performance
        perf = data.get("model_performance", {})
        for task in completed:
            model = task.model
            complexity = task.complexity
            if model not in perf:
                perf[model] = {}
            success = 1.0 if task.result == "clean" and task.retries == 0 else 0.0
            old = perf[model].get(complexity)
            if old is not None:
                # Exponential moving average
                perf[model][complexity] = round(0.7 * old + 0.3 * success, 3)
            else:
                perf[model][complexity] = success
        data["model_performance"] = perf

        # Regression guard: if first_try_rate dropped, revert patterns
        history = data["first_try_rate_history"]
        if len(history) >= 2 and history[-1] < history[-2]:
            data["patterns"] = previous_patterns
            data["regressions_reverted"].append(
                f"v{data['version']}: first_try_rate dropped from "
                f"{history[-2]} to {history[-1]}. Patterns reverted."
            )

        data["version"] += 1
        self.save(data)
