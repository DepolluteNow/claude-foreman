"""Model switcher — changes the active model in an IDE via AppleScript."""

import subprocess
from pathlib import Path
from typing import Optional

from foreman.models import ModelInfo

APPLESCRIPT_DIR = Path(__file__).parent / "applescript"

# Bundle IDs for each IDE
BUNDLE_IDS = {
    "windsurf": "com.exafunction.windsurf",
    "antigravity": "com.google.antigravity",
    "cursor": "com.todesktop.230313mzl4w4u92",
}


def switch_model(ide: str, model: ModelInfo) -> bool:
    """Switch the active model in an IDE.

    Args:
        ide: The IDE name (windsurf, antigravity, cursor)
        model: The ModelInfo to switch to

    Returns:
        True if the switch was successful, False otherwise
    """
    bundle_id = BUNDLE_IDS.get(ide)
    if not bundle_id:
        print(f"Unknown IDE: {ide}")
        return False

    script_path = APPLESCRIPT_DIR / "select_model.scpt"
    if not script_path.exists():
        print(f"AppleScript not found: {script_path}")
        return False

    result = subprocess.run(
        ["osascript", str(script_path), bundle_id, model.name],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        print(f"Model switch failed: {result.stderr}")
        return False

    return "model_selected" in result.stdout


def switch_model_for_task(task_path: str, ide: str) -> Optional[ModelInfo]:
    """Analyze a task, recommend a model, and switch to it.

    Returns the selected ModelInfo or None on failure.
    """
    from foreman.models import recommend_for_task, format_recommendation

    analysis, model = recommend_for_task(task_path, ide)
    print(format_recommendation(analysis, model))

    if switch_model(ide, model):
        print(f"\n✅ Switched {ide} to {model.name}")
        return model
    else:
        print(f"\n⚠️ Could not auto-switch — manually select {model.name} in {ide}")
        return model  # Still return the recommendation
