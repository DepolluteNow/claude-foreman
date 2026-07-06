import { config } from "./config.js";
import { providerLabel, resetClock } from "./agentlimits.js";
import type { AgentStatusRow, Store, TaskRow } from "./state/db.js";
import type { RepoOption } from "./dashboard.js";

/**
 * The account-rotation handoff bundle.
 *
 * When the Claude account driving this work hits a rate limit, you switch to a
 * different account and need to resume without losing the thread. `/api/state`
 * already exposes the live fleet, but it does not capture *where the
 * conversation was* — the human/agent intent and the next intended step. This
 * module renders a single, copy-pasteable Markdown block that fuses both: the
 * saved "where we left off" note, a compact fleet snapshot, per-provider
 * rate-limit availability (so the new session knows who it can lean on right
 * now), the repository links, and the steps to pick the work back up.
 *
 * The "import" side is deliberately manual: you paste this block into a fresh
 * Claude Code session on the new account. No machine ingest needed.
 */

function relTime(ts: number, now: number): string {
  const mins = Math.round((now - ts) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} hour${h > 1 ? "s" : ""} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Emoji + short phrase per task status, for the snapshot list. */
function statusPhrase(t: TaskRow): string {
  switch (t.status) {
    case "queued":
      return "⏳ queued";
    case "dispatched":
      return "📨 dispatched — waiting for claim";
    case "claimed":
      return "🔧 in progress";
    case "in_review":
      return "🔎 in review";
    case "changes_requested":
      return "✏️ changes requested";
    case "approved":
      return config.autoMerge ? "✅ approved — auto-merging" : "✅ approved — awaiting your merge";
    case "merged_staging":
      return "🌿 merged to staging — awaiting main";
    case "done":
      return "✔️ done";
    case "failed":
      return "⛔ stuck — needs a human";
    case "stopped":
      return "⏹ stopped";
  }
}

/** One bullet per task, with PR link and any still-open revision points. */
function taskLine(store: Store, t: TaskRow): string {
  const title = t.title ?? `task #${t.issue}`;
  const agent = t.agent.charAt(0).toUpperCase() + t.agent.slice(1);
  const pr = t.pr ? ` — [PR #${t.pr}](https://github.com/${t.repo}/pull/${t.pr})` : "";
  let line = `- ${statusPhrase(t)} · #${t.issue} "${title}" · ${agent}${pr}`;
  const open = store.openRevisionPoints(t.repo, t.issue).map((p) => p.text);
  if (open.length) {
    line += `\n  - open fixes: ${open.join("; ")}`;
  }
  return line;
}

/**
 * Collapse per-agent status into per-provider availability. The manager and the
 * in-process Claude junior share one login, so they surface as a single
 * "Claude" line — which is exactly the unit you rotate accounts by.
 */
function providerAvailability(store: Store, now: number): string[] {
  const byProvider = new Map<string, AgentStatusRow>();
  for (const agent of [config.managerName, ...config.agents]) {
    const s = store.agentStatus(agent, now);
    const label = providerLabel(agent);
    const prev = byProvider.get(label);
    // A rate-limited reading wins, so a shared login reads as limited if any
    // of its agents is.
    if (!prev || (s.state === "rate_limited" && prev.state !== "rate_limited")) {
      byProvider.set(label, s);
    }
  }
  return [...byProvider.entries()].map(([label, s]) => {
    if (s.state === "rate_limited") {
      const until = s.reset_at ? ` until ${resetClock(s.reset_at)}` : "";
      const why = s.reason ? ` — ${s.reason}` : "";
      return `- ⏳ **${label}**: rate-limited${until}${why}`;
    }
    return `- ✅ **${label}**: available`;
  });
}

export interface HandoffOptions {
  /** Base URL of the running server, for the resume instructions. */
  baseUrl?: string;
  now?: number;
}

export function renderHandoff(store: Store, repos: RepoOption[], opts: HandoffOptions = {}): string {
  const now = opts.now ?? Date.now();
  const baseUrl = opts.baseUrl ?? "http://localhost:3000";
  const tasks = store.listTasks();
  const note = store.latestHandoffNote();

  const counts = {
    queued: tasks.filter((t) => t.status === "queued").length,
    working: tasks.filter((t) => ["claimed", "in_review", "changes_requested"].includes(t.status)).length,
    approved: tasks.filter((t) => t.status === "approved").length,
    done: tasks.filter((t) => t.status === "done").length,
    needsHuman: tasks.filter((t) => t.status === "failed").length,
  };

  const out: string[] = [];
  out.push(`# 🔁 Resume bundle — agent-manager`);
  out.push(
    `_Generated ${new Date(now).toISOString()}. Paste this whole block into a fresh ` +
      `Claude Code session on the new account, together with the repository, to pick the work back up._`
  );
  out.push("");

  // Where we left off — the part the fleet state can't infer.
  out.push(`## Where we left off`);
  if (note) {
    out.push(note.note.trim());
    out.push("");
    out.push(`_— ${note.author ?? "owner"}, ${relTime(note.created_at, now)}_`);
  } else {
    out.push(
      `_No handoff note saved. Write one from the dashboard ("Hand off to another account") ` +
        `before rotating, or rely on the fleet snapshot below and the repo's HANDOFF.md._`
    );
  }
  out.push("");

  // Repositories.
  out.push(`## Repositories`);
  if (config.projectRepoUrl) out.push(`- Project (this app): ${config.projectRepoUrl}`);
  const repoNames = [...new Set([...repos.map((r) => r.fullName), ...tasks.map((t) => t.repo)])];
  for (const r of repoNames) out.push(`- Managed: https://github.com/${r}`);
  if (repoNames.length === 0 && !config.projectRepoUrl) out.push(`_No repositories known yet._`);
  out.push("");

  // Fleet snapshot.
  out.push(
    `## Fleet snapshot (${counts.working} working · ${counts.queued} queued · ` +
      `${counts.approved} approved · ${counts.needsHuman} needs you · ${counts.done} done)`
  );
  const shown = tasks.filter((t) => t.status !== "done" && t.status !== "stopped");
  if (shown.length === 0) {
    out.push(`_No active work right now._`);
  } else {
    const byRepo = [...new Set(shown.map((t) => t.repo))];
    for (const repo of byRepo) {
      out.push(`### ${repo}`);
      for (const t of shown.filter((t) => t.repo === repo)) out.push(taskLine(store, t));
    }
  }
  out.push("");

  // Provider availability — who you can lean on right now.
  out.push(`## Agent availability`);
  out.push(...providerAvailability(store, now));
  out.push("");

  // How to resume.
  out.push(`## How to resume`);
  out.push(`1. \`git -C <repo> log --oneline -8\` — see what shipped.`);
  out.push(`2. \`npm run build && npx vitest run\` — confirm green before touching anything.`);
  out.push(`3. Read **HANDOFF.md** → "In flight" for the next intended step.`);
  out.push(`4. Live fleet state any time: \`curl ${baseUrl}/api/state\`.`);
  out.push(`5. After code changes: \`npm run build; Stop-ScheduledTask agent-manager; Start-ScheduledTask agent-manager\`.`);
  out.push("");

  return out.join("\n");
}
