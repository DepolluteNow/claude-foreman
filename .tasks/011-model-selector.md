# Task 11: Smart Model Selection for IDE Dispatching

## What to do

Add a model selection system to Claude Foreman that analyzes tasks and recommends the best model for each IDE before dispatching. The system should also be able to switch models in the IDE via AppleScript.

### File: `foreman/models.py` (NEW)

Create a model registry and task analyzer:

```python
"""Smart model selection for IDE dispatching.

Analyzes task characteristics and recommends the best model
available in each IDE based on task type, complexity, and language.
"""

from dataclasses import dataclass
from typing import Optional


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
    needs_large_context = file_count > 5 or len(content) > 5000

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
```

### File: `foreman/drivers/applescript/select_model.scpt` (NEW)

Create an AppleScript that opens the model selector dropdown in Cascade and types the model name:

```applescript
-- select_model.scpt
-- Usage: osascript select_model.scpt <bundle_id> <model_name>
-- Selects a model in Windsurf/Antigravity/Cursor Cascade panel

on run argv
    set bundleID to item 1 of argv
    set modelName to item 2 of argv

    tell application "System Events"
        tell (first process whose bundle identifier is bundleID)
            set frontmost to true
            delay 0.3

            -- The model selector in Cascade is typically a dropdown at the top
            -- We use the Command Palette approach: search for "model" settings
            -- This is more reliable than trying to click UI elements directly

            -- Method: Use the model selector button in Cascade panel
            -- Windsurf/Antigravity: Click the model name text in Cascade header
            -- Then type to filter and press Enter

            -- Open command palette
            keystroke "p" using {command down, shift down}
            delay 0.5

            -- Type the model change command
            set the clipboard to ">Change Model"
            keystroke "v" using command down
            delay 0.5
            key code 36 -- Enter
            delay 0.5

            -- Type the model name to filter the list
            set the clipboard to modelName
            keystroke "v" using command down
            delay 0.3
            key code 36 -- Enter

        end tell
    end tell

    return "model_selected: " & modelName
end run
```

### File: `foreman/drivers/model_switcher.py` (NEW)

Create a Python wrapper for model switching:

```python
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
```

### File: `tests/foreman/test_models.py` (NEW)

```python
"""Tests for the smart model selection system."""

import pytest
import os
import tempfile
from foreman.models import (
    analyze_task,
    recommend_model,
    recommend_for_task,
    format_recommendation,
    TaskAnalysis,
    ModelInfo,
    MODEL_REGISTRY,
)


@pytest.fixture
def simple_ts_task(tmp_path):
    """A simple TypeScript task file."""
    task = tmp_path / "task.md"
    task.write_text("""# Task: Add a health check

## What to do

### File: `src/health.ts`

#### 1. Add health endpoint

```typescript
export function healthCheck() {
    return { ok: true };
}
```

### Build and verify

```bash
npm run compile
```
""")
    return str(task)


@pytest.fixture
def complex_refactor_task(tmp_path):
    """A complex multi-file refactoring task."""
    task = tmp_path / "task.md"
    task.write_text("""# Task: Refactor authentication module

## What to do

Major refactoring of the auth system across multiple files.

### File: `src/auth/manager.ts`

#### 1. Extract token validation

```typescript
class TokenValidator { }
```

#### 2. Extract session handling

```typescript
class SessionManager { }
```

#### 3. Extract middleware

```typescript
function authMiddleware() { }
```

### File: `src/auth/tokens.ts`

#### 4. Move token types

```typescript
interface TokenPayload { }
```

### File: `src/auth/sessions.ts`

#### 5. Move session types

```typescript
interface Session { }
```

### File: `src/auth/middleware.ts`

#### 6. Move middleware

```typescript
export const protect = authMiddleware;
```

### Build and verify

```bash
npm run compile
npm test
```
""")
    return str(task)


@pytest.fixture
def python_bugfix_task(tmp_path):
    """A Python bugfix task."""
    task = tmp_path / "task.md"
    task.write_text("""# Task: Fix bridge connection error

## What to do

### File: `foreman/drivers/cascade_bridge.py`

#### 1. Fix timeout bug

The HTTP connection times out because the error handler swallows the exception.

```python
def _check_http(self) -> bool:
    try:
        resp = urllib.request.urlopen(url, timeout=5)
        return True
    except Exception as e:
        logger.warning(f"Bridge check failed: {e}")
        return False
