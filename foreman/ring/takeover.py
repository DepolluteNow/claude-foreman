import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class CircleType(Enum):
    SAME_REGION = "same_region"
    SAME_ERROR = "same_error"
    NET_ZERO = "net_zero"


HUNK_HEADER = re.compile(r"@@ -(\d+),?\d* \+(\d+),?\d* @@")


@dataclass
class AttemptRecord:
    changed_files: list[str]
    diff: str
    errors: list[str]
    hunks: list[tuple[int, int]]  # (start_line, start_line) from diff headers
    added_lines: set[str]
    removed_lines: set[str]


class CircleDetector:
    def __init__(self):
        self._history: list[AttemptRecord] = []

    def check(
        self,
        attempt: int,
        changed_files: list[str],
        diff: str,
        errors: list[str],
    ) -> Optional[CircleType]:
        hunks = [(int(m.group(1)), int(m.group(2))) for m in HUNK_HEADER.finditer(diff)]
        added = {line.lstrip("+ ").strip() for line in diff.split("\n") if line.startswith("+")}
        removed = {line.lstrip("- ").strip() for line in diff.split("\n") if line.startswith("-")}

        record = AttemptRecord(
            changed_files=changed_files,
            diff=diff,
            errors=errors,
            hunks=hunks,
            added_lines=added,
            removed_lines=removed,
        )

        if not self._history:
            self._history.append(record)
            return None

        prev = self._history[-1]
        self._history.append(record)

        # Check: same files AND same diff region
        if set(changed_files) == set(prev.changed_files) and hunks and prev.hunks:
            if any(h in prev.hunks for h in hunks):
                return CircleType.SAME_REGION

        # Check: same error signature
        if errors and prev.errors:
            prev_sigs = {self._error_signature(e) for e in prev.errors}
            curr_sigs = {self._error_signature(e) for e in errors}
            if prev_sigs & curr_sigs:
                return CircleType.SAME_ERROR

        # Check: net-zero (current adds what previous removed and vice versa)
        if added and removed and prev.added_lines and prev.removed_lines:
            if added & prev.removed_lines and removed & prev.added_lines:
                return CircleType.NET_ZERO

        return None

    def reset(self) -> None:
        self._history.clear()

    @staticmethod
    def _error_signature(error: str) -> str:
        match = re.match(r"(TS\d+|E\d+|SyntaxError|TypeError|ReferenceError)", error)
        return match.group(0) if match else error[:50]
