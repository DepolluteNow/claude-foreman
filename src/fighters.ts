/**
 * The roster — who the fighters are, what model drives each one, and whether
 * they're actually reachable right now. "Available" is never fabricated: it
 * only shows after a real successful ping of the fighter's binary or API
 * (owner rule, epic #182).
 */
import { execFile } from "node:child_process";
import { config } from "./config.js";

export interface FighterMeta {
  agent: string;
  /** Human name on the card. */
  label: string;
  /** Model line shown under the name, e.g. "GLM-5.2 · local CLI". */
  model: string;
  /** How to check availability; null = honestly not pingable (GUI puppets). */
  ping: (() => Promise<PingResult>) | null;
}

export interface PingResult {
  ok: boolean;
  detail: string;
}

const PING_TIMEOUT_MS = 5_000;

function execPing(bin: string, args: string[]): Promise<PingResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: PING_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, detail: (stderr || err.message).slice(0, 120) });
      else resolve({ ok: true, detail: stdout.trim().split("\n")[0].slice(0, 120) });
    });
  });
}

async function httpPing(url: string, describe: (body: string) => string): Promise<PingResult> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    return { ok: true, detail: describe(await res.text()) };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : "unreachable" };
  }
}

/** Known fighters. Agents in config but not listed here get a generic entry. */
const KNOWN: Record<string, Omit<FighterMeta, "agent">> = {
  "devin-local": {
    label: "Devin",
    model: "GLM-5.2 · local CLI",
    ping: () => execPing("devin", ["version"]),
  },
  devin: {
    label: "Devin (cloud)",
    model: "GLM-5.2 · Devin cloud",
    ping: null, // cloud API ping needs a token round-trip; wired in epic #182
  },
  ollama: {
    label: "Ollama",
    model: `${process.env.OLLAMA_MODEL?.replace(/"/g, "") || "local model"} · local`,
    ping: () =>
      httpPing("http://localhost:11434/api/tags", (body) => {
        try {
          const n = (JSON.parse(body).models ?? []).length;
          return `${n} model${n === 1 ? "" : "s"} loaded`;
        } catch {
          return "responding";
        }
      }),
  },
  claude: {
    label: "Claude-jr",
    model: "Claude · headless CLI",
    ping: () => execPing("claude", ["--version"]),
  },
  "claude-jr": {
    label: "Claude-jr",
    model: "Claude · headless CLI",
    ping: () => execPing("claude", ["--version"]),
  },
  "windsurf-kimi": {
    label: "Windsurf-kimi",
    model: "Kimi · GUI puppet",
    ping: null, // drives a GUI IDE; there is nothing honest to ping
  },
  hermes: {
    label: "Hermes",
    model: "glm-5.2 via custom:devin",
    ping: () => execPing(`${process.env.HOME}/.local/bin/hermes`, ["--version"]),
  },
  antigravity: {
    label: "Antigravity",
    model: "Gemini · IDE agent",
    ping: null, // adapter lands with epic #182
  },
};

export function rosterFor(agents: string[]): FighterMeta[] {
  return agents.map((a) => {
    const known = KNOWN[a];
    if (known) return { agent: a, ...known };
    return { agent: a, label: a.charAt(0).toUpperCase() + a.slice(1), model: "custom", ping: null };
  });
}

export function fighterMeta(agent: string): FighterMeta | undefined {
  return rosterFor(config.agents).find((f) => f.agent === agent);
}

/** Live availability check. Never invents: unpingable fighters say so. */
export async function pingFighter(agent: string): Promise<PingResult & { pingable: boolean }> {
  const meta = fighterMeta(agent);
  if (!meta) return { pingable: false, ok: false, detail: "unknown fighter" };
  if (!meta.ping) return { pingable: false, ok: false, detail: "not pingable (no CLI/API to check)" };
  const res = await meta.ping();
  return { pingable: true, ...res };
}