```

### Build and verify

```bash
pytest tests/
```
""")
    return str(task)


def test_analyze_simple_ts(simple_ts_task):
    result = analyze_task(simple_ts_task)
    assert 'typescript' in result.languages
    assert result.task_type == 'new-feature'
    assert result.complexity == 'simple'
    assert result.file_count == 1
    assert not result.needs_large_context


def test_analyze_complex_refactor(complex_refactor_task):
    result = analyze_task(complex_refactor_task)
    assert 'typescript' in result.languages
    assert result.task_type == 'refactor'
    assert result.complexity == 'complex'
    assert result.file_count == 4
    assert result.needs_large_context


def test_analyze_python_bugfix(python_bugfix_task):
    result = analyze_task(python_bugfix_task)
    assert 'python' in result.languages
    assert result.task_type == 'bugfix'
    assert result.complexity == 'simple'
    assert result.file_count == 1


def test_recommend_windsurf_simple_ts(simple_ts_task):
    analysis = analyze_task(simple_ts_task)
    model = recommend_model(analysis, 'windsurf')
    assert model.ide == 'windsurf'
    assert model.name  # Got a recommendation


def test_recommend_windsurf_complex_refactor(complex_refactor_task):
    analysis = analyze_task(complex_refactor_task)
    model = recommend_model(analysis, 'windsurf')
    # Should prefer Claude for refactoring
    assert 'refactoring' in model.strengths or 'reasoning' in model.strengths


def test_recommend_antigravity(simple_ts_task):
    analysis = analyze_task(simple_ts_task)
    model = recommend_model(analysis, 'antigravity')
    assert model.ide == 'antigravity'


def test_recommend_cursor(complex_refactor_task):
    analysis = analyze_task(complex_refactor_task)
    model = recommend_model(analysis, 'cursor')
    assert model.ide == 'cursor'


def test_recommend_unknown_ide(simple_ts_task):
    analysis = analyze_task(simple_ts_task)
    with pytest.raises(ValueError, match="No models registered"):
        recommend_model(analysis, 'unknown-ide')


def test_format_recommendation(simple_ts_task):
    analysis, model = recommend_for_task(simple_ts_task, 'windsurf')
    text = format_recommendation(analysis, model)
    assert 'Recommended:' in text
    assert model.name in text
    assert 'typescript' in text


def test_model_registry_has_all_ides():
    assert 'windsurf' in MODEL_REGISTRY
    assert 'antigravity' in MODEL_REGISTRY
    assert 'cursor' in MODEL_REGISTRY


def test_all_models_have_required_fields():
    for ide, models in MODEL_REGISTRY.items():
        for model in models:
            assert model.name
            assert model.ide == ide
            assert model.cost in ('free', 'cheap', 'expensive')
            assert model.speed in ('fast', 'medium', 'slow')
            assert model.context_window > 0


def test_free_models_preferred_over_expensive(simple_ts_task):
    """Free models should generally score higher for simple tasks."""
    analysis = analyze_task(simple_ts_task)
    model = recommend_model(analysis, 'cursor')
    # For a simple task, should not pick the expensive model
    assert model.cost != 'expensive'
```

### File: `tests/foreman/test_model_switcher.py` (NEW)

```python
"""Tests for the model switcher."""

import pytest
from unittest.mock import patch, MagicMock
from foreman.drivers.model_switcher import switch_model, switch_model_for_task
from foreman.models import ModelInfo


@pytest.fixture
def sample_model():
    return ModelInfo(
        name="GPT-4.1",
        ide="windsurf",
        strengths=["general"],
        weaknesses=[],
        cost="free",
        context_window=128000,
        speed="medium",
    )


def test_switch_model_calls_applescript(sample_model):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(
            returncode=0,
            stdout="model_selected: GPT-4.1",
            stderr="",
        )
        result = switch_model("windsurf", sample_model)
        assert result is True
        assert mock.called
        args = mock.call_args[0][0]
        assert "osascript" in args[0]
        assert "com.exafunction.windsurf" in args


def test_switch_model_unknown_ide(sample_model):
    result = switch_model("unknown-ide", sample_model)
    assert result is False


def test_switch_model_failure(sample_model):
    with patch("subprocess.run") as mock:
        mock.return_value = MagicMock(
            returncode=1,
            stdout="",
            stderr="error",
        )
        result = switch_model("windsurf", sample_model)
        assert result is False


def test_switch_model_for_task(tmp_path):
    task = tmp_path / "task.md"
    task.write_text("""# Simple task

### File: `src/index.ts`

#### 1. Add function

```typescript
function hello() {}
```
""")
    with patch("foreman.drivers.model_switcher.switch_model", return_value=True):
        model = switch_model_for_task(str(task), "windsurf")
        assert model is not None
        assert model.name
```

### Build and verify

```bash
cd /Users/hayssamhoballah/CascadeProjects/claude-foreman
python -m pytest tests/foreman/test_models.py tests/foreman/test_model_switcher.py -v
# All tests should pass
```

## Commit

```bash
git add foreman/models.py foreman/drivers/model_switcher.py foreman/drivers/applescript/select_model.scpt tests/foreman/test_models.py tests/foreman/test_model_switcher.py
git commit -m "feat: smart model selection — analyze tasks and recommend best model per IDE"
```
