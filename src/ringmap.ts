/**
 * The Ring Map — a live visual of the whole loop: You → Coach → GitHub (the
 * referee) → Fighters and back. Circles are actors, arrows are information
 * flow, count bubbles are work sitting on that arrow right now. Red means
 * "this is where it's stuck and needs you."
 *
 * Rendered server-side from the same Store the rest of the dashboard uses;
 * the client re-fetches the fragment every 8s (see /api/ring) so the map
 * moves without a full page reload.
 */
import { config } from "./config.js";
import type { Store, TaskRow } from "./state/db.js";
import { resolveCoachBackend } from "./manager/coach-backends.js";

const COLOR = {
  green: "#2da44e",
  blue: "#316dca",
  purple: "#8957e5",
  amber: "#d29922",
  red: "#cf222e",
  grey: "#6e7681",
  ink: "#e6edf3",
  dim: "#8b949e",
  node: "#161b22",
};

/** Minutes a queued task may wait before the arrow to that fighter turns amber. */
const STALE_MIN = 20;
/** Seconds of silence after which the engine heartbeat turns red. */
const HEARTBEAT_DEAD_S = 45;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function cap(a: string): string {
  return a.charAt(0).toUpperCase() + a.slice(1);
}

interface FighterGlance {
  agent: string;
  queued: number;
  queuedStale: boolean;
  working: number;
  inReview: number;
  fixing: number; // changes_requested
  failed: number;
  rateLimited: boolean;
}

function glance(tasks: TaskRow[], store: Store, agent: string, now: number): FighterGlance {
  const mine = tasks.filter((t) => t.agent === agent);
  const by = (s: string) => mine.filter((t) => t.status === s);
  const queued = by("queued");
  return {
    agent,
    queued: queued.length,
    queuedStale: queued.some((t) => now - t.updated_at > STALE_MIN * 60_000),
    working: by("claimed").length,
    inReview: by("in_review").length,
    fixing: by("changes_requested").length,
    failed: by("failed").length,
    rateLimited: store.agentStatus(agent, now).state === "rate_limited",
  };
}

/** A curved arrow with an optional count bubble at its midpoint. */
function arrow(
  x1: number, y1: number, x2: number, y2: number,
  color: string, count: number, label: string,
  opts: { dashed?: boolean; bend?: number } = {}
): string {
  const bend = opts.bend ?? 0;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 + bend;
  const active = count > 0;
  const stroke = active ? color : COLOR.grey;
  const width = active ? 2.2 : 1.2;
  const flow = active ? ` class="flow"` : "";
  const dash = opts.dashed && !active ? ` stroke-dasharray="3 5"` : "";
  const opacity = active ? 0.95 : 0.35;
  const path = `<path d="M ${x1} ${y1} Q ${mx} ${my} ${x2} ${y2}" fill="none" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}" marker-end="url(#arr-${active ? color.slice(1) : COLOR.grey.slice(1)})"${flow}${dash}/>`;
  const bubble = active
    ? `<g><circle cx="${mx}" cy="${my - bend / 2}" r="13" fill="${color}"/><text x="${mx}" y="${my - bend / 2 + 4.5}" text-anchor="middle" font-size="13" font-weight="700" fill="#fff">${count}</text></g>`
    : "";
  const text = `<text x="${mx}" y="${my - bend / 2 - 19}" text-anchor="middle" font-size="10.5" fill="${active ? COLOR.ink : COLOR.dim}" opacity="${active ? 0.95 : 0.6}">${esc(label)}</text>`;
  return path + text + bubble;
}

function markers(): string {
  const colors = [COLOR.green, COLOR.blue, COLOR.purple, COLOR.amber, COLOR.red, COLOR.grey];
  return colors
    .map(
      (c) =>
        `<marker id="arr-${c.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${c}"/></marker>`
    )
    .join("");
}

