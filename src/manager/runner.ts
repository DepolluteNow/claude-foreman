import { spawn } from "node:child_process";
import { config } from "../config.js";
import { parseRateLimit, RateLimitedError } from "../ratelimit.js";
import { scanOutput } from "../guard/secretscan.js";
import { resolveCoachBackend } from "./coach-backends.js";
import type { Store } from "../state/db.js";

/**
 * Invoke the current Coach backend (live-switchable from the dashboard —
 * Hermes, Claude Fable, or whatever MANAGER_CMD says in .env if never
 * touched) with a prompt on stdin and parse a JSON object from its output.
 * The Claude Code CLI with `--output-format json` wraps the answer in an
 * envelope `{ result: "..." }`; we unwrap that, strip code fences, and parse.
 */
export async function runManager<T>(prompt: string, store?: Store, onMetrics?: (usd: number, inT: number, outT: number) => void): Promise<T> {
  if (config.managerDisabled) {
    throw new ManagerUnavailableError("MANAGER_DISABLED=1");
  }
  // Callers without a Store (the not-yet-wired CoachDriver track, debug scripts)
  // keep the pre-existing behaviour: always config.managerCmd, no live switch.
  const coach = store
    ? resolveCoachBackend(store)
    : { key: "env-default", label: "env default (no store)", cmd: config.managerCmd, isEnvDefault: true };
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(coach.cmd, { shell: true, windowsHide: true });
    // Guard against EPIPE/EINVAL if the process dies before/while we write stdin.
    child.stdin.on("error", () => {});
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new ManagerUnavailableError(e.message)));
    child.on("close", (code) => {
      // A provider limit can surface on either stream and at any exit code.
      const rl = parseRateLimit(`${out}\n${err}`);
      if (rl.limited) {
        reject(new RateLimitedError(rl.reason, rl.resetAt));
        return;
      }
      if (code === 0) resolve(out);
      else
        reject(
          new Error(
            `manager (${coach.label}) exited with code ${code}; stderr: ${err.slice(0, 1000) || "<empty>"}; stdout: ${out.slice(0, 2000) || "<empty>"}`
          )
        );
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
  try {
    const scan = scanOutput(stdout);
    if (!scan.clean) {
      console.warn(`secret-scan: ${scan.findings.join("; ")} — redacted from manager output`);
    }
    return extractJson<T>(scan.redacted, onMetrics);
  } catch (e) {
    throw new Error(
      `manager output not parseable as JSON (${e}); len=${stdout.length}; tail: ${stdout.slice(-300)}`
    );
  }
}

export class ManagerUnavailableError extends Error {}

export function extractJson<T>(raw: string, onMetrics?: (usd: number, inT: number, outT: number) => void): T {
  let text = raw.trim();
  // Unwrap the Claude Code CLI JSON envelope if present
  try {
    const envelope = JSON.parse(text);
    if (envelope && typeof envelope === "object") {
      if (onMetrics) {
        const usd = typeof envelope.cost === "number" ? envelope.cost : (typeof envelope.costUsd === "number" ? envelope.costUsd : 0);
        const inT = typeof envelope.tokensIn === "number" ? envelope.tokensIn : 0;
        const outT = typeof envelope.tokensOut === "number" ? envelope.tokensOut : 0;
        onMetrics(usd, inT, outT);
      }
      if (typeof envelope.result === "string") {
        text = envelope.result.trim();
      } else {
        return envelope as T; // bare JSON answer
      }
    }
  } catch {
    /* not an envelope; fall through */
  }
  // Try, in order: the text as-is; fences stripped (greedy — the payload's own
  // strings may contain ``` sequences); the outermost {...} span.
  const candidates: string[] = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
