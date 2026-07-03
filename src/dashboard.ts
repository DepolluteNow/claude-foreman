import { config } from "./config.js";
import { forecastRunCost } from "./cost-forecast.js";
import type { CommentRow, JobRow, RevisionPointRow, Store, TaskRow } from "./state/db.js";
import { taskBranch } from "./protocol/labels.js";
import type { BranchState, CiState, ThreadOverview, ThreadSummary } from "./threads.js";
import type { TrustTier } from "./referee/readiness.js";
import { COACH_BACKENDS, ENV_DEFAULT_KEY, resolveCoachBackend } from "./manager/coach-backends.js";
import { ringPanel } from "./ringmap.js";
import { rosterFor } from "./fighters.js";
import { getJuniorEffort, getJuniorModel, JUNIOR_EFFORTS, JUNIOR_MODELS, juniorModelLabel } from "./junior/settings.js";

const NO_THREADS: ThreadOverview = { open: [], resolvedCount: 0, total: 0 };

/** Live per-task GitHub state (review threads + CI + branch), keyed by `repo#issue`. */
export interface LiveInfo {
  threads: ThreadOverview;
  ci?: CiState;
  branch?: BranchState;
  files?: string[]; // files the task's PR touches, for overlap detection
}
export type ThreadMap = Record<string, LiveInfo>;
/** Branches per agent per repo: repo -> agent -> [{branch, issue}] */
export type RepoBranches = Record<string, Record<string, { branch: string; issue: number }[]>>;

export function threadKey(t: TaskRow): string {
  return `${t.repo}#${t.issue}`;
}

/** Minutes a queued task may sit unclaimed before we suggest pinging the agent. */
const PICKUP_GRACE_MIN = 20;

/**
 * Has the junior reacted to the latest thing addressed to it?
 * Returns a warning string when a manual ping is advisable, else null.
 */
export function pickupVerdict(t: TaskRow, last: CommentRow | undefined, now = Date.now()): string | null {
  const agent = agentName(t.agent);
  const ageMin = (ts: number) => Math.round((now - ts) / 60000);
  if (t.status === "queued") {
    const waitedMin = ageMin(t.updated_at);
    if (waitedMin > PICKUP_GRACE_MIN) {
      return `${agent} hasn't picked this up after ${waitedMin} minutes — its check-in schedule may not have fired. Consider pinging it manually.`;
    }
    return null;
  }
  if (t.status === "changes_requested" && last?.msg_type === "revision-request") {
    const waitedMin = ageMin(last.created_at);
    if (waitedMin > PICKUP_GRACE_MIN) {
      return `The coach requested fixes ${waitedMin} minutes ago and ${agent} hasn't responded — consider pinging it manually.`;
    }
  }
  return null;
}

export interface RepoOption {
  fullName: string;
  installationId: number;
}

/** One issue or PR as fetched live from GitHub for the "On GitHub" panel. */
export interface GhItem {
  number: number;
  title: string;
  author: string;
  url: string;
  state: string; // open | closed | merged
}

export interface GhActivity {
  openIssues: GhItem[];
  closedIssues: GhItem[];
  openPrs: GhItem[];
  closedPrs: GhItem[];
  fetchedAt: number;
}

