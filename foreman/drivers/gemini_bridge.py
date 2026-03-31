import subprocess
from pathlib import Path
from typing import Optional

from foreman.bridge_interface import AIBridge, AIBridgeError, AIStatus

APPLESCRIPT_DIR = Path(__file__).parent / "applescript"


class GeminiBridge(AIBridge):
    def __init__(self):
        self._method = self._detect_method()

    def _detect_method(self) -> str:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "detect_ide.scpt")],
            capture_output=True,
            text=True,
        )
        ide = result.stdout.strip()
        if ide != "Antigravity":
            raise AIBridgeError(f"Antigravity not running (detected: {ide})")
        return "applescript"

    def send(self, prompt: str) -> None:
        self._applescript_send(prompt)

    def status(self) -> AIStatus:
        raw = self._applescript_status()
        return AIStatus(raw) if raw in ("idle", "generating", "waiting_input") else AIStatus.IDLE

    def read_output(self, lines: int = 50) -> str:
        return self._applescript_read()

    def accept_all(self) -> None:
        self._applescript_accept()

    def reject(self) -> None:
        self._applescript_reject()

    def recalibrate(self) -> None:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "antigravity_gemini.scpt"), "recalibrate"],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AIBridgeError(f"Recalibrate failed: {result.stderr}")

    def _applescript_send(self, prompt: str) -> None:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "antigravity_gemini.scpt"), "send", prompt],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AIBridgeError(f"Send failed: {result.stderr}")

    def _applescript_status(self) -> str:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "antigravity_gemini.scpt"), "status"],
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()

    def _applescript_read(self) -> str:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "antigravity_gemini.scpt"), "read"],
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()

    def _applescript_accept(self) -> None:
        subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "antigravity_gemini.scpt"), "accept"],
            capture_output=True,
            text=True,
        )

    def _applescript_reject(self) -> None:
        subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "antigravity_gemini.scpt"), "reject"],
            capture_output=True,
            text=True,
        )
