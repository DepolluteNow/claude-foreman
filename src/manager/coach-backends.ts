import { config } from "../config.js";
import type { Store } from "../state/db.js";

/** A shell command the manager can spawn to act as Coach, given a prompt on stdin and JSON expected on stdout. */
export interface CoachBackend {
  key: string;
  label: string;
  cmd: string;
}

const SETTING_KEY = "coach_backend";
/** Sentinel meaning "no live override — use whatever MANAGER_CMD says in .env". */
export const ENV_DEFAULT_KEY = "env-default";

/**
 * Known, ready-to-run Coach backends the dashboard can switch between live,
 * with no restart. Add an entry here (plus the underlying script/binary) to
 * make a new backend selectable.
 */
export const COACH_BACKENDS: CoachBackend[] = [
  { key: "hermes", label: "Hermes Agent (local, free)", cmd: "./scripts/hermes-agent-manager.sh" },
  { key: "claude", label: "Claude Fable (headless Claude Code)", cmd: 'claude -p --output-format json --tools "" --max-turns 1' },
];

export interface ResolvedCoach extends CoachBackend {
  isEnvDefault: boolean;
}

/** The Coach backend actually in effect right now: the dashboard's live pick, or the .env default if never touched. */
export function resolveCoachBackend(store: Store): ResolvedCoach {
  const chosen = store.getSetting(SETTING_KEY);
  const backend = chosen ? COACH_BACKENDS.find((b) => b.key === chosen) : undefined;
  if (backend) return { ...backend, isEnvDefault: false };
  return { key: ENV_DEFAULT_KEY, label: "Current .env default", cmd: config.managerCmd, isEnvDefault: true };
}

/** Set the live Coach backend. Pass ENV_DEFAULT_KEY to revert to MANAGER_CMD from .env. */
export function setCoachBackend(store: Store, key: string): void {
  store.setSetting(SETTING_KEY, key);
}

/** Is `key` a value the dashboard's dropdown may legally submit? */
export function isValidCoachKey(key: string): boolean {
  return key === ENV_DEFAULT_KEY || COACH_BACKENDS.some((b) => b.key === key);
}
