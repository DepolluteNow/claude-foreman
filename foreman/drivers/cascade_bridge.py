import json
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional

from foreman.bridge_interface import AIBridge, AIBridgeError, AIStatus

APPLESCRIPT_DIR = Path(__file__).parent / "applescript"

# Foreman Bridge HTTP ports per IDE
BRIDGE_PORTS = {
    "windsurf": 19854,
    "antigravity": 19855,
    "cursor": 19856,
}


class CascadeBridge(AIBridge):
    """Bridge to Windsurf's Cascade AI panel.

    Uses a layered approach:
    - HTTP (foreman-bridge extension) for reading state/output/diagnostics
    - AppleScript for sending prompts (no API for writing to Cascade)
    """

    def __init__(self, ide_name: str = "windsurf"):
        self._ide = ide_name
        self._port = BRIDGE_PORTS.get(ide_name, 19854)
        self._http_available = self._check_http()
        self._verify_ide_running()

    def _check_http(self) -> bool:
        """Check if the foreman-bridge extension is responding."""
        try:
            resp = urllib.request.urlopen(
                f"http://127.0.0.1:{self._port}/status", timeout=2
            )
            data = json.loads(resp.read())
            return data.get("bridge") == "foreman-bridge"
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            return False

    def _http_get(self, endpoint: str) -> dict:
        """GET a JSON endpoint from the foreman-bridge extension."""
        try:
            resp = urllib.request.urlopen(
                f"http://127.0.0.1:{self._port}{endpoint}", timeout=5
            )
            return json.loads(resp.read())
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
            raise AIBridgeError(f"Bridge HTTP error on {endpoint}: {e}")

    def _verify_ide_running(self) -> None:
        """Verify the target IDE is running via AppleScript."""
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "detect_ide.scpt")],
            capture_output=True, text=True,
        )
        detected = result.stdout.strip().lower()
        expected = self._ide.lower()
        # Accept if IDE is running OR if HTTP bridge is already responding
        if expected not in detected.lower() and not self._http_available:
            raise AIBridgeError(
                f"{self._ide} not running (detected: {detected})"
            )

    def send(self, prompt: str, mode: str = "continue") -> None:
        """Send a prompt to Cascade via AppleScript.

        Args:
            prompt: The text to send
            mode: "continue" (existing chat) or "new" (fresh window)
        """
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "windsurf_cascade.scpt"),
             "send", prompt, mode],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise AIBridgeError(f"Send failed: {result.stderr}")

    def status(self) -> AIStatus:
        """Check IDE status — prefers HTTP bridge, falls back to AppleScript."""
        if self._http_available:
            try:
                data = self._http_get("/state")
                # If files changed recently (last 30s), model is likely busy
                last_change = data.get("lastFileChangeTime", 0)
                import time
                if last_change and (time.time() * 1000 - last_change) < 30000:
                    return AIStatus.GENERATING
                return AIStatus.IDLE
            except AIBridgeError:
                pass
        # Fallback to AppleScript
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "windsurf_cascade.scpt"), "status"],
            capture_output=True, text=True,
        )
        raw = result.stdout.strip()
        return AIStatus(raw) if raw in ("idle", "generating", "waiting_input") else AIStatus.IDLE

    def read_output(self, lines: int = 50) -> str:
        """Read terminal output via HTTP bridge."""
        if self._http_available:
            try:
                data = self._http_get("/output")
                output_lines = data.get("lines", [])
                return "\n".join(output_lines[-lines:])
            except AIBridgeError:
                pass
        return "(bridge not available — install foreman-bridge extension)"

    def read_diagnostics(self) -> dict:
        """Read TypeScript/lint errors via HTTP bridge."""
        if self._http_available:
            return self._http_get("/diagnostics")
        return {"errors": [], "warnings": [], "total": 0}

    def read_state(self) -> dict:
        """Read full bridge state via HTTP."""
        if self._http_available:
            return self._http_get("/state")
        return {}

    def accept_all(self) -> None:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "windsurf_cascade.scpt"), "accept"],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise AIBridgeError(f"Accept failed: {result.stderr}")

    def reject(self) -> None:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "windsurf_cascade.scpt"), "reject"],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise AIBridgeError(f"Reject failed: {result.stderr}")

    def recalibrate(self) -> None:
        """Re-check HTTP bridge availability."""
        self._http_available = self._check_http()
