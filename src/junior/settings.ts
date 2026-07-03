/**
 * Live-switchable model + effort for the in-process junior (Claude-jr) —
 * same pattern as the Coach backend switch: a settings row read at spawn
 * time, so a dashboard change applies to the very next session, no restart.
 */
import { config } from "../config.js";
import type { Store } from "../state/db.js";

const MODEL_KEY = "junior_model";
const EFFORT_KEY = "junior_effort";

export interface JuniorModelOption {
  key: string;
  label: string;
}

/** Models the dashboard may pick for Claude-jr (key = value passed to `claude --model`). */
export const JUNIOR_MODELS: JuniorModelOption[] = [
  { key: "default", label: "CLI default" },
  { key: "claude-sonnet-5", label: "Sonnet 5" },
  { key: "claude-opus-4-8", label: "Opus 4.8" },
  { key: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

/** Effort = `--max-turns` ceiling for one junior session. */
export const JUNIOR_EFFORTS: JuniorModelOption[] = [
  { key: "default", label: "Default effort" },
  { key: "30", label: "Quick (30 turns)" },
  { key: "80", label: "Standard (80 turns)" },
  { key: "160", label: "Deep (160 turns)" },
];

export function getJuniorModel(store: Store): string {
  const v = store.getSetting(MODEL_KEY);
  return v && JUNIOR_MODELS.some((m) => m.key === v) ? v : "default";
}

export function getJuniorEffort(store: Store): string {
  const v = store.getSetting(EFFORT_KEY);
  return v && JUNIOR_EFFORTS.some((e) => e.key === v) ? v : "default";
}

export function setJuniorConfig(store: Store, model: string, effort: string): boolean {
  if (!JUNIOR_MODELS.some((m) => m.key === model)) return false;
  if (!JUNIOR_EFFORTS.some((e) => e.key === effort)) return false;
  store.setSetting(MODEL_KEY, model);
  store.setSetting(EFFORT_KEY, effort);
  return true;
}

/** Human line for the roster card, e.g. "Sonnet 5 · headless CLI". */
export function juniorModelLabel(store: Store): string {
  const m = getJuniorModel(store);
  const label = m === "default" ? "Claude (CLI default)" : (JUNIOR_MODELS.find((x) => x.key === m)?.label ?? m);
  return `${label} · headless CLI`;
}

/** The junior command with the live model/effort overrides applied. */
export function resolveJuniorCmd(store: Store): string {
  let cmd = config.juniorCmd;
  const model = getJuniorModel(store);
  if (model !== "default") {
    cmd = cmd.includes("--model")
      ? cmd.replace(/--model\s+\S+/, `--model ${model}`)
      : `${cmd} --model ${model}`;
  }
  const effort = getJuniorEffort(store);
  if (effort !== "default") {
    cmd = cmd.includes("--max-turns")
      ? cmd.replace(/--max-turns\s+\d+/, `--max-turns ${effort}`)
      : `${cmd} --max-turns ${effort}`;
  }
  return cmd;
}

/**
 * Per-fighter git identity: the author line on every commit names the fighter
 * and the model that wrote it (owner rule: know who wrote what at a glance).
 * The email keeps commits grouped under a distinct "agent" author on GitHub.
 */
export function juniorGitEnv(store: Store): Record<string, string> {
  const m = getJuniorModel(store);
  const label = m === "default" ? "Claude" : (JUNIOR_MODELS.find((x) => x.key === m)?.label ?? m);
  const name = `Claude-jr (${label})`;
  const email = "claude-jr@foreman.local";
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}
