import type { Context } from "probot";
import { config } from "./config.js";
import { createCheck, postMessage, setStatusLabel } from "./github.js";
import { LABEL_EPIC, parseTaskBranch } from "./protocol/labels.js";
import { parseMessage } from "./protocol/messages.js";
import { recordRateLimit } from "./agentlimits.js";
import { parseResetAt } from "./ratelimit.js";
import type { Store } from "./state/db.js";

function repoFullName(ctx: Context<any>): string {
  return ctx.payload.repository.full_name as string;
}

function leaseExpiry(): number {
  return Date.now() + config.leaseTtlMinutes * 60_000;
}

/** Epic labeled (or /decompose comment) -> queue a decompose job for the manager. */
export async function onEpicLabeled(ctx: Context<"issues.labeled">, store: Store): Promise<void> {
  if (ctx.payload.label?.name !== LABEL_EPIC) return;
  const repo = repoFullName(ctx);
  const issue = ctx.payload.issue.number;
  store.enqueueJob({
    type: "decompose",
    repo,
    installation_id: ctx.payload.installation!.id,
    issue,
    pr: null,
    head_sha: null,
  });
  await ctx.octokit.rest.issues.createComment(
    ctx.issue({ body: "🤖 Queued for decomposition by the manager. Task issues will appear shortly." })
  );
}

/**
 * Mailbox: act on comments addressed to the manager.
 * Loop prevention: we only act on `to: "manager"`, and never on our own comments.
 */
export async function onComment(ctx: Context<"issue_comment.created">, store: Store): Promise<void> {
  const repo = repoFullName(ctx);
  const body = ctx.payload.comment.body;

  // Activity log for the dashboard: keep the latest chatter on every thread
  const parsed = parseMessage(body);
  store.recordComment({
    repo,
    issue: ctx.payload.issue.number,
    author: ctx.payload.sender.login,
    snippet: body.replace(/<!--[\s\S]*?-->/g, "").trim().slice(0, 200),
    msg_type: parsed?.type ?? null,
    msg_from: parsed?.from ?? null,
    created_at: Date.parse(ctx.payload.comment.created_at) || Date.now(),
    body: body.replace(/<!--[\s\S]*?-->/g, "").trim().slice(0, 10000),
    url: ctx.payload.comment.html_url ?? null,
  });

  // Human command: /fight on any issue (formerly /decompose)
  if (/^\/fight\b/m.test(body) && ctx.payload.sender.type === "User") {
    store.enqueueJob({
      type: "decompose",
      repo,
      installation_id: ctx.payload.installation!.id,
      issue: ctx.payload.issue.number,
      pr: null,
      head_sha: null,
    });
    await ctx.octokit.rest.reactions.createForIssueComment(
      ctx.repo({ comment_id: ctx.payload.comment.id, content: "+1" })
    );
    return;
  }

  // Human ChatOps: @foreman or @coach
  if (/(?:@foreman|@coach)\b/i.test(body) && ctx.payload.sender.type === "User") {
    store.enqueueJob({
      type: "discuss",
      repo,
      installation_id: ctx.payload.installation!.id,
      issue: ctx.payload.issue.number,
      pr: null,
      head_sha: null,
    });
    await ctx.octokit.rest.reactions.createForIssueComment(
      ctx.repo({ comment_id: ctx.payload.comment.id, content: "eyes" })
    );
    return;
  }

  const msg = parsed;
  if (!msg || msg.to !== config.managerName) return;

  // Any junior can report its own provider limit so the fleet backs off and the
  // owner sees it. Not tied to a specific task (task may be 0).
  if (msg.type === "rate-limited") {
    const resetAt = msg.resetAt ?? parseResetAt(body) ?? null;
    recordRateLimit(store, [msg.from], msg.reason ?? "reported by the agent", resetAt, (m) => ctx.log.info(m));
    await ctx.octokit.rest.reactions
      .createForIssueComment(ctx.repo({ comment_id: ctx.payload.comment.id, content: "eyes" }))
      .catch(() => {});
    return;
  }

  const task = store.getTask(repo, msg.task);
  if (!task) return;

  if (msg.type === "claim") {
    // Idempotent: re-claim by the same agent just renews the lease.
    if (task.status !== "queued" && !(task.status === "claimed" && task.agent === msg.from)) {
      await postMessage(
        ctx.octokit,
        repo,
        msg.task,
        { v: 1, type: "reassignment", from: config.managerName, to: msg.from, task: msg.task },
        `⚠️ @${msg.from}: task #${msg.task} is not available (status: ${task.status}, held by ${task.agent}). Stand down.`
      );
      return;
    }
    store.updateTask(repo, msg.task, {
      agent: msg.from,
      status: "claimed",
      lease_expires_at: leaseExpiry(),
    });
    await setStatusLabel(ctx.octokit, repo, msg.task, "claimed");
    // 👀 reaction = ack without adding comment noise
    await ctx.octokit.rest.reactions.createForIssueComment(
      ctx.repo({ comment_id: ctx.payload.comment.id, content: "eyes" })
    );
  } else if (msg.type === "progress") {
    if (task.agent === msg.from) {
      store.updateTask(repo, msg.task, { lease_expires_at: leaseExpiry() });
      await ctx.octokit.rest.reactions.createForIssueComment(
        ctx.repo({ comment_id: ctx.payload.comment.id, content: "eyes" })
      );
    }
  }
}

/** PR opened or updated on an agent branch -> link to task, queue manager review. */
export async function onPullRequest(
  ctx: Context<"pull_request.opened" | "pull_request.synchronize" | "pull_request.reopened">,
  store: Store
): Promise<void> {
  const repo = repoFullName(ctx);
  const pr = ctx.payload.pull_request;
  const parsed = parseTaskBranch(pr.head.ref);
  if (!parsed) return; // not an agent branch; ignore

  const task = store.getTask(repo, parsed.issue);
  if (!task) return;

  store.updateTask(repo, parsed.issue, {
    pr: pr.number,
    status: "in_review",
    lease_expires_at: null, // PR submitted; lease no longer applies
  });
  await setStatusLabel(ctx.octokit, repo, parsed.issue, "in_review");
  await createCheck(ctx.octokit, repo, pr.head.sha, "queued");
  store.enqueueJob({
    type: "review",
    repo,
    installation_id: ctx.payload.installation!.id,
    issue: parsed.issue,
    pr: pr.number,
    head_sha: pr.head.sha,
  });
}

/** PR merged -> task done. */
export async function onPrClosed(ctx: Context<"pull_request.closed">, store: Store): Promise<void> {
  const repo = repoFullName(ctx);
  const pr = ctx.payload.pull_request;
  const parsed = parseTaskBranch(pr.head.ref);
  if (!parsed) return;
  const task = store.getTask(repo, parsed.issue);
  if (!task) return;
  if (pr.merged) {
    store.updateTask(repo, parsed.issue, { status: "done" });
    await setStatusLabel(ctx.octokit, repo, parsed.issue, "done");
  } else if (task.status !== "stopped") {
    // PR closed without merge: requeue the task (unless the owner stopped it)
    store.updateTask(repo, parsed.issue, { status: "queued", pr: null, lease_expires_at: null });
    await setStatusLabel(ctx.octokit, repo, parsed.issue, "queued");
  }
}
