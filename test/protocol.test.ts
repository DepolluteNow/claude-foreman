import { describe, expect, it } from "vitest";
import { parseMessage, serializeMessage, type AgentMessage } from "../src/protocol/messages.js";
import {
  parseTaskBranch,
  taskBranch,
  ALL_STATUS,
  statusLabel,
  isStatusTaken,
  isValidTransition,
} from "../src/protocol/labels.js";
import { extractJson } from "../src/manager/runner.js";

describe("mailbox messages", () => {
  const msg: AgentMessage = { v: 1, type: "claim", from: "antigravity", to: "manager", task: 42 };

  it("round-trips serialize/parse", () => {
    const body = serializeMessage(msg, "I am taking task #42.");
    expect(body).toContain("I am taking task #42.");
    expect(parseMessage(body)).toEqual(msg);
  });

  it("parses a header buried in a longer comment", () => {
    const body = `Some preamble\n\n${serializeMessage(msg, "text")}\n\ntrailing`;
    expect(parseMessage(body)?.task).toBe(42);
  });

  it("returns null for human comments and malformed headers", () => {
    expect(parseMessage("just a normal comment")).toBeNull();
    expect(parseMessage("<!-- agent-msg {not json} -->")).toBeNull();
    expect(parseMessage('<!-- agent-msg {"v":2,"type":"claim","task":1} -->')).toBeNull();
    expect(parseMessage(null)).toBeNull();
  });
});

describe("branch conventions", () => {
  it("round-trips branch names", () => {
    expect(parseTaskBranch(taskBranch("windsurf", 7))).toEqual({ agent: "windsurf", issue: 7 });
  });
  it("rejects non-agent branches", () => {
    expect(parseTaskBranch("feature/foo")).toBeNull();
    expect(parseTaskBranch("agent/windsurf/abc")).toBeNull();
  });
});

describe("manager output parsing", () => {
  it("parses bare JSON", () => {
    expect(extractJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });
  it("unwraps the Claude Code envelope", () => {
    const envelope = JSON.stringify({ type: "result", result: '{"verdict":"approve","summary":"ok","points":[]}' });
    expect(extractJson<{ verdict: string }>(envelope).verdict).toBe("approve");
  });
  it("strips code fences inside the envelope", () => {
    const envelope = JSON.stringify({ result: '```json\n{"tasks":[]}\n```' });
    expect(extractJson<{ tasks: unknown[] }>(envelope).tasks).toEqual([]);
  });
  it("salvages JSON surrounded by prose", () => {
    expect(extractJson<{ ok: boolean }>('Sure! Here it is: {"ok": true} Hope that helps.').ok).toBe(true);
  });
  it("handles code fences inside JSON string values", () => {
    const inner = { tasks: [{ spec: "Run this:\n```bash\nnpm test\n```\nthen done" }] };
    const envelope = JSON.stringify({ result: "```json\n" + JSON.stringify(inner) + "\n```" });
    expect(extractJson<typeof inner>(envelope)).toEqual(inner);
  });
});

describe("status label lifecycle", () => {
  it("includes dispatched and merged_staging in ALL_STATUS", () => {
    expect(ALL_STATUS).toContain("dispatched");
    expect(ALL_STATUS).toContain("merged_staging");
  });

  it("formats dispatched and merged_staging labels correctly", () => {
    expect(statusLabel("dispatched")).toBe("status:dispatched");
    expect(statusLabel("merged_staging")).toBe("status:merged-staging");
  });
});

describe("isStatusTaken (anti-collision guard)", () => {
  it("returns true for dispatched", () => expect(isStatusTaken("dispatched")).toBe(true));
  it("returns true for claimed", () => expect(isStatusTaken("claimed")).toBe(true));
  it("returns true for in_review", () => expect(isStatusTaken("in_review")).toBe(true));
  it("returns true for approved", () => expect(isStatusTaken("approved")).toBe(true));
  it("returns true for merged_staging", () => expect(isStatusTaken("merged_staging")).toBe(true));
  it("returns true for done", () => expect(isStatusTaken("done")).toBe(true));
  it("returns false for queued", () => expect(isStatusTaken("queued")).toBe(false));
  it("returns false for failed", () => expect(isStatusTaken("failed")).toBe(false));
  it("returns false for stopped", () => expect(isStatusTaken("stopped")).toBe(false));
});

describe("isValidTransition (status state machine)", () => {
  it("allows queued → dispatched", () => expect(isValidTransition("queued", "dispatched")).toBe(true));
  it("allows dispatched → claimed", () => expect(isValidTransition("dispatched", "claimed")).toBe(true));
  it("allows claimed → in_review", () => expect(isValidTransition("claimed", "in_review")).toBe(true));
  it("allows approved → merged_staging", () => expect(isValidTransition("approved", "merged_staging")).toBe(true));
  it("allows merged_staging → done", () => expect(isValidTransition("merged_staging", "done")).toBe(true));
  it("allows queued → claimed (direct claim without dispatch)", () =>
    expect(isValidTransition("queued", "claimed")).toBe(true));
  it("rejects queued → done (skip review)", () => expect(isValidTransition("queued", "done")).toBe(false));
  it("rejects done → anything", () => expect(isValidTransition("done", "queued")).toBe(false));
  it("rejects stopped → done (must go through queued first)", () =>
    expect(isValidTransition("stopped", "done")).toBe(false));
  it("allows stopped → queued (relaunch)", () => expect(isValidTransition("stopped", "queued")).toBe(true));
  it("allows failed → queued (retry)", () => expect(isValidTransition("failed", "queued")).toBe(true));
});
