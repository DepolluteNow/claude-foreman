import json
import os
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional

from foreman.bridge_interface import AIBridge, AIBridgeError, AIStatus, PreFlightResult

APPLESCRIPT_DIR = Path(__file__).parent / "applescript"

# Foreman Bridge HTTP ports per IDE
BRIDGE_PORTS = {
    "windsurf": 19854,
    "antigravity": 19855,
    "cursor": 19856,
}

# Primary dispatch path: windsurf chat CLI
WINDSURF_CLI = Path("/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf")


class CascadeBridge(AIBridge):
    """Bridge to Windsurf's Cascade AI panel.

    Dispatch strategy (in priority order):
    1. ``windsurf chat`` CLI — reliable, no AppleScript fragility, supports
       ``--add-file`` for task context.  Used whenever ``worktree`` is provided.
    2. AppleScript clipboard method — fallback when the CLI is unavailable or
       no worktree is given.

    State reading always goes through the foreman-bridge HTTP extension
    (port 19854 by default) with AppleScript as a secondary fallback.
    """

    def __init__(self, ide_name: str = "windsurf"):
        self._ide = ide_name
        self._port = BRIDGE_PORTS.get(ide_name, 19854)
        self._http_available = self._check_http()
        self._cli_available = WINDSURF_CLI.exists()
        self._verify_ide_running()

    # ── Internal helpers ────────────────────────────────────────────

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
        if self._ide.lower() not in detected and not self._http_available:
            raise AIBridgeError(
                f"{self._ide} not running (detected: {detected})"
            )

    def _git_head(self, worktree: str) -> str:
        """Return the current HEAD hash for a worktree."""
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=worktree, capture_output=True, text=True,
        )
        return result.stdout.strip() if result.returncode == 0 else ""

    def _git_branch(self, worktree: str) -> str:
        """Return the current branch name for a worktree."""
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=worktree, capture_output=True, text=True,
        )
        return result.stdout.strip() if result.returncode == 0 else "?"

    # ── Dispatch ────────────────────────────────────────────────────

    def send(
        self,
        prompt: str,
        worktree: Optional[str] = None,
        task_file: Optional[str] = None,
    ) -> None:
        """Send a prompt to Cascade.

        Primary path: ``windsurf chat`` CLI when worktree is provided and the
        CLI exists.  This avoids every AppleScript failure mode documented in
        the skill (Failures 4, 5, 7, 11).

        Fallback: AppleScript clipboard injection (legacy).
        """
        if worktree and self._cli_available:
            self._send_via_windsurf_chat(prompt, worktree, task_file)
        else:
            self._send_via_applescript(prompt)

    def _send_via_windsurf_chat(
        self,
        prompt: str,
        worktree: str,
        task_file: Optional[str],
    ) -> None:
        """Dispatch via ``windsurf chat`` CLI (Failure-proof path)."""
        cmd = [
            str(WINDSURF_CLI), "chat", prompt,
            "--mode", "agent",
            "--reuse-window",
        ]
        if task_file:
            cmd += ["--add-file", task_file]
        cmd.append(worktree)

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            # CLI failed — fall back to AppleScript before raising
            try:
                self._send_via_applescript(prompt)
            except AIBridgeError:
                raise AIBridgeError(
                    f"windsurf chat failed ({result.stderr.strip()}) "
                    "and AppleScript fallback also failed"
                )

    def _send_via_applescript(self, prompt: str, mode: str = "continue") -> None:
        """Dispatch via AppleScript clipboard injection (legacy fallback).

        Pre-condition: Cascade panel must already be open and focused.
        Subject to Failures 4, 5, 7, 11 documented in the skill.
        """
        result = subprocess.run(
            ["osascript", str(APPLESCRIPT_DIR / "windsurf_cascade.scpt"),
             "send", prompt, mode],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise AIBridgeError(f"AppleScript send failed: {result.stderr}")

    def open_workspace(self, worktree: str) -> None:
        """Open worktree in a fresh Windsurf window.

        Using ``--new-window`` gives a clean slate with no stale tabs,
        eliminating the wrong-window dispatch failure mode.
        """
        if self._cli_available:
            subprocess.run(
                [str(WINDSURF_CLI), "--new-window", worktree],
                capture_output=True,
            )
        else:
            subprocess.run(["open", "-a", "Windsurf", worktree], capture_output=True)

    # ── Pre-flight ──────────────────────────────────────────────────

    def pre_flight_check(
        self,
        worktree: str,
        expected_branch: Optional[str] = None,
    ) -> PreFlightResult:
        """Phase 0: verify IDE state before dispatch.

        Checks:
        - The foreman-bridge HTTP extension is reachable and reports the
          correct workspace/branch (guards against Failure 4: wrong window).
        - The worktree is on the expected branch (or any branch if not given).
        - Records the current HEAD hash for use by the watcher.

        Returns a PreFlightResult.  Callers MUST check ``result.ready`` and
        fix any ``result.issues`` before proceeding to dispatch.
        """
        issues: list[str] = []

        # ── Local git checks ────────────────────────────────────────
        local_branch = self._git_branch(worktree)
        head = self._git_head(worktree)

        if not head:
            issues.append(f"Cannot read git HEAD in {worktree} — is it a git repo?")

        if expected_branch and local_branch != expected_branch:
            issues.append(
                f"Local branch '{local_branch}' ≠ expected '{expected_branch}'"
            )

        # ── HTTP bridge checks ──────────────────────────────────────
        bridge_branch = "(bridge unavailable)"
        if self._http_available:
            try:
                git_data = self._http_get("/git")
                bridge_branch = git_data.get("branch", "?")
                if bridge_branch == "(no workspace)":
                    issues.append(
                        "Bridge reports no workspace — IDE may be in Restricted Mode. "
                        "Grant trust (the blue 'Yes, I trust the authors' button) then retry."
                    )
                elif local_branch and bridge_branch != local_branch:
                    issues.append(
                        f"Bridge branch '{bridge_branch}' ≠ worktree branch '{local_branch}' "
                        "— IDE may have a different folder open (Failure 4)."
                    )
            except AIBridgeError as e:
                issues.append(f"Bridge HTTP error: {e}")
        else:
            issues.append(
                "foreman-bridge extension not responding — install it from "
                "extension/foreman-bridge/ for reliable monitoring."
            )

        return PreFlightResult(
            ready=len(issues) == 0,
            head=head,
            local_branch=local_branch,
            bridge_branch=bridge_branch,
            issues=issues,
        )

    # ── Status / reading ────────────────────────────────────────────

    def status(self) -> AIStatus:
        """Check IDE status — prefers HTTP bridge, falls back to AppleScript."""
        if self._http_available:
            try:
                import time
                data = self._http_get("/state")
                last_change = data.get("lastFileChangeTime", 0)
                if last_change and (time.time() * 1000 - last_change) < 30000:
                    return AIStatus.GENERATING
                return AIStatus.IDLE
            except AIBridgeError:
                pass
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

    # ── Change management ───────────────────────────────────────────

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
        self._cli_available = WINDSURF_CLI.exists()
