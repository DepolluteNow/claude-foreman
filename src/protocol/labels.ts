/** Label and branch conventions — the visible half of the protocol. */

export const LABEL_TASK = "agent-task"; // marks an issue as a dispatchable task
export const LABEL_EPIC = "epic"; // marks an issue for manager decomposition

export type TaskStatus =
  | "queued"
  | "dispatched" // Coach assigned a Fighter; no PR yet (between queued and claimed)
  | "claimed"
  | "in_review"
  | "changes_requested"
  | "approved"
  | "merged_staging" // merged to a staging branch; awaiting promotion to main
  | "done"
  | "failed"
  | "stopped"; // halted by the owner; relaunch returns it to queued

export function agentLabel(agent: string): string {
  return `agent:${agent}`;
}

export function statusLabel(status: TaskStatus): string {
  return `status:${status.replace(/_/g, "-")}`;
}

export function parseAgentLabel(label: string): string | null {
  return label.startsWith("agent:") ? label.slice("agent:".length) : null;
}

export function taskBranch(agent: string, issueNumber: number): string {
  return `agent/${agent}/${issueNumber}`;
}

/** Extract (agent, issue) from a branch name following the convention, else null. */
export function parseTaskBranch(ref: string): { agent: string; issue: number } | null {
  const m = ref.match(/^agent\/([a-z0-9-]+)\/(\d+)$/);
  return m ? { agent: m[1], issue: parseInt(m[2], 10) } : null;
}

export const ALL_STATUS: TaskStatus[] = [
  "queued",
  "dispatched",
  "claimed",
  "in_review",
  "changes_requested",
  "approved",
  "merged_staging",
  "done",
  "failed",
  "stopped",
];

export interface LabelDef {
  name: string;
  color: string;
  description: string;
}

/** Every label the protocol needs in a repo — shared by the onboarding handler and the ensure-labels script. */
export function labelDefinitions(agents: string[], holdLabel: string): LabelDef[] {
  return [
    { name: LABEL_TASK, color: "1d76db", description: "Dispatchable task for an AI fighter" },
    { name: LABEL_EPIC, color: "5319e7", description: "Epic — coach will decompose into tasks" },
    { name: holdLabel, color: "cf222e", description: "Do not auto-merge — the owner will merge manually" },
    ...agents.map((a) => ({ name: agentLabel(a), color: "0e8a16", description: `Routed to agent: ${a}` })),
    ...ALL_STATUS.map((s) => ({ name: statusLabel(s), color: "fbca04", description: `Task status: ${s}` })),
    // Epic milestones — M0 through M5 (extend as the project grows)
    ...["M0", "M1", "M2", "M3", "M4", "M5", "M6"].map((m) => ({
      name: `epic:${m}`,
      color: "5319e7",
      description: `Epic milestone ${m}`,
    })),
    // Weight tiers — used by the Coach to gauge effort
    { name: "weight:flyweight", color: "c5def5", description: "Trivial — <30 min, one file" },
    { name: "weight:lightweight", color: "c5def5", description: "Small — 1-2 hours, few files" },
    { name: "weight:middleweight", color: "c5def5", description: "Medium — half day, multiple files" },
    { name: "weight:heavyweight", color: "c5def5", description: "Large — full day+, architectural" },
    // Recipe labels — contributed patterns (M5-6)
    { name: "recipe:ci-sweeper", color: "bfd4f2", description: "Recipe: CI-Sweeper pattern" },
    { name: "recipe:dependency-sweeper", color: "bfd4f2", description: "Recipe: Dependency-Sweeper pattern" },
    { name: "recipe:changelog-drafter", color: "bfd4f2", description: "Recipe: Changelog-Drafter pattern" },
    { name: "recipe:issue-triage", color: "bfd4f2", description: "Recipe: Issue-Triage pattern" },
    { name: "recipe:post-merge-cleanup", color: "bfd4f2", description: "Recipe: Post-Merge-Cleanup pattern" },
    { name: "recipe:daily-triage", color: "bfd4f2", description: "Recipe: Daily-Triage pattern" },
    { name: "recipe:pr-babysitter", color: "bfd4f2", description: "Recipe: PR-Babysitter pattern" },
    // Role labels — who is acting
    { name: "role:coach", color: "fef2c0", description: "Acting as Coach (plan/judge)" },
    { name: "role:fighter", color: "fef2c0", description: "Acting as Fighter (execute)" },
    { name: "role:referee", color: "fef2c0", description: "Acting as Referee (gate)" },
    { name: "role:panel", color: "fef2c0", description: "Acting as panel member" },
    { name: "role:judge", color: "fef2c0", description: "Acting as judge (test-grounded)" },
    { name: "role:writer", color: "fef2c0", description: "Acting as writer (synthesizer)" },
  ];
}

/**
 * Statuses that indicate a task is actively being worked on or has been completed.
 * A Fighter MUST NOT pick up a task in any of these states.
 * Used by the anti-collision guard (G10) to prevent duplicate work.
 */
export const TAKEN_STATUSES: TaskStatus[] = [
  "dispatched",
  "claimed",
  "in_review",
  "changes_requested",
  "approved",
  "merged_staging",
  "done",
];

/** True if the status means the task is taken or completed — do not pick up. */
export function isStatusTaken(status: TaskStatus): boolean {
  return TAKEN_STATUSES.includes(status);
}

/**
 * Valid forward transitions from each status.
 * Prevents illegal jumps (e.g. queued → done without going through review).
 */
export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  const transitions: Record<TaskStatus, TaskStatus[]> = {
    queued: ["dispatched", "claimed", "stopped", "failed"],
    dispatched: ["claimed", "queued", "stopped", "failed"],
    claimed: ["in_review", "queued", "stopped", "failed"],
    in_review: ["changes_requested", "approved", "queued", "stopped", "failed"],
    changes_requested: ["in_review", "queued", "stopped", "failed"],
    approved: ["merged_staging", "done", "stopped", "failed"],
    merged_staging: ["done", "stopped", "failed"],
    done: [],
    failed: ["queued", "stopped"],
    stopped: ["queued"],
  };
  return transitions[from]?.includes(to) ?? false;
}
