import { config } from "./config.js";
import { forecastRunCost } from "./cost-forecast.js";
import type { CommentRow, JobRow, RevisionPointRow, Store, TaskRow } from "./state/db.js";
import { taskBranch } from "./protocol/labels.js";
import type { BranchState, CiState, ThreadOverview, ThreadSummary } from "./threads.js";
import type { TrustTier } from "./referee/readiness.js";
import { COACH_BACKENDS, ENV_DEFAULT_KEY, resolveCoachBackend } from "./manager/coach-backends.js";

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

export function renderDashboard(
  store: Store,
  repos: RepoOption[],
  notice?: string,
  threadMap: ThreadMap = {},
  repoBranches: RepoBranches = {},
  trustTiers: Record<string, string> = {}
): string {
  const tasks = store.listTasks();
  const jobs = store.recentJobs(10);
  const repoNames = [...new Set(tasks.map((t) => t.repo))];
  const attention = attentionItems(tasks, jobs, store, threadMap);
  const working = tasks.filter((t) => ["claimed", "in_review", "changes_requested"].includes(t.status)).length;
  const cost = forecastRunCost(store);

  const costHtml = `<section class="card cost-panel">
    <h2>💰 Cost forecast</h2>
    <p>${esc(cost.summary)}</p>
    <p class="point-meta">
      ${cost.remainingUsd !== null ? `Remaining budget: <strong>$${cost.remainingUsd.toFixed(2)}</strong> · Used: <strong>${cost.usedPct}%</strong>` : "No budget ceiling configured."}
    </p>
  </section>`;

  const attentionHtml = attention.length
    ? `<section class="card attention"><h2>👋 Needs you</h2><ul>${attention.join("")}</ul></section>`
    : `<section class="card calm"><h2>✅ Nothing needs you right now</h2><p>${
        working > 0
          ? `Your AI team is working on ${working} thing${working > 1 ? "s" : ""}. Check back later.`
          : tasks.length === 0
            ? `No work in progress yet. Describe what you want below to get started.`
            : `All quiet. Request new work below whenever you're ready.`
      }</p></section>`;

  const projects = repoNames
    .map((r) => projectCard(r, tasks.filter((t) => t.repo === r), store, threadMap, repoBranches, trustTiers))
    .join("");

  const repoOptions = repos
    .map((r) => `<option value="${esc(r.fullName)}">${esc(projectName(r.fullName))}</option>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="60">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My AI team</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1.2rem; line-height: 1.5; }
  h1 { font-size: 1.6rem; margin-bottom: 0.2rem; }
  .subtitle { opacity: 0.65; margin-top: 0; }
  .card { border: 1px solid #8883; border-radius: 12px; padding: 1.1rem 1.4rem; margin: 1.2rem 0; }
  .card h2 { font-size: 1.15rem; margin: 0 0 0.4rem; }
  .attention { border-color: #d4a72c88; background: #d4a72c12; }
  .calm { border-color: #2da44e55; background: #2da44e0d; }
  .attention ul { margin: 0.4rem 0 0; padding-left: 1.2rem; } .attention li { margin: 0.45rem 0; }
  .card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
  .progress-label { font-size: 0.85rem; opacity: 0.65; }
  .tier-badge { font-size: 0.78rem; padding: 2px 10px; border-radius: 999px; border: 1px solid #8885; }
  .bar { height: 8px; border-radius: 99px; background: #8883; overflow: hidden; margin: 0.5rem 0 1rem; }
  .bar-fill { height: 100%; background: #2da44e; transition: width 0.4s; }
  .items { list-style: none; margin: 0; padding: 0; }
  .items li { padding: 0.5rem 0; border-top: 1px solid #8882; }
  .item-row { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
  .last-comment { font-size: 0.8rem; opacity: 0.7; margin: 0.25rem 0 0 1.35rem; }
  .pickup-warn { font-size: 0.83rem; color: #d29922; margin: 0.25rem 0 0 1.35rem; }
  .trail { font-size: 0.8rem; margin: 0.3rem 0 0 1.35rem; }
  .trail-sep { opacity: 0.5; margin: 0 0.2rem; }
  .trail-branch { opacity: 0.5; font-family: ui-monospace, monospace; font-size: 0.74rem; }
  .trail-pending { opacity: 0.55; font-style: italic; }
  .checklist { margin: 0.45rem 0 0.2rem 1.35rem; border-left: 3px solid #d2992255; padding: 0.3rem 0 0.3rem 0.8rem; }
  .checklist-head { font-size: 0.83rem; font-weight: 600; }
  .checklist ul { list-style: none; margin: 0.3rem 0 0; padding: 0; }
  .checklist li { padding: 0.2rem 0; border-top: none; font-size: 0.83rem; }
  .checklist li.addressed { opacity: 0.65; }
  .point-meta { opacity: 0.6; font-size: 0.74rem; }
  .branch-line { font-size: 0.8rem; margin: 0.25rem 0 0 1.35rem; }
  .fresh-ok { color: #2da44e; }
  .fresh-warn { color: #d29922; }
  .workloads { margin: 0 0 0.6rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .workload { font-size: 0.78rem; padding: 2px 10px; border-radius: 999px; border: 1px solid #8885; }
  .workload-over { color: #cf222e; border-color: #cf222e88; background: #cf222e12; }
  .ctl { display: inline; margin-left: auto; }
  .stop-btn { background: transparent; color: #cf222e; border: 1px solid #cf222e88; padding: 0.15rem 0.7rem; font-size: 0.78rem; }
  .relaunch-btn { background: transparent; color: #2da44e; border: 1px solid #2da44e88; padding: 0.15rem 0.7rem; font-size: 0.78rem; }
  .ci { font-size: 0.76rem; padding: 1px 8px; border-radius: 999px; border: 1px solid; white-space: nowrap; }
  .ci-green { color: #2da44e; border-color: #2da44e66; background: #2da44e14; }
  .ci-red { color: #cf222e; border-color: #cf222e66; background: #cf222e14; }
  .ci-pending { color: #d4a72c; border-color: #d4a72c66; background: #d4a72c14; }
  .ci-none { color: #888; border-color: #8886; }
  .accept { margin: 0.6rem 0 0.2rem 1.35rem; border: 1px solid #2da44e55; background: #2da44e0d; border-radius: 10px; padding: 0.7rem 0.9rem; }
  .plain-summary { font-size: 0.9rem; margin-bottom: 0.55rem; }
  .accept-btn { margin: 0; padding: 0.45rem 1.2rem; }
  .accept-btn[disabled] { background: #8886; cursor: not-allowed; }
  .accept-alt { font-size: 0.8rem; margin-left: 0.8rem; }
  .threads { margin: 0.45rem 0 0.2rem 1.35rem; border-left: 3px solid #8957e555; padding: 0.3rem 0 0.3rem 0.8rem; }
  .threads-head { font-size: 0.83rem; font-weight: 600; }
  .threads ul { list-style: none; margin: 0.3rem 0 0; padding: 0; }
  .threads li { padding: 0.3rem 0; border-top: none; }
  .thread-snippet { font-size: 0.83rem; }
  .thread-meta { font-size: 0.76rem; opacity: 0.7; }
  .thread-meta .waiting { color: #d29922; }
  .resolved-ok { color: #2da44e; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; position: relative; top: 1px; }
  .item-title { font-weight: 600; flex: 1 1 280px; }
  .item-status { font-size: 0.88rem; flex: 1 1 240px; }
  .card-foot { margin: 0.8rem 0 0; font-size: 0.85rem; }
  a { color: #316dca; text-decoration: none; } a:hover { text-decoration: underline; }
  .action { font-weight: 600; }
  form label { display: block; font-weight: 600; margin: 0.8rem 0 0.25rem; }
  textarea, select { width: 100%; box-sizing: border-box; font: inherit; padding: 0.55rem; border-radius: 8px; border: 1px solid #8886; }
  textarea { min-height: 110px; resize: vertical; }
  button { margin-top: 0.9rem; font: inherit; font-weight: 600; padding: 0.55rem 1.4rem; border-radius: 8px; border: none; background: #2da44e; color: white; cursor: pointer; }
  button:hover { filter: brightness(1.08); }
  .notice { border: 1px solid #2da44e88; background: #2da44e15; border-radius: 8px; padding: 0.7rem 1rem; }
  .coach-panel .coach-current { margin: 0.3rem 0 0.7rem; }
  .coach-form { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .coach-form select { width: auto; flex: 1 1 220px; }
  .coach-form button { margin: 0; }
  .cost-panel .cost-total { font-size: 1rem; margin: 0.3rem 0 0.5rem; }
  .cost-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-top: 0.5rem; }
  .cost-table th, .cost-table td { padding: 0.3rem 0.6rem; text-align: left; border-bottom: 1px solid #8882; }
  .cost-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .trust-panel .trust-badge { display: inline-block; font-weight: 700; font-size: 1rem; border: 2px solid; border-radius: 8px; padding: 0.25rem 0.8rem; margin: 0.3rem 0 0.4rem; }
  .trust-detail { font-size: 0.88rem; margin: 0 0 0.6rem; }
  .trust-ladder { display: flex; flex-direction: column; gap: 0.35rem; }
  .trust-step { border: 1px solid #8883; border-radius: 8px; padding: 0.35rem 0.7rem; opacity: 0.55; }
  .trust-step.trust-active { opacity: 1; border-width: 2px; background: #8880; }
  details { margin-top: 2.5rem; font-size: 0.85rem; opacity: 0.75; }
  footer { margin-top: 1.5rem; font-size: 0.78rem; opacity: 0.5; }
</style>
</head>
<body>
  <h1>🤖 My AI team</h1>
  <p class="subtitle">${agentName(config.agents[0] ?? "")}${config.agents.length > 1 ? " and " + config.agents.slice(1).map(agentName).join(", ") : ""} do the work · a coach checks everything · you approve the results</p>
  ${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
  ${coachPanel(store)}
  ${costHtml}
  ${attentionHtml}
  ${projects}
  <section class="card">
    <h2>🚀 Request new work</h2>
    <form method="post" action="/dashboard/new-work">
      <label for="repo">Project</label>
      <select name="repo" id="repo" required>${repoOptions}</select>
      <label for="description">What do you want done?</label>
      <textarea name="description" id="description" required placeholder="Describe it like you would to a contractor. Example: Add a contact form to the website that emails me when someone fills it in."></textarea>
      <button type="submit">Send to the team</button>
    </form>
    <p class="card-foot">The coach will break this into tasks and hand them to the fighters. Items will appear above within a few minutes.</p>
  </section>
  ${handoffPanel(store)}
  <details>
    <summary>Technical details</summary>
    <ul>${jobs.map((j) => `<li>job ${j.id} · ${esc(j.type)} · ${esc(j.repo)}#${j.issue} · ${esc(j.status)}${j.error ? ` · ${esc(j.error.slice(0, 140))}` : ""}</li>`).join("")}</ul>
  </details>
  <footer>This page refreshes itself every minute · ${new Date().toLocaleString()}</footer>
</body>
</html>`;
}