function esc(s: string | null | undefined): string {
  return (s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function agentName(a: string): string {
  return a.charAt(0).toUpperCase() + a.slice(1);
}

function since(ts: number | null): string {
  if (!ts) return "";
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} hour${h > 1 ? "s" : ""} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** One plain-English sentence + traffic-light color per task. */
function plainStatus(t: TaskRow): { text: string; color: string; action?: { label: string; url: string } } {
  const agent = agentName(t.agent);
  const prUrl = t.pr ? `https://github.com/${t.repo}/pull/${t.pr}` : null;
  switch (t.status) {
    case "queued":
      return { text: `Waiting in the corner for ${agent} to pick this up`, color: "#d4a72c" };
    case "claimed":
      return { text: `${agent} stepped into the ring (started ${since(t.updated_at)})`, color: "#316dca" };
    case "in_review":
      return { text: `${agent} threw a punch — the coach is checking the work`, color: "#8957e5" };
    case "changes_requested":
      return { text: `The coach sent ${agent} back to the corner to fix a few things`, color: "#d29922" };
    case "approved":
      return config.autoMerge
        ? {
            text: `Checked and approved — merging itself once tests pass and conversations are resolved`,
            color: "#2da44e",
            action: prUrl ? { label: "Inspect", url: prUrl } : undefined,
          }
        : {
            text: `Checked and approved — waiting for your green light`,
            color: "#2da44e",
            action: prUrl ? { label: "Review & accept", url: prUrl } : undefined,
          };
    case "done":
      return { text: `Done ✓`, color: "#1a7f37" };
    case "failed":
      return {
        text: `Stuck — the fighter threw in the towel`,
        color: "#cf222e",
        action: { label: "See what happened", url: `https://github.com/${t.repo}/issues/${t.issue}` },
      };
    case "stopped":
      return { text: `Stopped by you`, color: "#888" };
  }
}

const ACTIVE_STATUSES = ["queued", "claimed", "in_review", "changes_requested", "approved"];

/** Branch freshness + existence, plus overlap with other tasks' files. */
function branchHealth(t: TaskRow, live: LiveInfo | undefined, all: TaskRow[], liveMap: ThreadMap): string {
  const parts: string[] = [];
  const b = live?.branch;
  if (b) {
    if (!b.exists && t.status === "claimed") {
      parts.push(`<div class="pickup-warn">🌿 ${esc(agentName(t.agent))} claimed this but hasn't pushed any branch yet — the work exists only on its machine, invisible to everyone.</div>`);
    } else if (b.exists) {
      const fresh =
        b.behindMain === 0
          ? `<span class="fresh-ok">✓ started from the latest version of the project</span>`
          : `<span class="fresh-warn">⚠️ branch is missing the last ${b.behindMain} change${(b.behindMain ?? 0) > 1 ? "s" : ""} from the main line — the agent didn't pull before building. Risk of conflicts; consider stopping it now.</span>`;
      const activity = b.lastCommitAt ? ` · last commit ${since(b.lastCommitAt)}` : "";
      parts.push(`<div class="branch-line">🌿 ${fresh}${activity}</div>`);
    }
  }
  // Overlap: two live tasks touching the same files
  if (live?.files?.length) {
    for (const other of all) {
      if (other.issue === t.issue || !ACTIVE_STATUSES.includes(other.status)) continue;
      const otherFiles = liveMap[threadKey(other)]?.files ?? [];
      const common = live.files.filter((f) => otherFiles.includes(f));
      if (common.length > 0) {
        parts.push(
          `<div class="pickup-warn">⚠️ Overlaps with “${esc(other.title ?? `task #${other.issue}`)}” (${esc(agentName(other.agent))}) — both touch ${common.length} of the same file${common.length > 1 ? "s" : ""} (<code>${esc(common.slice(0, 3).join(", "))}${common.length > 3 ? "…" : ""}</code>). Whoever merges second will conflict.</div>`
        );
      }
    }
  }
  return parts.join("");
}

/** Per-agent workload strip: active tasks vs limit, live branches. */
function workloadStrip(repo: string, tasks: TaskRow[], branches: Record<string, { branch: string; issue: number }[]>): string {
  const chips = config.agents.map((a) => {
    const active = tasks.filter((t) => t.agent === a && ["claimed", "changes_requested"].includes(t.status)).length;
    const limit = config.agentLimits[a] ?? config.defaultAgentLimit;
    const branchList = (branches[a] ?? []).map((b) => `#${b.issue}`).join(", ");
    const over = active > limit;
    return `<span class="workload ${over ? "workload-over" : ""}" title="${esc(branchList ? `branches: ${branchList}` : "no branches")}">${esc(agentName(a))}: ${active}/${limit} in hand${branchList ? ` · 🌿 ${esc(branchList)}` : ""}${over ? " ⚠️ over its limit — this agent juggles badly, expect mixups" : ""}</span>`;
  });
  return `<div class="workloads">${chips.join(" ")}</div>`;
}

/** Stop / relaunch controls. */
function controlButtons(t: TaskRow): string {
  if (ACTIVE_STATUSES.includes(t.status) && t.status !== "approved") {
    return `<form class="ctl" method="post" action="/dashboard/stop" onsubmit="return confirm('Stop this work immediately? The agent will be told to stand down and any open work submission will be closed.')">
      <input type="hidden" name="repo" value="${esc(t.repo)}"><input type="hidden" name="issue" value="${t.issue}">
      <button class="stop-btn">🛑 Stop</button></form>`;
  }
  if (t.status === "stopped") {
    return `<form class="ctl" method="post" action="/dashboard/relaunch">
      <input type="hidden" name="repo" value="${esc(t.repo)}"><input type="hidden" name="issue" value="${t.issue}">
      <button class="relaunch-btn">▶ Relaunch</button></form>`;
  }
  return "";
}

function projectName(repo: string): string {
  return repo.split("/")[1] ?? repo;
}

/** "agent-manager-hayssamhob[bot]" -> "the coach"; agent names from protocol headers win. */
function displayAuthor(c: CommentRow): string {
  if (c.msg_from === config.managerName) return "the coach";
  if (c.msg_from) return agentName(c.msg_from);
  if (c.author.endsWith("[bot]")) return "the coach";
  return c.author;
}

export interface EscalationItem {
  repo: string;
  issue: number;
  taskTitle: string | null;
  agent: string;
  reason: string;       // plain-English explanation of why action is needed
  severity: "info" | "warn" | "error";
  actionLabel: string;  // label for the "one-click resume" link
  actionUrl: string;    // the URL for the one-click resume
}

/**
 * Aggregate all tasks that need the owner's attention right now.
 * Pure logic — HTML rendering stays in `attentionItems`.
 */
export function getEscalations(
  tasks: TaskRow[],
  jobs: JobRow[],
  store: Store,
  threadMap: ThreadMap,
  now = Date.now()
): EscalationItem[] {
  const items: EscalationItem[] = [];

  for (const t of tasks) {
    const prUrl = t.pr ? `https://github.com/${t.repo}/pull/${t.pr}` : null;
    const issueUrl = `https://github.com/${t.repo}/issues/${t.issue}`;

    // 1. Stale review threads waiting on the agent
    const stale = (threadMap[threadKey(t)]?.threads ?? NO_THREADS).open.filter(
      (th) => th.waitingOn === "agent" && !th.fixCommit && now - th.lastAt > PICKUP_GRACE_MIN * 60_000
    );
    if (stale.length > 0 && prUrl) {
      items.push({
        repo: t.repo, issue: t.issue, taskTitle: t.title, agent: t.agent,
        reason: `${stale.length} conversation${stale.length > 1 ? "s" : ""} waiting on ${agentName(t.agent)} with no reply`,
        severity: "warn",
        actionLabel: "See the conversations",
        actionUrl: `${prUrl}/files`,
      });
    }

    // 2. pickupVerdict — unclaimed task or unanswered revision request
    const warn = pickupVerdict(t, store.lastCommentFor(t.repo, t.issue, t.pr), now);
    if (warn) {
      items.push({
        repo: t.repo, issue: t.issue, taskTitle: t.title, agent: t.agent,
        reason: warn,
        severity: "warn",
        actionLabel: "Open the task",
        actionUrl: issueUrl,
      });
    }

    // 3. Approved but blocked (autoMerge is on but something is in the way)
    if (t.status === "approved" && prUrl) {
      const live = threadMap[threadKey(t)];
      const blockers: string[] = [];
      if (live?.ci?.overall === "red") blockers.push(`tests are failing (${live.ci.detail ?? ""})`);
      const waitingOnYou = (live?.threads ?? NO_THREADS).open.filter((th) => th.waitingOn === "reviewer").length;
      if (waitingOnYou > 0) blockers.push(`${waitingOnYou} conversation${waitingOnYou > 1 ? "s" : ""} await your reply`);
      if (blockers.length > 0) {
        items.push({
          repo: t.repo, issue: t.issue, taskTitle: t.title, agent: t.agent,
          reason: `Approved but can't merge: ${blockers.join(" and ")}`,
          severity: "warn",
          actionLabel: config.autoMerge ? "Unblock it" : "Review & merge",
          actionUrl: prUrl,
        });
      } else if (!config.autoMerge) {
        // Manual merge mode — approved = needs owner click
        items.push({
          repo: t.repo, issue: t.issue, taskTitle: t.title, agent: t.agent,
          reason: "Finished and checked — waiting for your green light to merge",
          severity: "info",
          actionLabel: "Review & accept",
          actionUrl: prUrl,
        });
      }
    }

    // 4. Failed task — needs human decision
    if (t.status === "failed") {
      items.push({
        repo: t.repo, issue: t.issue, taskTitle: t.title, agent: t.agent,
        reason: "All agents tried — task is stuck and needs a human decision",
        severity: "error",
        actionLabel: "See what happened",
        actionUrl: issueUrl,
      });
    }
  }

  // 5. Manager offline
  if (jobs.some((j) => j.status === "needs_human")) {
    items.push({
      repo: "", issue: 0, taskTitle: null, agent: "",
      reason: "The manager assistant is offline — recent requests are parked until it's back",
      severity: "error",
      actionLabel: "Check status",
      actionUrl: "",
    });
  }

  return items;
}

function attentionItems(tasks: TaskRow[], jobs: JobRow[], store: Store, threadMap: ThreadMap): string[] {
  return getEscalations(tasks, jobs, store, threadMap).map((e) => {
    if (!e.issue) return `<li>${esc(e.reason)}</li>`;  // manager-offline item
    const link = e.actionUrl
      ? ` <a href="${esc(e.actionUrl)}" target="_blank">${esc(e.actionLabel)} →</a>`
      : "";
    return `<li><strong>${esc(projectName(e.repo))}</strong>: "${esc(e.taskTitle ?? `task #${e.issue}`)}" — ${esc(e.reason)}${link}</li>`;
  });
}

/** The visual issue ⇄ PR pairing: spec, work-in-progress, branch, automated checks. */
function trailLine(t: TaskRow, ci?: CiState): string {
  const spec = `<a href="https://github.com/${t.repo}/issues/${t.issue}" target="_blank">📋 Request #${t.issue}</a>`;
  const work = t.pr
    ? ` <span class="trail-sep">⇄</span> <a href="https://github.com/${t.repo}/pull/${t.pr}" target="_blank">🔧 Work by ${esc(agentName(t.agent))}&nbsp;(PR&nbsp;#${t.pr})</a> <span class="trail-branch">${esc(taskBranch(t.agent, t.issue))}</span>`
    : ` <span class="trail-sep">⇄</span> <span class="trail-pending">no work submitted by ${esc(agentName(t.agent))} yet</span>`;
  const ciChip = !t.pr || !ci ? "" : ` <span class="trail-sep">·</span> ${ciBadge(ci)}`;
  return `<div class="trail">${spec}${work}${ciChip}</div>`;
}

function ciBadge(ci: CiState): string {
  switch (ci.overall) {
    case "green":
      return `<span class="ci ci-green" title="${esc(ci.detail)}">✓ automated tests passed</span>`;
    case "red":
      return `<span class="ci ci-red" title="${esc(ci.detail)}">✗ automated tests failing: ${esc(ci.detail)}</span>`;
    case "pending":
      return `<span class="ci ci-pending" title="${esc(ci.detail)}">● automated tests running…</span>`;
    case "none":
      return `<span class="ci ci-none">no automated tests set up</span>`;
  }
}

/** Plain-English summary + one-click merge for approved work. */
function acceptBlock(t: TaskRow, ci?: CiState): string {
  if (t.status !== "approved" || !t.pr) return "";
  const ciBlocks = ci && (ci.overall === "red" || ci.overall === "pending");
  const label = config.autoMerge ? "✅ Merge now (skip the wait)" : "✅ Accept &amp; merge";
  const button = ciBlocks
    ? `<button class="accept-btn" disabled title="Waiting for automated tests to pass">Accept &amp; merge (waiting on tests)</button>`
    : `<button class="accept-btn">${label}</button>`;
  const autoNote = config.autoMerge
    ? `<div class="point-meta">Merges itself when tests pass and conversations are resolved — add the <code>${esc(config.holdLabel)}</code> label on the task to keep it for yourself.</div>`
    : "";
  return `<div class="accept">
    ${t.plain_summary ? `<div class="plain-summary">“${esc(t.plain_summary)}” <span class="point-meta">— the coach</span></div>` : ""}
    ${autoNote}
    <form method="post" action="/dashboard/merge" onsubmit="return confirm('Accept this work and make it part of ${esc(projectName(t.repo))}?')">
      <input type="hidden" name="repo" value="${esc(t.repo)}">
      <input type="hidden" name="issue" value="${t.issue}">
      ${button}
      <a class="accept-alt" href="https://github.com/${t.repo}/pull/${t.pr}/files" target="_blank">or inspect the details first →</a>
    </form>
  </div>`;
}

/** The coach's fix checklist: every requested point and whether it's been addressed. */
function checklistBlock(points: RevisionPointRow[]): string {
  if (points.length === 0) return "";
  const open = points.filter((p) => p.status === "open").length;
  const head =
    open === 0
      ? `All ${points.length} requested fix${points.length > 1 ? "es" : ""} addressed`
      : `${points.length - open} of ${points.length} requested fix${points.length > 1 ? "es" : ""} addressed`;
  const rows = points
    .map(
      (p) =>
        `<li class="${p.status}">${p.status === "addressed" ? "✅" : "⏳"} ${esc(p.text)} <span class="point-meta">(asked in round ${p.round}${p.status === "addressed" ? `, fixed ${since(p.addressed_at ?? p.created_at)}` : ""})</span></li>`
    )
    .join("");
  return `<div class="checklist">
    <div class="checklist-head">📝 ${head}</div>
    <ul>${rows}</ul>
  </div>`;
}

function threadBlock(t: TaskRow, overview: ThreadOverview): string {
  if (overview.total === 0) return "";
  const prUrl = t.pr ? `https://github.com/${t.repo}/pull/${t.pr}` : `https://github.com/${t.repo}/issues/${t.issue}`;
  const agent = agentName(t.agent);
  const resolved = overview.resolvedCount > 0 ? ` · <span class="resolved-ok">✓ ${overview.resolvedCount} resolved</span>` : "";
  if (overview.open.length === 0) {
    return `<div class="threads"><div class="threads-head">🗣 All ${overview.total} conversation${overview.total > 1 ? "s" : ""} resolved ✓</div></div>`;
  }
  const rows = overview.open
    .map((th) => {
      const where = th.path ? ` on <code>${esc(th.path)}</code>` : "";
      const turn = th.fixCommit
        ? `<strong class="waiting">replied with commit <code>${esc(th.fixCommit)}</code> but the conversation is NOT resolved — ${esc(agent)} should click “Resolve conversation” (or the fix needs re-review)</strong>`
        : th.waitingOn === "agent"
          ? `<strong class="waiting">reply expected from ${esc(agent)} — with the fix commit, then resolve</strong>`
          : `<strong class="waiting">reply expected from you / the coach</strong>`;
      return `<li>
        <span class="thread-snippet">“${esc(th.firstSnippet)}${th.firstSnippet.length >= 140 ? "…" : ""}”</span>${where}<br>
        <span class="thread-meta">started by <strong>${esc(displayLogin(th.firstAuthor))}</strong> · ${th.replies} repl${th.replies === 1 ? "y" : "ies"} · last word from <strong>${esc(displayLogin(th.lastAuthor))}</strong> ${since(th.lastAt)} · ${turn}</span>
      </li>`;
    })
    .join("");
  return `<div class="threads">
    <div class="threads-head">🗣 ${overview.open.length} of ${overview.total} conversation${overview.total > 1 ? "s" : ""} still open${resolved} — <a href="${prUrl}/files" target="_blank">open them →</a></div>
    <ul>${rows}</ul>
  </div>`;
}

/** "agent-manager-hayssamhob[bot]" -> "the coach" for thread author display. */
function displayLogin(login: string): string {
  return login.endsWith("[bot]") ? "the coach" : login;
}

function projectCard(repo: string, tasks: TaskRow[], store: Store, threadMap: ThreadMap, repoBranches: RepoBranches, trustTiers: Record<string, string>): string {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const tier = trustTiers[repo] ?? "L1";
  const rows = tasks
    .map((t) => {
      const s = plainStatus(t);
      const title = esc(t.title ?? `Task #${t.issue}`);
      const action = s.action ? ` <a class="action" href="${s.action.url}" target="_blank">${s.action.label} →</a>` : "";
      const last = store.lastCommentFor(t.repo, t.issue, t.pr);
      const issueUrl = `https://github.com/${t.repo}/issues/${t.issue}`;
      const lastLine = last
        ? `<div class="last-comment">💬 <a href="${issueUrl}" target="_blank">Last message</a> ${since(last.created_at)} from <strong>${esc(displayAuthor(last))}</strong>: “${esc(last.snippet.slice(0, 120))}${last.snippet.length > 120 ? "…" : ""}”</div>`
        : "";
      const warn = pickupVerdict(t, last);
      const warnLine = warn ? `<div class="pickup-warn">⚠️ ${esc(warn)}</div>` : "";
      const live = threadMap[threadKey(t)];
      const threads = threadBlock(t, live?.threads ?? NO_THREADS);
      const checklist = checklistBlock(store.listRevisionPoints(t.repo, t.issue));
      const health = branchHealth(t, live, tasks, threadMap);
      return `<li>
        <div class="item-row">
          <span class="dot" style="background:${s.color}"></span>
          <span class="item-title">${title}</span>
          <span class="item-status" style="color:${s.color}">${s.text}${action}</span>
          ${controlButtons(t)}
        </div>
        ${trailLine(t, live?.ci)}${health}${lastLine}${warnLine}${checklist}${threads}${acceptBlock(t, live?.ci)}
      </li>`;
    })
    .join("");
  return `<section class="card">
    <div class="card-head">
      <h2>${esc(projectName(repo))}</h2>
      <span class="tier-badge">Trust tier: ${esc(tier)}</span>
      <span class="progress-label">${done} of ${total} done</span>
    </div>
    <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    ${workloadStrip(repo, tasks, repoBranches[repo] ?? {})}
    <ul class="items">${rows}</ul>
    <p class="card-foot"><a href="https://github.com/${repo}" target="_blank">Open in GitHub →</a></p>
  </section>`;
}

// ---------------------------------------------------------------------------
// Cost panel — spend breakdown from the SQLite cost_ledger
// ---------------------------------------------------------------------------

function fmtUsd(cents: number): string {
  if (cents === 0) return "$0.00";
  return `$${(cents).toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function costPanel(store: Store): string {
  const totals = store.getLedgerTotals();
  const byAgent = store.getLedgerByAgent();

  if (totals.usd === 0 && totals.tokens === 0) {
    return `<section class="card cost-panel">
      <h2>💰 Cost</h2>
      <p class="point-meta">No spend recorded yet.</p>
    </section>`;
  }

  const agentRows = byAgent
    .filter((a) => a.agent)
    .map((a) => {
      const pct = totals.usd > 0 ? Math.round((a.usd / totals.usd) * 100) : 0;
      return `<tr>
        <td>${esc(agentName(a.agent!))}</td>
        <td class="num">${fmtUsd(a.usd)}</td>
        <td class="num">${fmtTokens(a.tokens)}</td>
        <td class="num">${pct}%</td>
      </tr>`;
    })
    .join("");

  const ceiling = config.maxUsd !== undefined ? `<div class="point-meta">Budget ceiling: ${fmtUsd(config.maxUsd)}</div>` : "";

  return `<section class="card cost-panel">
    <h2>💰 Cost</h2>
    <div class="cost-total">Total spend: <strong>${fmtUsd(totals.usd)}</strong> · ${fmtTokens(totals.tokens)} tokens</div>
    ${ceiling}
    ${agentRows ? `<table class="cost-table">
      <thead><tr><th>Agent</th><th class="num">Spend</th><th class="num">Tokens</th><th class="num">Share</th></tr></thead>
      <tbody>${agentRows}</tbody>
    </table>` : ""}
  </section>`;
}

// ---------------------------------------------------------------------------
// Trust-tier panel — current governance level for the fleet
// ---------------------------------------------------------------------------

const TIER_DESCRIPTIONS: Record<TrustTier, { label: string; detail: string; color: string }> = {
  L1: { label: "L1 — report only", detail: "Agents open PRs and comment, but never merge. Every change needs your approval.", color: "#d29922" },
  L2: { label: "L2 — patch only", detail: "Low-risk patches auto-merge when CI passes. Higher-risk work still needs you.", color: "#316dca" },
  L3: { label: "L3 — auto-merge", detail: "The referee enforces required checks under branch protection. Unattended operation.", color: "#2da44e" },
};

export function trustTierPanel(tier: TrustTier): string {
  const info = TIER_DESCRIPTIONS[tier];
  return `<section class="card trust-panel">
    <h2>🛡️ Trust tier</h2>
    <div class="trust-badge" style="border-color:${info.color}; color:${info.color}">
      ${esc(info.label)}
    </div>
    <p class="trust-detail">${esc(info.detail)}</p>
    <div class="trust-ladder">
      ${(["L1", "L2", "L3"] as TrustTier[]).map((t) => {
        const d = TIER_DESCRIPTIONS[t];
        const active = t === tier;
        return `<div class="trust-step ${active ? "trust-active" : ""}" style="${active ? `border-color:${d.color}` : ""}">
          <strong>${esc(d.label)}</strong>
          <span class="point-meta">${esc(d.detail)}</span>
        </div>`;
      }).join("")}
    </div>
  </section>`;
}

/** Account-rotation panel: save a "where we left off" note + copy the resume bundle. */
function handoffPanel(store: Store): string {
  const note = store.latestHandoffNote();
  const savedMeta = note
    ? `<p class="point-meta">Last saved ${since(note.created_at)}${note.author ? ` by ${esc(note.author)}` : ""}.</p>`
    : "";
  return `<section class="card">
    <h2>🔁 Hand off to another account</h2>
    <p class="card-foot" style="margin-top:0">When this Claude account hits a rate limit, save where you are, copy the resume bundle, and paste it into a fresh session on the other account.</p>
    <form method="post" action="/dashboard/handoff-note">
      <label for="note">Where we left off — the next step, decisions, anything the fleet snapshot can't show</label>
      <textarea name="note" id="note" placeholder="e.g. Mid-way through the dashboard redesign (#10). Base = mockup A; next: graft mockup C's urgency rails. Build green at 45 tests.">${esc(note?.note ?? "")}</textarea>
      <button type="submit">Save note</button>
    </form>
    ${savedMeta}
    <p style="margin-top:0.9rem">
      <button type="button" class="copy-btn" onclick="copyHandoff(this)">📋 Copy resume bundle</button>
      <a class="accept-alt" href="/api/handoff" target="_blank">or open it raw →</a>
    </p>
    <script>
      async function copyHandoff(btn) {
        try {
          const text = await (await fetch('/api/handoff')).text();
          await navigator.clipboard.writeText(text);
          const old = btn.textContent; btn.textContent = '✅ Copied to clipboard';
          setTimeout(() => { btn.textContent = old; }, 2500);
        } catch (e) {
          btn.textContent = '⚠️ Copy failed — open it raw';
        }
      }
    </script>
  </section>`;
}

// ---------------------------------------------------------------------------
// Coach panel — live-switchable Coach backend (M... : dashboard-driven, no restart)
// ---------------------------------------------------------------------------

function coachPanel(store: Store): string {
  const current = resolveCoachBackend(store);
  const options = [
    { key: ENV_DEFAULT_KEY, label: "Current .env default" },
    ...COACH_BACKENDS.map((b) => ({ key: b.key, label: b.label })),
  ]
    .map((o) => `<option value="${esc(o.key)}"${o.key === current.key ? " selected" : ""}>${esc(o.label)}</option>`)
    .join("");
  return `<section class="card coach-panel">
    <h2>🎙️ Coach</h2>
    <p class="point-meta">Whichever model is picked here reviews and approves every Fighter's work — switch takes effect on the next dispatch, no restart needed.</p>
    <div class="coach-current">Right now: <strong>${esc(current.label)}</strong></div>
    <form method="post" action="/dashboard/set-coach" class="coach-form">
      <select name="coach">${options}</select>
      <button type="submit">Switch</button>
    </form>
  </section>`;
}

// ---------------------------------------------------------------------------
// Fight Night layout — one structure, two skins (epic #182, phase 1).
// Skin = CSS tokens only; zero logic forks (owner rule).
// ---------------------------------------------------------------------------

/** Which floor column a task stands in. */
function floorColumn(t: TaskRow): "corner" | "ring" | "judges" | "books" {
  switch (t.status) {
    case "queued": return "corner";
    case "claimed":
    case "changes_requested": return "ring";
    case "in_review":
    case "approved":
    case "failed": return "judges";
    case "done":
    case "stopped": return "books";
  }
}

/** One bout card on the floor — compact but fully functional (merge, stop, threads). */
function boutCard(t: TaskRow, store: Store, threadMap: ThreadMap, all: TaskRow[], showRepo: boolean): string {
  const s = plainStatus(t);
  const live = threadMap[threadKey(t)];
  const last = store.lastCommentFor(t.repo, t.issue, t.pr);
  const warn = pickupVerdict(t, last);
  const col = floorColumn(t);
  const health = col === "ring" ? branchHealth(t, live, all, threadMap) : "";
  return `<div class="bout bout-${col}${t.status === "failed" ? " bout-failed" : ""}">
    <div class="bout-head">
      ${showRepo ? `<span class="bout-repo">${esc(projectName(t.repo))}</span>` : ""}
      <span class="bout-title">${esc(t.title ?? `Task #${t.issue}`)}</span>
      ${controlButtons(t)}
    </div>
    <div class="bout-status" style="color:${s.color}">${s.text}${s.action ? ` <a class="action" href="${s.action.url}" target="_blank">${s.action.label} →</a>` : ""}</div>
    ${trailLine(t, live?.ci)}
    ${warn ? `<div class="pickup-warn">⚠ ${esc(warn)}</div>` : ""}
    ${health}
    ${checklistBlock(store.listRevisionPoints(t.repo, t.issue))}
    ${threadBlock(t, live?.threads ?? NO_THREADS)}
    ${acceptBlock(t, live?.ci)}
  </div>`;
}

/** The four-column floor for the tasks in scope. */
function floorPanel(tasks: TaskRow[], store: Store, threadMap: ThreadMap, showRepo: boolean): string {
  const cols: { key: ReturnType<typeof floorColumn>; label: string; cls: string }[] = [
    { key: "corner", label: "IN THE CORNER", cls: "col-corner" },
    { key: "ring", label: "● IN THE RING", cls: "col-ring" },
    { key: "judges", label: "JUDGES’ TABLE", cls: "col-judges" },
    { key: "books", label: "IN THE BOOKS", cls: "col-books" },
  ];
  const active = tasks.filter((t) => t.status !== "stopped");
  const stopped = tasks.filter((t) => t.status === "stopped");
  const colHtml = cols.map((c) => {
    let mine = active.filter((t) => floorColumn(t) === c.key);
    if (c.key === "books") mine = mine.slice(0, 6); // the books hold history; show the recent wins
    const cards = mine.map((t) => boutCard(t, store, threadMap, active, showRepo)).join("");
    return `<div class="floor-col ${c.cls}">
      <h6>${c.label} <span>${mine.length}</span></h6>
      ${cards || `<div class="floor-empty">—</div>`}
    </div>`;
  }).join("");
  const stoppedNote = stopped.length
    ? `<details class="stopped-note"><summary>${stopped.length} stopped/archived bout${stopped.length > 1 ? "s" : ""} — relaunchable</summary>${stopped.map((t) => boutCard(t, store, threadMap, active, showRepo)).join("")}</details>`
    : "";
  return `<section class="fn-panel"><h4 class="fn-panel-title">THE FLOOR</h4><div class="floor">${colHtml}</div>${stoppedNote}</section>`;
}

/** Referee's log — the latest recorded traffic for the scope, newest first. */
function refereeLog(store: Store, repoNames: string[]): string {
  const rows = repoNames
    .flatMap((r) => store.recentComments(r, 8))
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 10);
  if (rows.length === 0) return "";
  const line = (c: CommentRow) => {
    const when = new Date(c.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const kind = c.msg_type ? c.msg_type.toUpperCase().replace(/-/g, " ") : "COMMENT";
    const kindCls = /approval|merged/.test(c.msg_type ?? "") ? "lk-win" : /revision|timeout|reassignment/.test(c.msg_type ?? "") ? "lk-live" : "lk-gold";
    const ghUrl = c.url ?? `https://github.com/${c.repo}/issues/${c.issue}`;
    const full = c.body && c.body.length > c.snippet.length ? c.body : c.snippet;
    return `<details class="log-row"><summary><time>${when}</time><span><b class="${kindCls}">${esc(kind)}</b> <span class="log-who">${esc(displayAuthor(c))}</span> — ${esc(c.snippet.slice(0, 110))}${c.snippet.length > 110 ? "…" : ""} <span class="log-where">#${c.issue}</span></span></summary><div class="log-full">${esc(full)}</div><a class="log-gh" href="${esc(ghUrl)}" target="_blank" rel="noopener">View on GitHub ↗</a></details>`;
  };
  return `<section class="fn-panel"><h4 class="fn-panel-title">REFEREE&rsquo;S LOG</h4>${rows.map(line).join("")}</section>`;
}

/** The roster — every fighter with model, load, and honest availability. */
function rosterPanel(tasks: TaskRow[], store: Store): string {
  const roster = rosterFor(config.agents);
  const cards = roster.map((f) => {
    const mine = tasks.filter((t) => t.agent === f.agent && ["claimed", "changes_requested"].includes(t.status)).length;
    const limit = config.agentLimits[f.agent] ?? config.defaultAgentLimit;
    const rl = store.agentStatus(f.agent).state === "rate_limited";
    const busyLine = rl ? `<div class="f-busy" style="color:var(--fn-live)">⛔ rate-limited</div>`
      : mine > 0 ? `<div class="f-busy" style="color:var(--fn-live)">● in the ring · ${mine}</div>` : "";
    const isJunior = f.agent === config.juniorAgent;
    const modelLine = isJunior ? juniorModelLabel(store) : f.model;
    const juniorForm = isJunior
      ? `<form method="post" action="/dashboard/set-junior" class="f-config">
          <select name="model" title="model for the next session">${JUNIOR_MODELS.map((m) => `<option value="${esc(m.key)}"${m.key === getJuniorModel(store) ? " selected" : ""}>${esc(m.label)}</option>`).join("")}</select>
          <select name="effort" title="effort ceiling for the next session">${JUNIOR_EFFORTS.map((e) => `<option value="${esc(e.key)}"${e.key === getJuniorEffort(store) ? " selected" : ""}>${esc(e.label)}</option>`).join("")}</select>
          <button type="submit">SET</button>
        </form>`
      : "";
    return `<div class="fighter-card" data-agent="${esc(f.agent)}" data-pingable="${f.ping ? 1 : 0}">
      <div class="f-head"><i class="f-dot"></i><b>${esc(f.label)}</b><span class="f-load">${mine}/${limit}</span></div>
      <div class="f-model">${esc(modelLine)}</div>
      ${busyLine}
      <div class="f-det">${f.ping ? "pinging…" : "not pingable (no CLI/API)"}</div>
      ${f.ping ? `<button type="button" class="f-ping" onclick="window.pingFighter('${esc(f.agent)}')">PING</button>` : ""}
      ${juniorForm}
    </div>`;
  }).join("");
  return `<h5 class="side-h">THE ROSTER</h5>${cards}
  <script>
    window.pingFighter = async function (agent) {
      const card = document.querySelector('.fighter-card[data-agent="' + agent + '"]');
      if (!card) return;
      const det = card.querySelector('.f-det'), dot = card.querySelector('.f-dot');
      det.textContent = 'pinging…';
      try {
        const r = await fetch('/api/ping/' + encodeURIComponent(agent), { method: 'POST' });
        const j = await r.json();
        dot.style.background = j.ok ? 'var(--fn-win)' : (j.pingable ? 'var(--fn-live)' : 'var(--fn-faint)');
        dot.style.boxShadow = j.ok ? '0 0 6px var(--fn-win)' : 'none';
        det.textContent = j.ok ? '✓ available — ' + j.detail : (j.pingable ? '✗ ' + j.detail : j.detail);
      } catch (e) { det.textContent = '✗ ping failed — server away?'; }
    };
    document.querySelectorAll('.fighter-card[data-pingable="1"]').forEach(function (c) {
      window.pingFighter(c.getAttribute('data-agent'));
    });
  </script>`;
}

/** FIGHT CARDS — repos as folders in the sidebar, grouped by owner; quiet repos fold away. */
function fightCards(tasks: TaskRow[], repos: RepoOption[], selectedRepo: string | null): string {
  const repoNames = [...new Set([...tasks.map((t) => t.repo), ...repos.map((r) => r.fullName)])];
  const entry = (r: string) => {
    const mine = tasks.filter((t) => t.repo === r);
    const won = mine.filter((t) => t.status === "done").length;
    const live = mine.filter((t) => ["claimed", "changes_requested"].includes(t.status)).length;
    const queued = mine.filter((t) => t.status === "queued").length;
    const on = r === selectedRepo;
    const counts = [won ? `${won}W` : "", live ? `${live} LIVE` : "", queued ? `${queued}Q` : ""].filter(Boolean).join(" · ") || "quiet";
    return `<a class="card-entry${on ? " on" : ""}" href="/dashboard?card=${encodeURIComponent(r)}">
      ${esc(projectName(r))}
      <span class="card-counts${live ? " has-live" : ""}">${counts}</span>
    </a>`;
  };
  const hasWork = (r: string) => tasks.some((t) => t.repo === r) || r === selectedRepo;
  const byOwner = new Map<string, string[]>();
  for (const r of repoNames) {
    const owner = r.split("/")[0].toUpperCase();
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), r]);
  }
  const folders = [...byOwner.entries()].map(([owner, rs]) => {
    const active = rs.filter(hasWork);
    const quiet = rs.filter((r) => !hasWork(r));
    const quietBlock = quiet.length
      ? `<details class="quiet-cards"><summary>${quiet.length} quiet card${quiet.length > 1 ? "s" : ""}</summary>${quiet.map(entry).join("")}</details>`
      : "";
    return `<div class="card-folder">▾ ${esc(owner)}</div>${active.map(entry).join("")}${quietBlock}`;
  }).join("");
  const all = `<a class="card-entry${!selectedRepo ? " on" : ""}" href="/dashboard">All cards<span class="card-counts">${tasks.length ? `${tasks.length} bouts total` : "empty"}</span></a>`;
  return `<h5 class="side-h">FIGHT CARDS</h5>${all}${folders}`;
}


