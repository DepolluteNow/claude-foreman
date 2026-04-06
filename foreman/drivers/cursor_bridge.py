import json
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional

from foreman.bridge_interface import AIBridge, AIBridgeError, AIStatus, PreFlightResult
from foreman.drivers.cascade_bridge import BRIDGE_PORTS

APPLESCRIPT_DIR = Path(__file__).parent / "applescript"


class CursorBridge(AIBridge):
    """Bridge to Cursor IDE's AI panel.

    Same layered approach as CascadeBridge:
    - HTTP (foreman-bridge extension) for reading state/output/diagnostics
    - AppleScript for sending prompts
    """

    def __init__(self, ide_name: str = "cursor"):
        self._ide = ide_name
        self._port = BRIDGE_PORTS.get(ide_name, 19856)
        self._http_available = self._check_http()
        self._verify_ide_running()

    def _check_http(self) -> bool:
        try:
            resp = urllib.request.urlopen(
                f"http://127.0.0.1:{self._port}/status", timeout=2
            )
            data = json.loads(resp.read())
            return data.get("bridge") == "foreman-bridge"
        except (urllib.error.URLError, OSError, json.JSONDecodeError):
            return False

    def _http_get(self, endpoint: str) -> dict:
        try:
            resp = urllib.request.urlopen(
                f"http://127.0.0.1:{self._port}{endpoint}", timeout=5
            )
            return json.loads(resp.read())
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
            raise AIBridgeError(f"Bridge HTTP error on {endpoint}: {e}")

    def _verify_ide_running(self) -> None:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "detect_ide.scpt")],
            capture_output=True, text=True,
        )
        detected = result.stdout.strip().lower()
        if "cursor" not in detected and not self._http_available:
            raise AIBridgeError(f"Cursor not running (detected: {detected})")

    def send(
        self,
        prompt: str,
        worktree: Optional[str] = None,
        task_file: Optional[str] = None,
    ) -> None:
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "cursor_composer.scpt"),
             "send", prompt],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise AIBridgeError(f"Send failed: {result.stderr}")

    def open_workspace(self, worktree: str) -> None:
        subprocess.run(["open", "-a", "Cursor", worktree], capture_output=True)

    def pre_flight_check(
        self,
        worktree: str,
        expected_branch: Optional[str] = None,
    ) -> PreFlightResult:
        issues: list[str] = []
        git_branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=worktree, capture_output=True, text=True,
        )
        local_branch = git_branch.stdout.strip() if git_branch.returncode == 0 else "?"
        head_result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=worktree, capture_output=True, text=True,
        )
        head = head_result.stdout.strip() if head_result.returncode == 0 else ""
        bridge_branch = "(bridge unavailable)"
        if self._http_available:
            try:
                bridge_branch = self._http_get("/git").get("branch", "?")
                if bridge_branch == "(no workspace)":
                    issues.append("Bridge reports no workspace — Cursor may be in Restricted Mode.")
            except AIBridgeError as e:
                issues.append(f"Bridge HTTP error: {e}")
        if expected_branch and local_branch != expected_branch:
            issues.append(f"Local branch '{local_branch}' ≠ expected '{expected_branch}'")
        return PreFlightResult(
            ready=len(issues) == 0,
            head=head,
            local_branch=local_branch,
            bridge_branch=bridge_branch,
            issues=issues,
        )

    def status(self) -> AIStatus:
        if self._http_available:
            try:
                data = self._http_get("/state")
                last_change = data.get("lastFileChangeTime", 0)
                import time
                if last_change and (time.time() * 1000 - last_change) < 30000:
                    return AIStatus.GENERATING
                return AIStatus.IDLE
            except AIBridgeError:
                pass
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "cursor_composer.scpt"), "status"],
            capture_output=True, text=True,
        )
        raw = result.stdout.strip()
        return AIStatus(raw) if raw in ("idle", "generating", "waiting_input") else AIStatus.IDLE

    def read_output(self, lines: int = 50) -> str:
        if self._http_available:
            try:
                data = self._http_get("/output")
                output_lines = data.get("lines", [])
                return "\n".join(output_lines[-lines:])
            except AIBridgeError:
                pass
        return "(bridge not available — install foreman-bridge extension)"

    def read_diagnostics(self) -> dict:
        if self._http_available:
            return self._http_get("/diagnostics")
        return {"errors": [], "warnings": [], "total": 0}

    def read_state(self) -> dict:
        if self._http_available:
            return self._http_get("/state")
        return {}

    def accept_all(self) -> None:
        subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "cursor_composer.scpt"), "accept"],
            capture_output=True, text=True,
        )

    def reject(self) -> None:
        subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "cursor_composer.scpt"), "reject"],
            capture_output=True, text=True,
        )

    def recalibrate(self) -> None:
        self._http_available = self._check_http()
