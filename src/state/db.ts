import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskStatus } from "../protocol/labels.js";

export interface TaskRow {
  repo: string; // "owner/name"
  issue: number;
  installation_id: number;
  agent: string;
  status: TaskStatus;
  title: string | null;
  plain_summary: string | null; // manager's non-technical summary, set on approval
  pr: number | null;
  lease_expires_at: number | null; // epoch ms
  stale_warned_at: number | null; // epoch ms of the last "going dark" warning
  revision_round: number;
  reassign_count: number;
  created_at: number;
  updated_at: number;
}

export interface CommentRow {
  repo: string;
  issue: number; // issue OR PR number, as received from the webhook
  author: string;
  snippet: string;
  msg_type: string | null; // agent-msg type if it was a protocol message
  msg_from: string | null;
  created_at: number;
}

export interface RevisionPointRow {
  id: number;
  repo: string;
  issue: number;
  round: number;
  text: string;
  status: "open" | "addressed";
  created_at: number;
  addressed_at: number | null;
}

export interface AgentStatusRow {
  agent: string;
  state: "ok" | "rate_limited" | "halted";
  reason: string | null;
  reset_at: number | null; // epoch ms the limit is expected to clear
  updated_at: number;
}

/** A free-form "where we left off" note for the account-rotation handoff bundle. */
export interface HandoffNoteRow {
  id: number;
  note: string;
  author: string | null;
  created_at: number;
}

export interface CostLedgerRow {
  id: number;
  repo: string | null;
  issue: number | null;
  agent: string | null;
  job_type: string | null;
  usd: number;
  tokens_in: number;
  tokens_out: number;
  created_at: number;
}

export type JobType = "decompose" | "review" | "discuss";
export type JobStatus = "pending" | "running" | "done" | "failed" | "needs_human";

