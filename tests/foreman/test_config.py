
from foreman.config import SupervisorConfig


def test_default_config_has_windsurf_and_antigravity():
    config = SupervisorConfig.default()
    assert "windsurf" in config.ides
    assert "antigravity" in config.ides


def test_windsurf_has_kimi_and_swe15():
    config = SupervisorConfig.default()
    ws = config.ides["windsurf"]
    model_names = [m.name for m in ws.models]
    assert "kimi" in model_names
    assert "swe1.5" in model_names
    assert ws.default_model == "kimi"


def test_antigravity_has_gemini_models():
    config = SupervisorConfig.default()
    ag = config.ides["antigravity"]
    model_names = [m.name for m in ag.models]
    assert "gemini-3.1" in model_names
    assert "gemini-flash" in model_names
    assert ag.default_model == "gemini-3.1"


def test_windsurf_worktree_path():
    config = SupervisorConfig.default()
    assert config.ides["windsurf"].worktree == "~/CascadeProjects/dn-windsurf"


def test_antigravity_worktree_path():
    config = SupervisorConfig.default()
    assert config.ides["antigravity"].worktree == "~/CascadeProjects/dn-antigravity"


def test_config_state_file_path():
    config = SupervisorConfig.default()
    assert config.state_file == "~/.claude/foreman-state.json"


def test_config_learnings_file_path():
    config = SupervisorConfig.default()
    assert config.learnings_file == "~/.claude/foreman-learnings.json"


def test_cursor_ide_config():
    config = SupervisorConfig.default()
    assert "cursor" in config.ides
    cursor = config.ides["cursor"]
    assert cursor.process_name == "Cursor"
    assert cursor.bridge_type == "cursor"
