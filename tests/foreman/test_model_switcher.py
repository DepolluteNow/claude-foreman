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