export interface JobRow {
  id: number;
  type: JobType;
  repo: string;
  installation_id: number;
  issue: number; // epic issue for decompose, task issue for review
  pr: number | null;
  head_sha: string | null;
  status: JobStatus;
  error: string | null;
  created_at: number;
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        repo TEXT NOT NULL,
        issue INTEGER NOT NULL,
        installation_id INTEGER NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        pr INTEGER,
        lease_expires_at INTEGER,
        revision_round INTEGER NOT NULL DEFAULT 0,
        reassign_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo, issue)
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        repo TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        issue INTEGER NOT NULL,
        pr INTEGER,
        head_sha TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comments (
        repo TEXT NOT NULL,
        issue INTEGER NOT NULL,
        author TEXT NOT NULL,
        snippet TEXT NOT NULL,
        msg_type TEXT,
        msg_from TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(repo, issue, created_at);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS revision_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        issue INTEGER NOT NULL,
        round INTEGER NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        addressed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_points_issue ON revision_points(repo, issue, status);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_status (
        agent TEXT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'ok',
        reason TEXT,
        reset_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS handoff_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note TEXT NOT NULL,
        author TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cost_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT,
        issue INTEGER,
        agent TEXT,
        job_type TEXT,
        usd REAL NOT NULL DEFAULT 0,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cost_ledger_created ON cost_ledger(created_at);
    `);
    // Migrations: columns added after v0.1. Check existence instead of a
    // catch-all (which would also swallow SQLITE_BUSY / IOERR / CORRUPT).
    const existingCols = new Set(
      (this.db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name)
    );
    for (const [col, ddl] of [
      ["title", `ALTER TABLE tasks ADD COLUMN title TEXT`],
      ["plain_summary", `ALTER TABLE tasks ADD COLUMN plain_summary TEXT`],
      ["stale_warned_at", `ALTER TABLE tasks ADD COLUMN stale_warned_at INTEGER`],
    ] as const) {
      if (!existingCols.has(col)) this.db.exec(ddl);
    }
  }

  upsertTask(t: Omit<TaskRow, "created_at" | "updated_at" | "revision_round" | "reassign_count" | "pr" | "lease_expires_at" | "stale_warned_at" | "title" | "plain_summary"> & Partial<TaskRow>): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO tasks (repo, issue, installation_id, agent, status, title, plain_summary, pr, lease_expires_at, revision_round, reassign_count, created_at, updated_at)
         VALUES (@repo, @issue, @installation_id, @agent, @status, @title, @plain_summary, @pr, @lease_expires_at, @revision_round, @reassign_count, @now, @now)
         ON CONFLICT(repo, issue) DO UPDATE SET
           agent = excluded.agent, status = excluded.status, title = coalesce(excluded.title, title), updated_at = @now`
      )
      .run({
        title: null,
        plain_summary: null,
        pr: null,
        lease_expires_at: null,
        revision_round: 0,
        reassign_count: 0,
        ...t,
        now,
      });
  }

  recordComment(c: Omit<CommentRow, "created_at" | "msg_type" | "msg_from"> & Partial<CommentRow>): void {
    this.db
      .prepare(
        `INSERT INTO comments (repo, issue, author, snippet, msg_type, msg_from, created_at)
         VALUES (@repo, @issue, @author, @snippet, @msg_type, @msg_from, @created_at)`
      )
      .run({ msg_type: null, msg_from: null, created_at: Date.now(), ...c });
  }

  /** Latest recorded comment on the task's issue or its PR thread. */
  lastCommentFor(repo: string, issue: number, pr: number | null): CommentRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM comments WHERE repo = ? AND issue IN (?, ?)
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(repo, issue, pr ?? -1) as CommentRow | undefined;
  }

  /** Latest comments for a repo, newest first — feeds the referee's log. */
  recentComments(repo: string, limit = 12): CommentRow[] {
    return this.db
      .prepare(`SELECT * FROM comments WHERE repo = ? ORDER BY created_at DESC LIMIT ?`)
      .all(repo, limit) as CommentRow[];
  }

  hasComments(repo: string, issue: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM comments WHERE repo = ? AND issue = ? LIMIT 1`).get(repo, issue);
  }

  addRevisionPoints(repo: string, issue: number, round: number, texts: string[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO revision_points (repo, issue, round, text, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`
    );
    for (const text of texts) stmt.run(repo, issue, round, text, Date.now());
  }

  openRevisionPoints(repo: string, issue: number): RevisionPointRow[] {
    return this.db
      .prepare(`SELECT * FROM revision_points WHERE repo = ? AND issue = ? AND status = 'open' ORDER BY id`)
      .all(repo, issue) as RevisionPointRow[];
  }

  listRevisionPoints(repo: string, issue: number): RevisionPointRow[] {
    return this.db
      .prepare(`SELECT * FROM revision_points WHERE repo = ? AND issue = ? ORDER BY id`)
      .all(repo, issue) as RevisionPointRow[];
  }

  markPointsAddressed(ids: number[]): void {
    const stmt = this.db.prepare(`UPDATE revision_points SET status = 'addressed', addressed_at = ? WHERE id = ?`);
    for (const id of ids) stmt.run(Date.now(), id);
  }

  listTasks(): TaskRow[] {
    return this.db
      .prepare(`SELECT * FROM tasks ORDER BY repo, updated_at DESC`)
      .all() as TaskRow[];
  }

  recentJobs(limit = 25): JobRow[] {
    return this.db
      .prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`)
      .all(limit) as JobRow[];
  }

  getTask(repo: string, issue: number): TaskRow | undefined {
    return this.db.prepare(`SELECT * FROM tasks WHERE repo = ? AND issue = ?`).get(repo, issue) as
      | TaskRow
      | undefined;
  }

  updateTask(repo: string, issue: number, fields: Partial<TaskRow>): void {
    const allowed = ["agent", "status", "pr", "lease_expires_at", "stale_warned_at", "revision_round", "reassign_count", "plain_summary"] as const;
    const sets = allowed.filter((k) => k in fields);
    if (sets.length === 0) return;
    const sql = `UPDATE tasks SET ${sets.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @now WHERE repo = @repo AND issue = @issue`;
    this.db.prepare(sql).run({ ...fields, repo, issue, now: Date.now() });
  }

  /**
   * Claimed/in-revision tasks with a lease that is still running (not yet hard
   * expired). The silent-agent sweep inspects these to spot an agent that has
   * gone quiet mid-lease — a likely crash — before the lease lapses.
   */
  claimedWithActiveLease(now = Date.now()): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('claimed', 'changes_requested')
           AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`
      )
      .all(now) as TaskRow[];
  }

  /** Tasks whose lease has expired and are still held by an agent. */
  expiredLeases(now = Date.now()): TaskRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('claimed', 'changes_requested')
           AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`
      )
      .all(now) as TaskRow[];
  }

  findTaskByPrBranch(repo: string, agent: string, issue: number): TaskRow | undefined {
    return this.db
      .prepare(`SELECT * FROM tasks WHERE repo = ? AND issue = ? AND agent = ?`)
      .get(repo, issue, agent) as TaskRow | undefined;
  }

  enqueueJob(j: Omit<JobRow, "id" | "status" | "error" | "created_at">): number {
    // Skip if an identical pending job already exists (cron double-fire safety)
    const dup = this.db
      .prepare(
        `SELECT id FROM jobs WHERE type = ? AND repo = ? AND issue = ? AND ifnull(pr, -1) = ifnull(?, -1) AND ifnull(head_sha, '') = ifnull(?, '') AND status = 'pending'`
      )
      .get(j.type, j.repo, j.issue, j.pr, j.head_sha);
    if (dup) return (dup as { id: number }).id;
    const res = this.db
      .prepare(
        `INSERT INTO jobs (type, repo, installation_id, issue, pr, head_sha, status, created_at)
         VALUES (@type, @repo, @installation_id, @issue, @pr, @head_sha, 'pending', @now)`
      )
      .run({ ...j, now: Date.now() });
    return Number(res.lastInsertRowid);
  }

  /** Atomically claim the oldest pending job. */
  nextJob(): JobRow | undefined {
    const tx = this.db.transaction((): JobRow | undefined => {
      const job = this.db
        .prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1`)
        .get() as JobRow | undefined;
      if (!job) return undefined;
      this.db.prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).run(job.id);
      return { ...job, status: "running" };
    });
    return tx();
  }

  finishJob(id: number, status: JobStatus, error?: string): void {
    this.db.prepare(`UPDATE jobs SET status = ?, error = ? WHERE id = ?`).run(status, error ?? null, id);
  }

  /** Reset jobs left 'running' by a previous crashed process. */
  recoverStaleJobs(): void {
    this.db.prepare(`UPDATE jobs SET status = 'pending' WHERE status = 'running'`).run();
  }

  /** Mark an agent rate-limited (or clear it). reset_at = when it should recover. */
  setAgentStatus(agent: string, state: "ok" | "rate_limited" | "halted", reason: string | null, resetAt: number | null): void {
    this.db
      .prepare(
        `INSERT INTO agent_status (agent, state, reason, reset_at, updated_at)
         VALUES (@agent, @state, @reason, @reset_at, @now)
         ON CONFLICT(agent) DO UPDATE SET state = @state, reason = @reason, reset_at = @reset_at, updated_at = @now`
      )
      .run({ agent, state, reason, reset_at: resetAt, now: Date.now() });
  }

  /**
   * Effective status for an agent: a `rate_limited` row whose reset_at has
   * passed is reported as recovered (and lazily cleared), so callers see the
   * truth without a separate sweep.
   */
  agentStatus(agent: string, now = Date.now()): AgentStatusRow {
    const row = this.db.prepare(`SELECT * FROM agent_status WHERE agent = ?`).get(agent) as AgentStatusRow | undefined;
    if (!row) return { agent, state: "ok", reason: null, reset_at: null, updated_at: 0 };
    // Effective truth without mutating: once the reset time passes the agent is
    // free again. The real flip to 'ok' (and the recovery notification) is owned
    // by sweepRateLimitRecoveries, so reads stay pure and the transition is never
    // silently swallowed before the owner is told.
    if (row.state === "rate_limited" && row.reset_at && row.reset_at <= now) {
      return { ...row, state: "ok" };
    }
    return row;
  }

  /**
   * Agents stored as rate-limited whose reset time has now passed — i.e. they
   * just recovered and need a real status flip plus a one-shot notification.
   */
  recoveredAgents(now = Date.now()): AgentStatusRow[] {
    return this.db
      .prepare(`SELECT * FROM agent_status WHERE state = 'rate_limited' AND reset_at IS NOT NULL AND reset_at <= ?`)
      .all(now) as AgentStatusRow[];
  }

  /** Is the agent currently held back by a rate limit? */
  isRateLimited(agent: string, now = Date.now()): boolean {
    return this.agentStatus(agent, now).state === "rate_limited";
  }

  listAgentStatus(): AgentStatusRow[] {
    return this.db.prepare(`SELECT * FROM agent_status ORDER BY agent`).all() as AgentStatusRow[];
  }

  /** Generic settings store — currently used for the live-switchable Coach backend. */
  getSetting(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, Date.now());
  }

  /**
   * Save the "where we left off" note used by the account-rotation handoff
   * bundle. Each save is a new row so prior handoffs stay recoverable; the
   * bundle renders the most recent one.
   */
  saveHandoffNote(note: string, author: string | null = null): void {
    this.db
      .prepare(`INSERT INTO handoff_notes (note, author, created_at) VALUES (?, ?, ?)`)
      .run(note, author, Date.now());
  }

  /** The most recently saved handoff note, if any. */
  latestHandoffNote(): HandoffNoteRow | undefined {
    return this.db
      .prepare(`SELECT * FROM handoff_notes ORDER BY id DESC LIMIT 1`)
      .get() as HandoffNoteRow | undefined;
  }

  recordSpend(repo: string | null, issue: number | null, agent: string | null, jobType: string | null, usd: number, tokensIn: number, tokensOut: number): void {
    if (usd === 0 && tokensIn === 0 && tokensOut === 0) return;
    this.db
      .prepare(
        `INSERT INTO cost_ledger (repo, issue, agent, job_type, usd, tokens_in, tokens_out, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(repo, issue, agent, jobType, usd, tokensIn, tokensOut, Date.now());
  }

  getLedgerTotals(sinceEpoch: number = 0): { usd: number; tokens: number } {
    const row = this.db
      .prepare(
        `SELECT ifnull(sum(usd), 0) as usd, ifnull(sum(tokens_in + tokens_out), 0) as tokens 
         FROM cost_ledger WHERE created_at >= ?`
      )
      .get(sinceEpoch) as { usd: number; tokens: number };
    return row;
  }

  getLedgerByAgent(sinceEpoch: number = 0): Array<{ agent: string | null; usd: number; tokens: number }> {
    return this.db
      .prepare(
        `SELECT agent,
                ifnull(sum(usd), 0) as usd,
                ifnull(sum(tokens_in + tokens_out), 0) as tokens
         FROM cost_ledger WHERE created_at >= ? GROUP BY agent`
      )
      .all(sinceEpoch) as Array<{ agent: string | null; usd: number; tokens: number }>;
  }

  queueDepth(): number {
    const row = this.db.prepare(`SELECT count(*) as count FROM tasks WHERE status = 'queued'`).get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}