/** ON GITHUB — live open/closed issues and PRs for the scoped fight card(s). */
function ghPanel(activity: Record<string, GhActivity>, scopeRepos: string[]): string {
  const repos = scopeRepos.filter((r) => activity[r]);
  if (repos.length === 0) return "";
  const item = (repo: string, i: GhItem, isPr: boolean) => {
    const dot = i.state === "merged" ? "var(--fn-gold)" : i.state === "open" ? "var(--fn-win)" : "var(--fn-faint)";
    return `<li><i style="background:${dot}"></i><a href="${esc(i.url)}" target="_blank" rel="noopener">#${i.number} ${esc(i.title.slice(0, 80))}${i.title.length > 80 ? "…" : ""}</a><span class="gh-who">${esc(i.author)}</span></li>`;
  };
  const block = (title: string, rows: string[], openByDefault: boolean) =>
    rows.length === 0
      ? ""
      : `<details${openByDefault ? " open" : ""}><summary>${title} · ${rows.length}</summary><ul class="gh-list">${rows.join("")}</ul></details>`;
  const cols = repos.map((r) => {
    const a = activity[r];
    return `<div class="gh-col">
      ${repos.length > 1 ? `<div class="gh-repo">${esc(projectName(r))}</div>` : ""}
      <div class="gh-half"><div class="gh-h">ISSUES</div>
        ${block("Open", a.openIssues.map((i) => item(r, i, false)), true)}
        ${block("Recently closed", a.closedIssues.map((i) => item(r, i, false)), false)}
        ${a.openIssues.length + a.closedIssues.length === 0 ? `<p class="gh-empty">none</p>` : ""}
      </div>
      <div class="gh-half"><div class="gh-h">PULL REQUESTS</div>
        ${block("Open", a.openPrs.map((i) => item(r, i, true)), true)}
        ${block("Recently closed", a.closedPrs.map((i) => item(r, i, true)), false)}
        ${a.openPrs.length + a.closedPrs.length === 0 ? `<p class="gh-empty">none</p>` : ""}
      </div>
    </div>`;
  }).join("");
  return `<section class="fn-panel gh-panel"><h4 class="fn-panel-title">ON GITHUB — THE OFFICIAL RECORD</h4>${cols}</section>`;
}

