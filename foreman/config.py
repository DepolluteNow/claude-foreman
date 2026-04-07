from dataclasses import dataclass


@dataclass
class ModelInfo:
    name: str
    speed: str  # "fast", "medium", "slow"
    cost: str   # "free", "cheap", "expensive"


@dataclass
class IDEConfig:
    process_name: str
    worktree: str
    models: list[ModelInfo]
    default_model: str
    bridge_type: str  # "cascade" or "gemini"


@dataclass
class SupervisorConfig:
    ides: dict[str, IDEConfig]
    state_file: str = "~/.claude/foreman-state.json"
    learnings_file: str = "~/.claude/foreman-learnings.json"
    poll_interval: int = 15
    stability_polls: int = 2
    max_retries: int = 2
    takeover_max_lines: int = 50
    timeout_minutes: int = 10

    @staticmethod
    def default() -> "SupervisorConfig":
        return SupervisorConfig(
            ides={
                "windsurf": IDEConfig(
                    process_name="Windsurf",
                    worktree="~/CascadeProjects/dn-windsurf",
                    models=[
                        ModelInfo("kimi", "medium", "free"),
                        ModelInfo("swe1.5", "fast", "free"),
                    ],
                    default_model="kimi",
                    bridge_type="cascade",
                ),
                "antigravity": IDEConfig(
                    process_name="Antigravity",
                    worktree="~/CascadeProjects/dn-antigravity",
                    models=[
                        ModelInfo("gemini-3.1", "medium", "free"),
                        ModelInfo("gemini-flash", "fast", "free"),
                        ModelInfo("claude-sonnet-4.6", "medium", "cheap"),
                        ModelInfo("gpt-oss-120b", "medium", "free"),
                    ],
                    default_model="gemini-3.1",
                    bridge_type="gemini",
                ),
                "cursor": IDEConfig(
                    process_name="Cursor",
                    worktree="~/CascadeProjects/dn-cursor",
                    models=[
                        ModelInfo("cursor-small", "fast", "free"),
                        ModelInfo("gpt-4o", "medium", "cheap"),
                    ],
                    default_model="cursor-small",
                    bridge_type="cursor",
                ),
            }
        )
