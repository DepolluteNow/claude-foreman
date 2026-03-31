import re
from dataclasses import dataclass
from typing import Optional
from foreman.config import SupervisorConfig


@dataclass
class TaskClassification:
    complexity: str  # "trivial", "standard", "complex", "codebase_specific"
    ide: str
    model: str


# Keywords that signal each complexity level
TRIVIAL_PATTERNS = [
    r"\brename\b", r"\bmove\b", r"\badd import\b", r"\bboilerplate\b",
    r"\bdelete\b", r"\bremove unused\b",
]
COMPLEX_PATTERNS = [
    r"\brefactor\b", r"\bmigrate\b", r"\bredesign\b", r"\brewrite\b",
    r"\brestructure\b",
]
CODEBASE_PATTERNS = [
    r"\bcollection\b", r"\bhook\b", r"\bblock\b", r"\bpayload\b",
    r"\bcorsair\b", r"\b\.windsurfrules\b", r"\bglobal\b",
]

# Heuristic: count file paths mentioned (src/..., tests/...)
FILE_PATH_PATTERN = re.compile(r"(?:src|tests|lib|app|components|collections)/[\w/.-]+\.\w+")

# Default routing table
DEFAULT_ROUTES = {
    "trivial": ("windsurf", "swe1.5"),
    "standard": ("windsurf", "kimi"),
    "complex": ("antigravity", "gemini-3.1"),
    "codebase_specific": ("windsurf", "kimi"),
}


class TaskRouter:
    def __init__(self, config: SupervisorConfig):
        self.config = config

    def classify(
        self,
        spec: str,
        model_performance: Optional[dict] = None,
    ) -> TaskClassification:
        complexity = self._classify_complexity(spec)
        ide, model = DEFAULT_ROUTES[complexity]

        if model_performance:
            ide, model = self._adaptive_route(complexity, model_performance)

        return TaskClassification(complexity=complexity, ide=ide, model=model)

    def _classify_complexity(self, spec: str) -> str:
        spec_lower = spec.lower()

        # Check codebase-specific first (highest priority)
        for pattern in CODEBASE_PATTERNS:
            if re.search(pattern, spec_lower):
                return "codebase_specific"

        # Check complex patterns
        for pattern in COMPLEX_PATTERNS:
            if re.search(pattern, spec_lower):
                return "complex"

        # Check file count (3+ files = complex)
        files = FILE_PATH_PATTERN.findall(spec)
        if len(files) >= 3:
            return "complex"

        # Check trivial patterns
        for pattern in TRIVIAL_PATTERNS:
            if re.search(pattern, spec_lower):
                return "trivial"

        # Default to standard
        return "standard"

    def _adaptive_route(
        self,
        complexity: str,
        model_performance: dict,
    ) -> tuple[str, str]:
        best_model = None
        best_score = -1.0

        for model_name, scores in model_performance.items():
            score = scores.get(complexity, 0.0)
            if score > best_score:
                best_score = score
                best_model = model_name

        if best_model is None:
            return DEFAULT_ROUTES[complexity]

        # Find which IDE has this model
        for ide_name, ide_config in self.config.ides.items():
            for m in ide_config.models:
                if m.name == best_model:
                    return ide_name, best_model

        return DEFAULT_ROUTES[complexity]