export function renderDashboard(
  store: Store,
  repos: RepoOption[],
  notice?: string,
  threadMap: ThreadMap = {},
  repoBranches: RepoBranches = {},
  trustTiers: Record<string, string> = {},
  selectedRepo: string | null = null,
  ghActivity: Record<string, GhActivity> = {}
): string {
  void repoBranches; // superseded by the roster in the Fight Night layout
  const allTasks = store.listTasks();
  const jobs = store.recentJobs(10);
  const repoNames = [...new Set(allTasks.map((t) => t.repo))];
  if (selectedRepo && !repoNames.includes(selectedRepo) && !repos.some((r) => r.fullName === selectedRepo)) selectedRepo = null;
  const scoped = selectedRepo ? allTasks.filter((t) => t.repo === selectedRepo) : allTasks;
  const scopeRepos = selectedRepo ? [selectedRepo] : repoNames;

  const attention = attentionItems(scoped, jobs, store, threadMap);
  const bell = attention.length;

  // Signals: engine heartbeat, worst CI in scope, decisions awaiting the owner.
  const lastTick = parseInt(store.getSetting("last_worker_tick") ?? "0", 10);
  const engineUp = lastTick > 0 && Date.now() - lastTick < 45_000;
  const cis = scoped.map((t) => threadMap[threadKey(t)]?.ci?.overall).filter(Boolean);
  const ciState = cis.includes("red") ? "live" : cis.includes("pending") ? "gold" : "win";
  const ciLabel = cis.includes("red") ? "CI RED" : cis.includes("pending") ? "CI RUNNING" : "CI";

  // Round clock: how long the current round has been running (latest activity on a live bout).
  const liveTasks = scoped.filter((t) => ["claimed", "changes_requested", "in_review"].includes(t.status));
  const round = liveTasks.length ? Math.max(...liveTasks.map((t) => t.revision_round)) + 1 : 0;
  const lastMove = liveTasks.length ? Math.max(...liveTasks.map((t) => t.updated_at)) : 0;
  const elapsedMin = lastMove ? Math.floor((Date.now() - lastMove) / 60000) : 0;
  const clock = liveTasks.length
    ? `<span class="fn-clock"><small>ROUND ${round}</small>${String(Math.floor(elapsedMin / 60)).padStart(2, "0")}:${String(elapsedMin % 60).padStart(2, "0")}<em> elapsed</em></span>`
    : "";

  const scopeLabel = selectedRepo ? projectName(selectedRepo) : "All cards";
  const tally = {
    won: scoped.filter((t) => t.status === "done").length,
    live: liveTasks.length,
    you: attention.length,
    card: scoped.filter((t) => t.status === "queued").length,
  };
  const tier = selectedRepo ? trustTiers[selectedRepo] ?? "L1" : null;

  const coach = resolveCoachBackend(store);
  const cost = forecastRunCost(store);
  const repoOptions = repos.map((r) => `<option value="${esc(r.fullName)}">${esc(projectName(r.fullName))}</option>`).join("");

  return `<!DOCTYPE html>
<html lang="en" data-skin="dark">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="120">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Foreman — ${esc(scopeLabel)}</title>
<script>try { document.documentElement.dataset.skin = localStorage.getItem('foreman-skin') || 'dark'; } catch (e) {}</script>
<style>
  html[data-skin="dark"] {
    --fn-bg: #0b0a0e; --fn-side: #0e0c12; --fn-panel: #141218; --fn-line: #26202e;
    --fn-ink: #f2ead9; --fn-dim: #9b8f7c; --fn-faint: #55495c;
    --fn-gold: #d3a95f; --fn-live: #c04a5e; --fn-win: #58a86e;
    --fn-display: Georgia, "Palatino Linotype", serif; --fn-shadow: none;
  }
  html[data-skin="light"] {
    --fn-bg: #f2f1ec; --fn-side: #e9e7df; --fn-panel: #ffffff; --fn-line: #d6d3c8;
    --fn-ink: #26282b; --fn-dim: #8b877c; --fn-faint: #b9b5a8;
    --fn-gold: #a98f4d; --fn-live: #c73e33; --fn-win: #4c8054;
    --fn-display: "American Typewriter", "Courier New", serif; --fn-shadow: 0 1px 4px #0002;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--fn-bg); color: var(--fn-ink); font-family: -apple-system, "Segoe UI", sans-serif; line-height: 1.5; }
  a { color: var(--fn-gold); text-decoration: none; } a:hover { text-decoration: underline; }
  h1,h2,h3,h4 { font-family: var(--fn-display); }
  .fn-nav { display: flex; align-items: center; gap: 1.6rem; padding: 0.85rem 1.6rem; border-bottom: 1px solid var(--fn-line); background: var(--fn-side); }
  .fn-wordmark { font-family: var(--fn-display); font-weight: 700; letter-spacing: 0.3em; color: var(--fn-gold); font-size: 1rem; }
  .fn-nav a.navlink { color: var(--fn-dim); font-size: 0.7rem; letter-spacing: 0.18em; }
  .fn-nav a.navlink:hover { color: var(--fn-ink); text-decoration: none; }
  .fn-nav .right { margin-left: auto; display: flex; align-items: center; gap: 0.9rem; }
  .bell { position: relative; font-size: 1.05rem; color: inherit; }
  .bell b { position: absolute; top: -7px; right: -10px; background: var(--fn-live); color: #fff; font-size: 0.58rem; border-radius: 999px; padding: 1px 5px; font-family: sans-serif; }
  .coach-pill { font-size: 0.7rem; letter-spacing: 0.06em; color: var(--fn-gold); border: 1px solid var(--fn-gold); border-radius: 999px; padding: 0.28rem 0.85rem; opacity: 0.9; }
  .coach-nav { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.7rem; letter-spacing: 0.06em; color: var(--fn-gold); border: 1px solid var(--fn-gold); border-radius: 999px; padding: 0.18rem 0.7rem; margin: 0; }
  .coach-nav select { background: transparent; color: var(--fn-gold); border: none; font-size: 0.7rem; cursor: pointer; max-width: 220px; }
  .coach-nav select option { background: var(--fn-panel); color: var(--fn-ink); }
  .f-config { display: flex; gap: 0.3rem; margin: 0.45rem 0 0; }
  .f-config select { flex: 1; min-width: 0; background: var(--fn-bg); color: var(--fn-ink); border: 1px solid var(--fn-line); font-size: 0.62rem; padding: 0.15rem 0.2rem; }
  .f-config button { font-size: 0.6rem; letter-spacing: 0.1em; background: none; border: 1px solid var(--fn-gold); color: var(--fn-gold); padding: 0.15rem 0.45rem; cursor: pointer; margin: 0; }
  .gh-panel .gh-col { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2rem; }
  .gh-panel .gh-repo { grid-column: 1 / -1; font-size: 0.72rem; letter-spacing: 0.12em; color: var(--fn-gold); margin: 0.5rem 0 0.1rem; }
  .gh-panel .gh-h { font-size: 0.66rem; letter-spacing: 0.16em; color: var(--fn-dim); margin: 0.4rem 0 0.3rem; }
  .gh-panel details { margin: 0.2rem 0; }
  .gh-panel summary { font-size: 0.72rem; color: var(--fn-dim); cursor: pointer; padding: 0.15rem 0; }
  .gh-panel summary:hover { color: var(--fn-ink); }
  .gh-list { list-style: none; margin: 0.2rem 0 0.4rem; padding: 0; }
  .gh-list li { display: flex; align-items: baseline; gap: 0.45rem; font-size: 0.76rem; padding: 0.18rem 0; border-bottom: 1px dashed var(--fn-line); }
  .gh-list li:last-child { border-bottom: none; }
  .gh-list li i { width: 7px; height: 7px; border-radius: 50%; flex: none; position: relative; top: -1px; }
  .gh-list li a { color: var(--fn-ink); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gh-list li a:hover { color: var(--fn-gold); }
  .gh-who { margin-left: auto; font-size: 0.66rem; color: var(--fn-faint); flex: none; }
  .gh-empty { font-size: 0.72rem; color: var(--fn-faint); margin: 0.2rem 0; }
  @media (max-width: 900px) { .gh-panel .gh-col { grid-template-columns: 1fr; } }
  .beat { width: 9px; height: 9px; border-radius: 50%; background: ${engineUp ? "var(--fn-win)" : "var(--fn-live)"}; box-shadow: 0 0 8px ${engineUp ? "var(--fn-win)" : "var(--fn-live)"}; }
  .skin-btn { background: none; border: 1px solid var(--fn-line); color: var(--fn-ink); border-radius: 8px; padding: 0.25rem 0.6rem; cursor: pointer; font-size: 0.95rem; }
  .fn-layout { display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: calc(100vh - 58px); }
  .fn-side-col { background: var(--fn-side); border-right: 1px solid var(--fn-line); padding: 1.2rem 0.95rem; }
  .side-h { font-size: 0.6rem; letter-spacing: 0.26em; color: var(--fn-dim); margin: 1.4rem 0 0.6rem; font-weight: 600; }
  .side-h:first-child { margin-top: 0; }
  .card-folder { font-size: 0.62rem; letter-spacing: 0.12em; color: var(--fn-faint); margin: 0.7rem 0 0.25rem; }
  .card-entry { display: block; color: var(--fn-dim); padding: 0.5rem 0.7rem; font-size: 0.85rem; border-left: 3px solid transparent; }
  .card-entry:hover { color: var(--fn-ink); text-decoration: none; }
  .card-entry.on { color: var(--fn-ink); background: var(--fn-panel); border-left-color: var(--fn-gold); box-shadow: var(--fn-shadow); }
  .card-counts { display: block; font-size: 0.64rem; color: var(--fn-faint); letter-spacing: 0.08em; font-family: ui-monospace, monospace; }
  .card-counts.has-live { color: var(--fn-live); }
  .quiet-cards { margin: 0.2rem 0 0.2rem 0.7rem; }
  .quiet-cards summary { font-size: 0.68rem; color: var(--fn-faint); cursor: pointer; padding: 0.2rem 0; }
  .fighter-card { background: var(--fn-panel); border: 1px solid var(--fn-line); padding: 0.65rem 0.75rem; margin-bottom: 0.55rem; box-shadow: var(--fn-shadow); }
  .f-head { display: flex; align-items: center; gap: 0.45rem; font-size: 0.84rem; }
  .f-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--fn-faint); flex: none; }
  .f-load { margin-left: auto; font-size: 0.62rem; color: var(--fn-dim); font-family: ui-monospace, monospace; }
  .f-model { font-size: 0.64rem; color: var(--fn-gold); font-family: ui-monospace, monospace; margin-top: 0.25rem; }
  .f-busy { font-size: 0.66rem; margin-top: 0.2rem; }
  .f-det { font-size: 0.64rem; color: var(--fn-dim); margin-top: 0.25rem; min-height: 1em; }
  .f-ping { margin-top: 0.45rem; font-size: 0.6rem; letter-spacing: 0.12em; background: none; border: 1px solid var(--fn-gold); color: var(--fn-gold); padding: 0.18rem 0.55rem; cursor: pointer; }
  .fn-main { padding: 1.4rem 1.8rem; min-width: 0; max-width: 1160px; }
  .poster { text-align: center; margin-bottom: 0.9rem; }
  .poster .ev { font-size: 0.62rem; letter-spacing: 0.32em; color: var(--fn-live); font-weight: 700; }
  .poster h1 { font-size: clamp(1.5rem, 3.4vw, 2.3rem); letter-spacing: 0.05em; text-transform: uppercase; margin: 0.25rem 0; text-wrap: balance; }
  .poster .sub { color: var(--fn-dim); font-size: 0.82rem; font-style: italic; }
  .tally { display: flex; justify-content: center; gap: 2.2rem; margin: 1rem 0 0.4rem; }
  .tally div { text-align: center; }
  .tally b { display: block; font-size: 1.45rem; color: var(--fn-gold); font-variant-numeric: tabular-nums; font-family: var(--fn-display); }
  .tally span { font-size: 0.58rem; letter-spacing: 0.22em; color: var(--fn-dim); }
  .signals { display: flex; justify-content: center; align-items: center; gap: 0.7rem; margin: 0.7rem 0 1.3rem; flex-wrap: wrap; }
  .fn-clock { font-family: ui-monospace, monospace; color: var(--fn-gold); font-size: 1rem; border: 1px solid var(--fn-gold); border-radius: 8px; padding: 0.25rem 0.85rem; background: var(--fn-panel); }
  .fn-clock small { display: block; font-size: 0.56rem; letter-spacing: 0.2em; color: var(--fn-dim); }
  .fn-clock em { font-style: normal; font-size: 0.62rem; color: var(--fn-dim); }
  .sig { display: flex; align-items: center; gap: 0.4rem; font-family: ui-monospace, monospace; font-size: 0.64rem; color: var(--fn-dim); border: 1px solid var(--fn-line); border-radius: 7px; padding: 0.3rem 0.7rem; background: var(--fn-panel); }
  .sig i { width: 8px; height: 8px; border-radius: 50%; }
  .fn-panel { background: var(--fn-panel); border: 1px solid var(--fn-line); padding: 1rem 1.2rem; margin-bottom: 1.2rem; box-shadow: var(--fn-shadow); }
  .fn-panel-title { font-size: 0.62rem; letter-spacing: 0.3em; color: var(--fn-gold); margin: 0 0 0.7rem; font-family: var(--fn-display); }
  .floor { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.9rem; }
  @media (max-width: 980px) { .floor { grid-template-columns: repeat(2, minmax(0, 1fr)); } .fn-layout { grid-template-columns: 1fr; } .fn-side-col { border-right: none; border-bottom: 1px solid var(--fn-line); } }
  .floor-col h6 { font-size: 0.6rem; letter-spacing: 0.2em; color: var(--fn-dim); margin: 0 0 0.55rem; display: flex; justify-content: space-between; }
  .col-ring h6 { color: var(--fn-live); } .col-judges h6 { color: var(--fn-gold); } .col-books h6 { color: var(--fn-win); }
  .floor-empty { color: var(--fn-faint); text-align: center; padding: 1rem 0; }
  .bout { background: var(--fn-bg); border: 1px solid var(--fn-line); border-top: 3px solid var(--fn-faint); padding: 0.7rem 0.8rem; margin-bottom: 0.7rem; font-size: 0.82rem; }
  .bout-ring { border-top-color: var(--fn-live); }
  .bout-judges { border-top-color: var(--fn-gold); }
  .bout-books { border-top-color: var(--fn-win); opacity: 0.85; }
  .bout-failed { border-color: var(--fn-live); }
  .bout-head { display: flex; align-items: baseline; gap: 0.45rem; flex-wrap: wrap; }
  .bout-repo { font-size: 0.6rem; letter-spacing: 0.1em; color: var(--fn-faint); font-family: ui-monospace, monospace; }
  .bout-title { font-weight: 600; flex: 1 1 100%; line-height: 1.35; }
  .bout-status { font-size: 0.74rem; margin-top: 0.25rem; }
  .log-row { font-size: 0.78rem; padding: 0.3rem 0; border-bottom: 1px dashed var(--fn-line); }
  .log-row:last-child { border-bottom: none; }
  .log-row summary { display: grid; grid-template-columns: 52px 1fr; gap: 0.7rem; cursor: pointer; list-style: none; }
  .log-row summary::-webkit-details-marker { display: none; }
  .log-row summary:hover { color: var(--fn-ink); }
  .log-row time { font-family: ui-monospace, monospace; color: var(--fn-dim); font-size: 0.68rem; padding-top: 1px; }
  .log-full { margin: 0.5rem 0 0.3rem 52px; padding: 0.6rem 0.8rem; background: color-mix(in srgb, var(--fn-panel) 60%, var(--fn-bg)); border-left: 2px solid var(--fn-gold); white-space: pre-wrap; word-break: break-word; font-size: 0.76rem; color: var(--fn-ink); max-height: 320px; overflow-y: auto; }
  .log-gh { display: inline-block; margin: 0.25rem 0 0.2rem 52px; font-size: 0.68rem; letter-spacing: 0.08em; color: var(--fn-gold); text-decoration: none; }
  .log-gh:hover { text-decoration: underline; }
  .lk-win { color: var(--fn-win); } .lk-live { color: var(--fn-live); } .lk-gold { color: var(--fn-gold); }
  .log-who { color: var(--fn-dim); }
  .log-where { color: var(--fn-faint); font-family: ui-monospace, monospace; font-size: 0.68rem; }
  .corner-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.2rem; }
  /* legacy blocks, recolored by tokens */
  .card { border: 1px solid var(--fn-line); background: var(--fn-panel); padding: 1rem 1.2rem; margin: 0; box-shadow: var(--fn-shadow); }
  .card h2 { font-size: 1rem; margin: 0 0 0.4rem; font-family: var(--fn-display); }
  .attention { border-color: var(--fn-gold); }
  .attention ul { margin: 0.4rem 0 0; padding-left: 1.1rem; } .attention li { margin: 0.45rem 0; font-size: 0.85rem; }
  .notice { border: 1px solid var(--fn-win); background: transparent; border-radius: 8px; padding: 0.6rem 1rem; margin-bottom: 1rem; font-size: 0.88rem; }
  .trail { font-size: 0.74rem; margin-top: 0.3rem; }
  .trail-sep { opacity: 0.5; margin: 0 0.2rem; }
  .trail-branch { opacity: 0.55; font-family: ui-monospace, monospace; font-size: 0.68rem; }
  .trail-pending { opacity: 0.55; font-style: italic; }
  .pickup-warn { font-size: 0.74rem; color: var(--fn-gold); margin-top: 0.3rem; }
  .branch-line { font-size: 0.74rem; margin-top: 0.25rem; }
  .fresh-ok { color: var(--fn-win); } .fresh-warn { color: var(--fn-gold); }
  .checklist { margin-top: 0.4rem; border-left: 3px solid var(--fn-gold); padding: 0.2rem 0 0.2rem 0.7rem; }
  .checklist-head { font-size: 0.74rem; font-weight: 600; }
  .checklist ul { list-style: none; margin: 0.25rem 0 0; padding: 0; }
  .checklist li { padding: 0.15rem 0; font-size: 0.74rem; }
  .checklist li.addressed { opacity: 0.6; }
  .point-meta { opacity: 0.6; font-size: 0.68rem; }
  .threads { margin-top: 0.4rem; border-left: 3px solid var(--fn-gold); padding: 0.2rem 0 0.2rem 0.7rem; }
  .threads-head { font-size: 0.74rem; font-weight: 600; }
  .threads ul { list-style: none; margin: 0.25rem 0 0; padding: 0; }
  .threads li { padding: 0.2rem 0; font-size: 0.74rem; }
  .thread-snippet { font-size: 0.74rem; } .thread-meta { font-size: 0.68rem; opacity: 0.75; }
  .thread-meta .waiting { color: var(--fn-gold); } .resolved-ok { color: var(--fn-win); }
  .ci { font-size: 0.68rem; padding: 1px 7px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
  .ci-green { color: var(--fn-win); border-color: var(--fn-win); }
  .ci-red { color: var(--fn-live); border-color: var(--fn-live); }
  .ci-pending { color: var(--fn-gold); border-color: var(--fn-gold); }
  .ci-none { color: var(--fn-dim); border-color: var(--fn-line); }
  .accept { margin-top: 0.5rem; border: 1px solid var(--fn-win); padding: 0.6rem 0.8rem; }
  .plain-summary { font-size: 0.8rem; margin-bottom: 0.45rem; }
  .accept-btn { font: inherit; font-weight: 600; padding: 0.4rem 1rem; border: none; background: var(--fn-win); color: #fff; cursor: pointer; }
  .accept-btn[disabled] { background: var(--fn-faint); cursor: not-allowed; }
  .accept-alt { font-size: 0.74rem; margin-left: 0.7rem; }
  .ctl { display: inline; margin-left: auto; }
  .stop-btn { background: transparent; color: var(--fn-live); border: 1px solid var(--fn-live); padding: 0.1rem 0.6rem; font-size: 0.68rem; cursor: pointer; }
  .relaunch-btn { background: transparent; color: var(--fn-win); border: 1px solid var(--fn-win); padding: 0.1rem 0.6rem; font-size: 0.68rem; cursor: pointer; }
  .action { font-weight: 600; }
  form label { display: block; font-weight: 600; margin: 0.7rem 0 0.25rem; font-size: 0.84rem; }
  textarea, select { width: 100%; font: inherit; padding: 0.5rem; border-radius: 8px; border: 1px solid var(--fn-line); background: var(--fn-bg); color: var(--fn-ink); }
  textarea { min-height: 96px; resize: vertical; }
  button { font: inherit; }
  .card form > button, .coach-form button { margin-top: 0.8rem; font-weight: 600; padding: 0.5rem 1.2rem; border-radius: 8px; border: none; background: var(--fn-gold); color: var(--fn-bg); cursor: pointer; }
  .coach-panel .coach-current { margin: 0.3rem 0 0.6rem; font-size: 0.88rem; }
  .coach-form { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .coach-form select { width: auto; flex: 1 1 200px; }
  .coach-form button { margin: 0; }
  .cost-panel p { font-size: 0.85rem; margin: 0.3rem 0; }
  .stopped-note { margin-top: 0.8rem; font-size: 0.8rem; color: var(--fn-dim); }
  .stopped-note summary { cursor: pointer; }
  details.tech { margin-top: 2rem; font-size: 0.78rem; opacity: 0.7; }
  footer { margin-top: 1.4rem; font-size: 0.72rem; opacity: 0.5; }
  .copy-btn { font-size: 0.8rem; background: none; border: 1px solid var(--fn-line); color: var(--fn-ink); border-radius: 8px; padding: 0.4rem 0.9rem; cursor: pointer; }
</style>
</head>
<body>
  <nav class="fn-nav">
    <span class="fn-wordmark">FOREMAN</span>
    <a class="navlink" href="/dashboard">THE CARD</a>
    <a class="navlink" href="#flow">THE FLOW</a>
    <a class="navlink" href="#needs-you">JUDGES&rsquo; TABLE</a>
    <a class="navlink" href="#corner">THE CORNER</a>
    <span class="right">
      ${bell > 0 ? `<a class="bell" href="#needs-you" title="${bell} decision${bell > 1 ? "s" : ""} await you">🔔<b>${bell}</b></a>` : `<span class="bell" title="nothing awaits you">🔔</span>`}
      <form method="post" action="/dashboard/set-coach" class="coach-nav" title="who reviews the fighters' work — applies to the next dispatch">
        <span>Coach:</span>
        <select name="coach" onchange="this.form.submit()">${[{ key: ENV_DEFAULT_KEY, label: ".env default" }, ...COACH_BACKENDS].map((b) => `<option value="${esc(b.key)}"${b.key === coach.key ? " selected" : ""}>${esc(b.label)}</option>`).join("")}</select>
      </form>
      <span class="beat" title="${engineUp ? "engine live" : "engine silent"}"></span>
      <button class="skin-btn" id="skinBtn" onclick="(function(b){var h=document.documentElement;var s=h.dataset.skin==='dark'?'light':'dark';h.dataset.skin=s;try{localStorage.setItem('foreman-skin',s);}catch(e){};b.textContent=s==='dark'?'☀':'🌙';})(this)" title="switch skin">☀</button>
    </span>
  </nav>
  <script>document.getElementById('skinBtn').textContent = document.documentElement.dataset.skin === 'dark' ? '☀' : '🌙';</script>
  <div class="fn-layout">
    <aside class="fn-side-col">
      ${fightCards(allTasks, repos, selectedRepo)}
      ${rosterPanel(allTasks, store)}
    </aside>
    <main class="fn-main">
      ${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
      <div class="poster">
        <div class="ev">★ ${selectedRepo ? "MAIN EVENT" : "TONIGHT'S CARD"} ★</div>
        <h1>${esc(scopeLabel)}</h1>
        <div class="sub">${tally.won + tally.live + tally.you + tally.card === 0 ? "a quiet night — send new work from The Corner below" : `${scoped.filter((t) => t.status !== "stopped").length} bouts${tier ? ` · trust ${esc(tier)}` : ""}`}</div>
      </div>
      <div class="tally">
        <div><b>${tally.won}</b><span>WON</span></div>
        <div><b>${tally.live}</b><span>IN THE RING</span></div>
        <div><b>${tally.you}</b><span>YOUR CORNER</span></div>
        <div><b>${tally.card}</b><span>ON THE CARD</span></div>
      </div>
      <div class="signals">
        ${clock}
        <span class="sig"><i style="background:${engineUp ? "var(--fn-win)" : "var(--fn-live)"}; box-shadow:0 0 6px ${engineUp ? "var(--fn-win)" : "var(--fn-live)"}"></i>ENGINE</span>
        <span class="sig"><i style="background:var(--fn-${ciState})"></i>${esc(ciLabel)}</span>
        ${bell > 0 ? `<span class="sig" style="color:var(--fn-gold); border-color:var(--fn-gold)"><i style="background:var(--fn-gold); box-shadow:0 0 6px var(--fn-gold)"></i>${bell} AWAIT${bell === 1 ? "S" : ""} YOU</span>` : ""}
      </div>
      <div id="flow">${ringPanel(store)}</div>
      ${attention.length
        ? `<section class="card attention fn-panel" id="needs-you"><div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap"><h4 class="fn-panel-title" style="margin:0">🔔 JUDGES&rsquo; TABLE — DECISIONS AWAITED</h4><form method="post" action="/dashboard/archive-stale" style="margin-left:auto" onsubmit="return confirm('Archive everything untouched for 7+ days? Each bout flips to Stopped and can be relaunched.')"><button type="submit" style="margin:0;padding:0.25rem 0.8rem;font-size:0.72rem;background:transparent;color:var(--fn-gold);border:1px solid var(--fn-gold);cursor:pointer">🧹 Archive stale</button></form></div><ul>${attention.join("")}</ul></section>`
        : `<section class="fn-panel" id="needs-you"><h4 class="fn-panel-title" style="color:var(--fn-win)">✓ JUDGES&rsquo; TABLE — CLEAR</h4><p style="margin:0;font-size:0.85rem;color:var(--fn-dim)">Nothing awaits your decision right now.</p></section>`}
      ${floorPanel(scoped, store, threadMap, !selectedRepo)}
      ${refereeLog(store, scopeRepos)}
      ${ghPanel(ghActivity, scopeRepos)}
      <div class="corner-grid" id="corner">
        <section class="card">
          <h2>🚀 Send new work</h2>
          <form method="post" action="/dashboard/new-work">
            <label for="repo">Fight card</label>
            <select name="repo" id="repo" required>${repoOptions}</select>
            <label for="description">What do you want done?</label>
            <textarea name="description" id="description" required placeholder="Describe it like you would to a contractor."></textarea>
            <button type="submit">Send to the team</button>
          </form>
          <p class="point-meta">The coach breaks it into bouts and hands them to the fighters.</p>
        </section>
        ${coachPanel(store)}
        <section class="card cost-panel">
          <h2>💰 Cost</h2>
          <p>${esc(cost.summary)}</p>
          <p class="point-meta">${cost.remainingUsd !== null ? `Remaining budget: $${cost.remainingUsd.toFixed(2)} · used ${cost.usedPct}%` : "No budget ceiling configured."}</p>
        </section>
        ${handoffPanel(store)}
      </div>
      <details class="tech">
        <summary>Referee&rsquo;s book — recent engine jobs</summary>
        <ul>${jobs.map((j) => `<li>job ${j.id} · ${esc(j.type)} · ${esc(j.repo)}#${j.issue} · ${esc(j.status)}${j.error ? ` · ${esc(j.error.slice(0, 140))}` : ""}</li>`).join("")}</ul>
      </details>
      <footer>Refreshes itself · flow every 8s, page every 2 min · ${new Date().toLocaleString()}</footer>
    </main>
  </div>
</body>
</html>`;
}

