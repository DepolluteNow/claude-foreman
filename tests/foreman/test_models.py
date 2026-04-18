"""Tests for the smart model selection system."""

import pytest
from foreman.models import (
    analyze_task,
    recommend_model,
    recommend_for_task,
    format_recommendation,
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
