"""Smart model selection for IDE dispatching.

Analyzes task characteristics and recommends the best model
available in each IDE based on task type, complexity, and language.
"""

from dataclasses import dataclass


@dataclass
class ModelInfo:
    """Model metadata for selection."""
    name: str           # Display name in IDE dropdown
    ide: str            # windsurf | antigravity | cursor
    strengths: list     # e.g., ["typescript", "refactoring", "large-context"]
    weaknesses: list    # e.g., ["speed", "small-tasks"]
    cost: str           # "free" | "cheap" | "expensive"
    context_window: int # in tokens (approximate)
    speed: str          # "fast" | "medium" | "slow"


# ── Model Registry ────────────────────────────────────────
# Maps IDE -> list of available models
# Update this as IDEs add/remove models
MODEL_REGISTRY: dict[str, list[ModelInfo]] = {
    "windsurf": [
        ModelInfo("GPT-4.1", "windsurf", ["general", "reasoning", "typescript", "python"], ["speed"], "free", 128000, "medium"),
        ModelInfo("Claude 3.5 Sonnet", "windsurf", ["code-quality", "refactoring", "typescript", "documentation"], ["speed"], "free", 200000, "medium"),
        ModelInfo("Kimi K2", "windsurf", ["large-context", "speed", "general"], ["complex-reasoning"], "free", 128000, "fast"),
        ModelInfo("Gemini 2.5 Pro", "windsurf", ["reasoning", "large-context", "multi-file"], ["speed"], "free", 1000000, "slow"),
    ],
    "antigravity": [
        ModelInfo("Gemini 2.5 Pro", "antigravity", ["reasoning", "large-context", "multi-file", "typescript", "python"], ["speed"], "free", 1000000, "slow"),
        ModelInfo("Gemini 2.5 Flash", "antigravity", ["speed", "general", "small-tasks"], ["complex-reasoning"], "free", 1000000, "fast"),
    ],
    "cursor": [
        ModelInfo("GPT-4.1", "cursor", ["general", "reasoning", "typescript"], ["speed"], "free", 128000, "medium"),
        ModelInfo("Claude 3.5 Sonnet", "cursor", ["code-quality", "refactoring", "documentation"], ["speed"], "free", 200000, "medium"),
        ModelInfo("Claude Sonnet 4", "cursor", ["code-quality", "reasoning", "architecture"], ["speed"], "expensive", 200000, "medium"),
        ModelInfo("Gemini 2.5 Pro", "cursor", ["reasoning", "large-context"], ["speed"], "free", 1000000, "slow"),
    ],
}


@dataclass
class TaskAnalysis:
    """Result of analyzing a task file."""
    languages: list[str]        # Detected programming languages
    task_type: str              # "new-feature" | "refactor" | "bugfix" | "test" | "docs" | "config"
    complexity: str             # "simple" | "medium" | "complex"
    file_count: int             # Number of files to modify
    needs_large_context: bool   # Whether task involves many files or large diffs
    keywords: list[str]         # Extracted keywords for matching


def analyze_task(task_path: str) -> TaskAnalysis:
    """Analyze a task file to determine its characteristics.

    Reads the task markdown and extracts:
    - Programming languages from code blocks
    - Task type from title/content keywords
    - Complexity from number of steps/files
    - Whether large context is needed
    """
    with open(task_path, 'r') as f:
        content = f.read()

    # Detect languages from code blocks
    import re
    code_blocks = re.findall(r'```(\w+)', content)
    languages = list(set(code_blocks) - {'bash', 'markdown', 'md', 'json', 'yaml'})
    if not languages:
        languages = ['general']

    # Detect task type from keywords
    content_lower = content.lower()
    if any(w in content_lower for w in ['refactor', 'rename', 'move', 'extract', 'simplify']):
        task_type = 'refactor'
    elif any(w in content_lower for w in ['fix', 'bug', 'error', 'broken', 'crash']):
        task_type = 'bugfix'
    elif any(w in content_lower for w in ['test', 'spec', 'coverage', 'pytest', 'jest']):
        task_type = 'test'
    elif any(w in content_lower for w in ['doc', 'readme', 'comment', 'jsdoc']):
        task_type = 'docs'
    elif any(w in content_lower for w in ['config', 'setup', 'install', 'deploy', 'ci']):
        task_type = 'config'
    else:
        task_type = 'new-feature'

    # Count files to modify
    file_refs = re.findall(r'### File: `([^`]+)`', content)
    file_count = len(file_refs) if file_refs else 1

    # Estimate complexity
    step_count = len(re.findall(r'#### \d+', content))
    if step_count > 5 or file_count > 3:
        complexity = 'complex'
    elif step_count > 2 or file_count > 1:
        complexity = 'medium'
    else:
        complexity = 'simple'

    # Large context needed?
    needs_large_context = file_count > 3 or len(content) > 5000

    # Extract keywords
    keywords = languages + [task_type]
    if needs_large_context:
        keywords.append('large-context')

    return TaskAnalysis(
        languages=languages,
        task_type=task_type,
        complexity=complexity,
        file_count=file_count,
        needs_large_context=needs_large_context,
        keywords=keywords,
    )


def recommend_model(task: TaskAnalysis, ide: str) -> ModelInfo:
    """Recommend the best model for a task in a given IDE.

    Scoring algorithm:
    1. +2 for each keyword match in strengths
    2. -1 for each keyword match in weaknesses
    3. +1 for "fast" speed on simple tasks
    4. +1 for "large-context" strength when task needs it
    5. Prefer free models over expensive ones
    """
    models = MODEL_REGISTRY.get(ide, [])
    if not models:
        raise ValueError(f"No models registered for IDE: {ide}")

    scores: list[tuple[float, ModelInfo]] = []
    for model in models:
        score = 0.0

        # Keyword matching
        for kw in task.keywords:
            if kw in model.strengths:
                score += 2.0
            if kw in model.weaknesses:
                score -= 1.0

        # Speed bonus for simple tasks
        if task.complexity == 'simple' and model.speed == 'fast':
            score += 1.5
        elif task.complexity == 'complex' and 'reasoning' in model.strengths:
            score += 1.5

        # Large context bonus
        if task.needs_large_context and model.context_window >= 500000:
            score += 1.0

        # Cost preference
        if model.cost == 'free':
            score += 0.5
        elif model.cost == 'expensive':
            score -= 0.5

        # Refactoring bonus for Claude models
        if task.task_type == 'refactor' and 'refactoring' in model.strengths:
            score += 2.0

        scores.append((score, model))

    # Sort by score descending
    scores.sort(key=lambda x: x[0], reverse=True)
    return scores[0][1]


def recommend_for_task(task_path: str, ide: str) -> tuple[TaskAnalysis, ModelInfo]:
    """One-call convenience: analyze task and recommend model."""
    analysis = analyze_task(task_path)
    model = recommend_model(analysis, ide)
    return analysis, model


def format_recommendation(task: TaskAnalysis, model: ModelInfo) -> str:
    """Format a human-readable recommendation."""
    return (
        f"Task: {task.task_type} ({task.complexity}) — {', '.join(task.languages)}\n"
        f"Files: {task.file_count} | Large context: {task.needs_large_context}\n"
        f"Recommended: {model.name} ({model.ide})\n"
        f"  Strengths: {', '.join(model.strengths)}\n"
        f"  Speed: {model.speed} | Cost: {model.cost} | Context: {model.context_window:,}"
    )
