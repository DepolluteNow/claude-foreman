import { describe, expect, it } from "vitest";
import { pickupVerdict, getEscalations, costPanel, trustTierPanel, renderDashboard } from "../src/dashboard.js";
import { Store } from "../src/state/db.js";
import type { CommentRow, JobRow, TaskRow } from "../src/state/db.js";

const NOW = 1_000_000_000_000;
const MIN = 60_000;

function task(overrides: Partial<TaskRow>): TaskRow {
  return {
    repo: "o/r",
    issue: 1,
    installation_id: 1,
    agent: "antigravity",
    status: "queued",
    title: "t",
    plain_summary: null,
    pr: null,
    lease_expires_at: null,
    stale_warned_at: null,
    revision_round: 0,
    reassign_count: 0,
    created_at: NOW - 60 * MIN,
    updated_at: NOW - 60 * MIN,
    ...overrides,
  };
}

describe("pickupVerdict", () => {
  it("warns when a queued task sits past the grace period", () => {
    expect(pickupVerdict(task({ updated_at: NOW - 30 * MIN }), undefined, NOW)).toMatch(/hasn't picked this up/);
  });

  it("stays quiet for freshly queued tasks", () => {
    expect(pickupVerdict(task({ updated_at: NOW - 5 * MIN }), undefined, NOW)).toBeNull();
  });

  it("stays quiet once the task is claimed", () => {
    expect(pickupVerdict(task({ status: "claimed", updated_at: NOW - 120 * MIN }), undefined, NOW)).toBeNull();
  });

  it("warns when a revision request has gone unanswered", () => {
    const last: CommentRow = {
      repo: "o/r",
      issue: 1,
      author: "agent-manager[bot]",
      snippet: "fix things",
      msg_type: "revision-request",
      msg_from: "manager",
      created_at: NOW - 45 * MIN,
    };
    expect(pickupVerdict(task({ status: "changes_requested" }), last, NOW)).toMatch(/hasn't responded/);
  });

  it("stays quiet when the agent replied after the revision request", () => {
    const last: CommentRow = {
      repo: "o/r",
      issue: 1,
      author: "hayssamhob",
      snippet: "on it",
      msg_type: "progress",
      msg_from: "antigravity",
      created_at: NOW - 5 * MIN,
    };
    expect(pickupVerdict(task({ status: "changes_requested" }), last, NOW)).toBeNull();
  });
});

describe("getEscalations", () => {
  const store = new Store(":memory:");
  const noJobs: JobRow[] = [];
  const emptyMap = {};

  it("returns empty for a task in healthy claimed state", () => {
    const t = task({ status: "claimed", updated_at: NOW - 5 * MIN });
    expect(getEscalations([t], noJobs, store, emptyMap, NOW)).toEqual([]);
  });

  it("returns warn for a queued task past the grace period", () => {
    const t = task({ status: "queued", updated_at: NOW - 30 * MIN });
    const items = getEscalations([t], noJobs, store, emptyMap, NOW);
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe("warn");
    expect(items[0].reason).toMatch(/hasn't picked this up/);
    expect(items[0].actionUrl).toContain("/issues/");
  });

  it("returns error for a failed task", () => {
    const t = task({ status: "failed" });
    const items = getEscalations([t], noJobs, store, emptyMap, NOW);
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe("error");
  });

  it("returns empty for healthy claimed task with fresh branch", () => {
    const t = task({ status: "claimed", updated_at: NOW - 5 * MIN });
    expect(getEscalations([t], noJobs, store, emptyMap, NOW)).toHaveLength(0);
  });
});

describe("costPanel", () => {
  it("shows 'no spend' when the ledger is empty", () => {
    const store = new Store(":memory:");
    const html = costPanel(store);
    expect(html).toContain("No spend recorded yet");
    expect(html).toContain("cost-panel");
  });

  it("renders total spend and per-agent breakdown", () => {
    const store = new Store(":memory:");
    store.recordSpend("o/r", 1, "kimi", "review", 0.14, 1200, 800);
    store.recordSpend("o/r", 2, "ollama", "review", 0.00, 500, 300);
    const html = costPanel(store);
    expect(html).toContain("$0.14");
    expect(html).toContain("Kimi");
    expect(html).toContain("Ollama");
    expect(html).toContain("cost-table");
  });

  it("renders token counts in human-readable format", () => {
    const store = new Store(":memory:");
    store.recordSpend("o/r", 1, "kimi", "review", 1.50, 500_000, 500_000);
    const html = costPanel(store);
    expect(html).toContain("1.0M");
  });
});

describe("trustTierPanel", () => {
  it("renders the L1 tier as active", () => {
    const html = trustTierPanel("L1");
    expect(html).toContain("trust-panel");
    expect(html).toContain("L1");
    expect(html).toContain("report only");
    expect(html).toContain("trust-active");
  });

  it("renders the L2 tier as active", () => {
    const html = trustTierPanel("L2");
    expect(html).toContain("L2");
    expect(html).toContain("patch only");
  });

  it("renders the L3 tier as active", () => {
    const html = trustTierPanel("L3");
    expect(html).toContain("L3");
    expect(html).toContain("auto-merge");
  });

  it("shows all three tiers in the ladder", () => {
    const html = trustTierPanel("L2");
    expect(html).toContain("L1");
    expect(html).toContain("L2");
    expect(html).toContain("L3");
  });
});

describe("renderDashboard", () => {
  it("renders the cost panel in The Corner", () => {
    const store = new Store(":memory:");
    const html = renderDashboard(store, [], undefined, {}, {}, {});
    expect(html).toContain("No budget ceiling configured");
    expect(html).toContain("[cost]");
  });

  it("renders the per-repo trust tier in the poster when a card is selected", () => {
    const store = new Store(":memory:");
    store.upsertTask({
      repo: "o/r",
      issue: 1,
      installation_id: 1,
      agent: "antigravity",
      status: "queued",
      title: "Task one",
    });
    const html = renderDashboard(store, [], undefined, {}, {}, { "o/r": "L2" }, "o/r");
    expect(html).toContain("trust L2");
  });

  it("defaults to L1 when no trust tier is provided", () => {
    const store = new Store(":memory:");
    store.upsertTask({
      repo: "o/r",
      issue: 1,
      installation_id: 1,
      agent: "antigravity",
      status: "queued",
      title: "Task one",
    });
    const html = renderDashboard(store, [], undefined, {}, {}, {}, "o/r");
    expect(html).toContain("trust L1");
  });
});