export function renderRingSvg(store: Store): string {
  const now = Date.now();
  const tasks = store.listTasks();
  const agents = config.agents;
  const coach = resolveCoachBackend(store);
  const fighters = agents.map((a) => glance(tasks, store, a, now));

  const approved = tasks.filter((t) => t.status === "approved").length;
  const doneTotal = tasks.filter((t) => t.status === "done").length;
  const jobs = store.recentJobs(50);
  const coachBusy = jobs.filter((j) => j.status === "pending" || j.status === "running").length;

  // Heartbeat: the worker loop stamps this every tick (15s). Silence = engine down.
  const lastTick = parseInt(store.getSetting("last_worker_tick") ?? "0", 10);
  const beatAgeS = lastTick ? Math.round((now - lastTick) / 1000) : Infinity;
  const engineUp = beatAgeS < HEARTBEAT_DEAD_S;

  // Geometry — fighters stack on the right; height follows the roster.
  const W = 980;
  const rowH = 128;
  const H = Math.max(430, agents.length * rowH + 120);
  const midY = H / 2;
  const you = { x: 92, y: midY };
  const co = { x: 320, y: midY };
  const gh = { x: 585, y: midY };
  const fx = 858;
  const fy = (i: number) => midY + (i - (agents.length - 1) / 2) * rowH;

  const parts: string[] = [];

  // --- Edges first (under the nodes) ---
  parts.push(arrow(you.x + 46, you.y, co.x - 52, co.y, COLOR.blue, 0, "you ask · you approve"));
  parts.push(arrow(co.x + 52, co.y - 12, gh.x - 62, gh.y - 12, COLOR.blue, coachBusy, "briefs & verdicts", { bend: -34 }));
  parts.push(arrow(gh.x - 62, gh.y + 14, co.x + 52, co.y + 14, COLOR.purple,
    jobs.filter((j) => j.type === "review" && (j.status === "pending" || j.status === "running")).length,
    "PRs waiting for review", { bend: 34 }));

  fighters.forEach((f, i) => {
    const y = fy(i);
    const toColor = f.queuedStale ? COLOR.amber : COLOR.green;
    parts.push(arrow(gh.x + 62, gh.y + (y - gh.y) * 0.25, fx - 52, y - 10, toColor, f.queued + f.fixing,
      f.fixing > 0 ? "tasks + fixes to do" : "tasks to pick up", { bend: (y - gh.y) * 0.3 }));
    parts.push(arrow(fx - 52, y + 12, gh.x + 62, gh.y + (y - gh.y) * 0.25 + 20, COLOR.purple, f.inReview,
      "work sent back (PRs)", { bend: (y - gh.y) * 0.3 + 26 }));
  });

  // --- Nodes ---
  const nodeCircle = (x: number, y: number, r: number, stroke: string, pulse: boolean) =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="${COLOR.node}" stroke="${stroke}" stroke-width="2.5"${pulse ? ` class="pulse"` : ""}/>`;

  // You
  parts.push(nodeCircle(you.x, you.y, 42, COLOR.blue, false));
  parts.push(`<text x="${you.x}" y="${you.y - 2}" text-anchor="middle" font-size="15" font-weight="700" fill="${COLOR.ink}">You</text>`);
  parts.push(`<text x="${you.x}" y="${you.y + 16}" text-anchor="middle" font-size="10" fill="${COLOR.dim}">the owner</text>`);

  // Coach
  const coachStroke = config.managerDisabled ? COLOR.red : coachBusy > 0 ? COLOR.purple : COLOR.green;
  parts.push(nodeCircle(co.x, co.y, 48, coachStroke, coachBusy > 0));
  parts.push(`<text x="${co.x}" y="${co.y - 8}" text-anchor="middle" font-size="15" font-weight="700" fill="${COLOR.ink}">Coach</text>`);
  parts.push(`<text x="${co.x}" y="${co.y + 10}" text-anchor="middle" font-size="10" fill="${COLOR.dim}">${esc(coach.label.length > 26 ? coach.label.slice(0, 25) + "…" : coach.label)}</text>`);
  parts.push(`<text x="${co.x}" y="${co.y + 24}" text-anchor="middle" font-size="10" fill="${coachBusy > 0 ? COLOR.purple : COLOR.dim}">${coachBusy > 0 ? `thinking on ${coachBusy} job${coachBusy > 1 ? "s" : ""}` : "idle"}</text>`);

  // GitHub (referee) — rounded square
  parts.push(`<rect x="${gh.x - 58}" y="${gh.y - 46}" width="116" height="92" rx="16" fill="${COLOR.node}" stroke="${approved > 0 ? COLOR.green : COLOR.grey}" stroke-width="2.5"/>`);
  parts.push(`<text x="${gh.x}" y="${gh.y - 18}" text-anchor="middle" font-size="15" font-weight="700" fill="${COLOR.ink}">GitHub</text>`);
  parts.push(`<text x="${gh.x}" y="${gh.y - 2}" text-anchor="middle" font-size="10" fill="${COLOR.dim}">the referee — issues, PRs, CI</text>`);
  parts.push(`<text x="${gh.x}" y="${gh.y + 18}" text-anchor="middle" font-size="10.5" fill="${approved > 0 ? COLOR.green : COLOR.dim}">${approved > 0 ? `✅ ${approved} approved, waiting merge` : "nothing waiting to merge"}</text>`);
  parts.push(`<text x="${gh.x}" y="${gh.y + 34}" text-anchor="middle" font-size="10" fill="${COLOR.dim}">${doneTotal} merged so far</text>`);

  // Fighters
  fighters.forEach((f, i) => {
    const y = fy(i);
    const stroke = f.failed > 0 || f.rateLimited ? COLOR.red : f.queuedStale || f.fixing > 0 ? COLOR.amber : f.working > 0 ? COLOR.green : COLOR.grey;
    parts.push(nodeCircle(fx, y, 44, stroke, f.working > 0));
    parts.push(`<text x="${fx}" y="${y - 10}" text-anchor="middle" font-size="13.5" font-weight="700" fill="${COLOR.ink}">${esc(cap(f.agent))}</text>`);
    const line2 = f.rateLimited ? "⛔ rate-limited"
      : f.failed > 0 ? `🔴 ${f.failed} stuck — needs you`
      : f.working > 0 ? `🟢 working on ${f.working}`
      : f.queued > 0 ? (f.queuedStale ? `🟡 ${f.queued} waiting too long` : `${f.queued} queued`)
      : "idle";
    parts.push(`<text x="${fx}" y="${y + 8}" text-anchor="middle" font-size="10" fill="${stroke === COLOR.grey ? COLOR.dim : stroke}">${esc(line2)}</text>`);
    if (f.inReview > 0) parts.push(`<text x="${fx}" y="${y + 22}" text-anchor="middle" font-size="10" fill="${COLOR.purple}">${f.inReview} under review</text>`);
  });

  // --- Heartbeat strip (top-left) ---
  const beatColor = engineUp ? COLOR.green : COLOR.red;
  const beatText = engineUp
    ? `engine live — last tick ${beatAgeS}s ago`
    : lastTick
      ? `⚠️ engine silent for ${beatAgeS < 3600 ? Math.round(beatAgeS / 60) + " min" : Math.round(beatAgeS / 3600) + " h"} — jobs are NOT being processed`
      : "⚠️ engine has never ticked — is the app running?";
  parts.push(`<circle cx="26" cy="26" r="7" fill="${beatColor}"${engineUp ? ` class="pulse"` : ""}/>`);
  parts.push(`<text x="42" y="30" font-size="12" font-weight="600" fill="${beatColor}">${esc(beatText)}</text>`);

  // Legend (bottom)
  const ly = H - 16;
  parts.push(`<text x="20" y="${ly}" font-size="10.5" fill="${COLOR.dim}">arrows = information flow · bubbles = items on that path right now · 🟢 moving · 🟡 waiting too long · 🔴 stuck, needs your decision · updates every 8s</text>`);

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Live map of the agent loop" style="width:100%;height:auto;display:block">
  <style>
    .flow { stroke-dasharray: 7 5; animation: ringflow 0.9s linear infinite; }
    .pulse { animation: ringpulse 2s ease-in-out infinite; }
    @keyframes ringflow { to { stroke-dashoffset: -24; } }
    @keyframes ringpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
    @media (prefers-reduced-motion: reduce) { .flow, .pulse { animation: none; } }
    text { font-family: -apple-system, "Segoe UI", sans-serif; }
  </style>
  <defs>${markers()}</defs>
  ${parts.join("\n  ")}
</svg>`;
}

/** The dashboard card wrapping the SVG + the 8s auto-refresh script. */
export function ringPanel(store: Store): string {
  return `<section class="card" style="padding:0.8rem 1rem">
    <div id="ringmap">${renderRingSvg(store)}</div>
    <script>
      (function () {
        async function refreshRing() {
          try {
            const r = await fetch('/api/ring');
            if (r.ok) document.getElementById('ringmap').innerHTML = await r.text();
          } catch (e) { /* server briefly away — the next tick will catch up */ }
        }
        setInterval(refreshRing, 8000);
      })();
    </script>
  </section>`;
}
