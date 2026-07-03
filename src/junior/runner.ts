import { spawn } from "node:child_process";
import { config } from "../config.js";
import { postMessage, setStatusLabel, splitRepo } from "../github.js";
import type { AuthFn } from "../manager/worker.js";
import { extractJson } from "../manager/runner.js";
import { claudeAccountAgents, recordRateLimit, resetClock, checkCeilings } from "../agentlimits.js";
import { parseRateLimit, RateLimitedError } from "../ratelimit.js";
import { notify } from "../notify.js";
import { scanOutput } from "../guard/secretscan.js";
import type { Octokit } from "../octokit.js";
import { taskBranch } from "../protocol/labels.js";
import { serializeMessage } from "../protocol/messages.js";
import type { Store, TaskRow } from "../state/db.js";
import { replyToThread, resolveThread, unresolvedThreads } from "../threads.js";
import { checkoutTaskBranch, commitAll, ensureWorkspace, headSha, push } from "./git.js";
import { juniorGitEnv, resolveJuniorCmd } from "./settings.js";
import { isTestsPassed, revisionPrompt, workPrompt, type JuniorReport } from "./prompts.js";
import { assembleContextPacket } from "../context.js";

/**
 * The in-process junior: a headless Claude Code session that plays the same
 * role as the external IDE agents (Antigravity, Windsurf) — claims tasks
 * routed to `agent:claude`, codes them in a local workspace, opens PRs, and
 * answers revision rounds. It follows PROTOCOL.md like everyone else; the
 * only difference is that this junior lives inside the manager's process.
 *
 * One task at a time (single-flight): a coding session can take many minutes
 * and parallel sessions on one machine would fight over CPU and attention.
 */
export function startJunior(store: Store, auth: AuthFn, log: (m: string) => void): () => Promise<void> {
  if (!config.juniorEnabled || !config.agents.includes(config.juniorAgent)) {
    return async () => {};
  }
  let busy = false;
  // Revision rounds answered without a code change: remembered so we don't
  // loop on them. In-memory on purpose — a restart retries once, harmlessly.
  const answeredRounds = new Set<string>();

  return async function tick(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      // The junior is Claude; while it's rate-limited or halted, do nothing — its tasks
      // stay where they are and resume after the limit clears.
      const s = store.agentStatus(config.juniorAgent);
      if (s.state === "rate_limited" || s.state === "halted") {
        log(`junior ${s.state} (${s.reason}); paused${s.reset_at ? ` until ${resetClock(s.reset_at)}` : " indefinitely"}`);
        return;
      }

      if (checkCeilings(store, log)) {
        return;
      }

      const mine = store.listTasks().filter((t) => t.agent === config.juniorAgent);

      const revision = mine.find(
        (t) =>
          t.status === "changes_requested" &&
          t.pr &&
          !answeredRounds.has(`${t.repo}#${t.issue}#${t.revision_round}`)
      );
      if (revision) {
        await runRevision(revision, store, auth, log, answeredRounds);
        return;
      }

      // A task still 'claimed' here means a previous process died mid-run — resume it.
      const interrupted = mine.find((t) => t.status === "claimed");
      if (interrupted) {
        await runWork(interrupted, store, auth, log, { resume: true });
        return;
      }

      const queued = mine.filter((t) => t.status === "queued").sort((a, b) => a.issue - b.issue)[0];
      if (queued) await runWork(queued, store, auth, log, { resume: false });
    } catch (e) {
      log(`junior tick failed: ${e}`);
    } finally {
      busy = false;
    }
  };
}

async function installationToken(octokit: Octokit): Promise<string> {
  const res = (await octokit.auth({
    type: "installation",
    permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
    },
  })) as { token: string };
  return res.token;
}

async function runWork(
  task: TaskRow,
  store: Store,
  auth: AuthFn,
  log: (m: string) => void,
  opts: { resume: boolean }
): Promise<void> {
  const octokit = await auth(task.installation_id);
  const { owner, repo } = splitRepo(task.repo);
  const branch = taskBranch(config.juniorAgent, task.issue);
  log(`junior: ${opts.resume ? "resuming" : "claiming"} ${task.repo}#${task.issue}`);

  // Self-healing: if a PR for this branch already exists (a webhook was
  // missed), reconcile instead of redoing the work.
  const { data: existingPrs } = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "open",
  });
  if (existingPrs.length > 0) {
    const pr = existingPrs[0];
    store.updateTask(task.repo, task.issue, { pr: pr.number, status: "in_review", lease_expires_at: null });
    await setStatusLabel(octokit, task.repo, task.issue, "in_review");
    store.enqueueJob({
      type: "review",
      repo: task.repo,
      installation_id: task.installation_id,
      issue: task.issue,
      pr: pr.number,
      head_sha: pr.head.sha,
    });
    log(`junior: found existing PR #${pr.number} for ${task.repo}#${task.issue}, reconciled to in_review`);
    return;
  }

  if (!opts.resume) {
    store.updateTask(task.repo, task.issue, {
      status: "claimed",
      lease_expires_at: Date.now() + config.leaseTtlMinutes * 60_000,
    });
    await setStatusLabel(octokit, task.repo, task.issue, "claimed");
    await postMessage(
      octokit,
      task.repo,
      task.issue,
      { v: 1, type: "claim", from: config.juniorAgent, to: config.managerName, task: task.issue },
      `Claiming task #${task.issue}.`
    );
  }

  try {
    const [{ data: issue }, { data: repoData }, packet] = await Promise.all([
      octokit.rest.issues.get({ owner, repo, issue_number: task.issue }),
      octokit.rest.repos.get({ owner, repo }),
      assembleContextPacket(octokit, task.repo),
    ]);
    const token = await installationToken(octokit);
    const dir = await ensureWorkspace(task.repo, token);
    await checkoutTaskBranch(dir, branch, repoData.default_branch);
    const startSha = await headSha(dir);

    const report = await runJuniorCmd(
      resolveJuniorCmd(store),
      workPrompt({
        repoFull: task.repo,
        issue: task.issue,
        title: issue.title,
        spec: issue.body ?? "",
        branch,
        contextPacket: packet,
      }),
      dir,
      juniorGitEnv(store),
      (usd, inT, outT) => store.recordSpend(task.repo, task.issue, config.juniorAgent, "work", usd, inT, outT)
    );

    await commitAll(dir, `${issue.title} (task #${task.issue})`);
    const endSha = await headSha(dir);
    if (endSha === startSha) {
      await fail(
        task,
        store,
        octokit,
        `I could not produce any change for this task. ${report.didNotDo || report.summary || ""}`.trim()
      );
      return;
    }

    if (!isTestsPassed(report.testsPassed)) {
      await fail(
        task,
        store,
        octokit,
        `Tests did not pass — refusing to open a PR.\n\n${report.testsOutput || report.testsRun || "No test output reported."}`.trim()
      );
      return;
    }

    await push(dir, branch, token);
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: report.prTitle || issue.title,
      head: branch,
      base: repoData.default_branch,
      body: `Closes #${task.issue}

## What I did
${report.summary ?? "(see diff)"}

## What I did not do
${report.didNotDo || "Everything in the spec was done."}

## Tests
${report.testsRun || "none"}`,
    });
    log(`junior: opened PR #${pr.number} for ${task.repo}#${task.issue}`);
    // The pull_request.opened webhook flips the task to in_review and queues
    // the manager review — same path as any external junior's PR.
  } catch (e) {
    if (e instanceof RateLimitedError) {
      // Provider limit, not a task failure: record it and leave the task
      // claimed so the next un-paused tick resumes it.
      recordRateLimit(store, claudeAccountAgents(), e.reason, e.resetAt, log);
      return;
    }
    await fail(task, store, octokit, `I hit an error and stopped: ${e}`);
  }
}

async function runRevision(
  task: TaskRow,
  store: Store,
  auth: AuthFn,
  log: (m: string) => void,
  answeredRounds: Set<string>
): Promise<void> {
  const octokit = await auth(task.installation_id);
  const { owner, repo } = splitRepo(task.repo);
  const branch = taskBranch(config.juniorAgent, task.issue);
  const roundKey = `${task.repo}#${task.issue}#${task.revision_round}`;
  log(`junior: addressing revision round ${task.revision_round} on ${task.repo}#${task.issue} (PR #${task.pr})`);

  try {
    const points = store.openRevisionPoints(task.repo, task.issue);
    const threads = await unresolvedThreads(octokit, task.repo, task.pr!);
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    const token = await installationToken(octokit);
    const dir = await ensureWorkspace(task.repo, token);
    await checkoutTaskBranch(dir, branch, repoData.default_branch);
    const startSha = await headSha(dir);

    const report = await runJuniorCmd(
      resolveJuniorCmd(store),
      revisionPrompt({
        repoFull: task.repo,
        issue: task.issue,
        branch,
        round: task.revision_round,
        points: points.map((p) => p.text),
        threads: threads.open,
      }),
      dir,
      juniorGitEnv(store),
      (usd, inT, outT) => store.recordSpend(task.repo, task.issue, config.juniorAgent, "revision", usd, inT, outT)
    );

    const commit = await commitAll(dir, `Address review round ${task.revision_round} (task #${task.issue})`);
    const changed = (await headSha(dir)) !== startSha;
    if (changed) await push(dir, branch, token);
    const shortSha = commit ?? (changed ? (await headSha(dir)).slice(0, 10) : null);

    // Per-point accounting on the PR, with the fix commit cited (the contract)
    const pointLines = points.map((p, i) => {
      const fix = report.pointFixes?.find((f) => f.n === i + 1);
      return `${i + 1}. ${fix?.what ?? "(see diff)"}`;
    });
    await postMessage(
      octokit,
      task.repo,
      task.pr!,
      { v: 1, type: "progress", from: config.juniorAgent, to: config.managerName, task: task.issue, pr: task.pr! },
      `🔧 **Revision round ${task.revision_round} addressed**${shortSha ? ` — fixed in ${shortSha}` : " — no code change was needed"}.

${pointLines.join("\n")}

Tests: ${report.testsRun || "none"}`
    );

    // The comment-response contract: reply in each conversation, cite the
    // commit, resolve what was fixed.
    for (let i = 0; i < threads.open.length; i++) {
      const th = threads.open[i];
      const r = report.threadReplies?.find((tr) => tr.n === i + 1);
      if (!r?.reply) continue;
      const fixedNote = r.fixed && shortSha ? `\n\nFixed in ${shortSha}.` : "";
      await replyToThread(
        octokit,
        th.id,
        serializeMessage(
          { v: 1, type: "progress", from: config.juniorAgent, to: config.managerName, task: task.issue, pr: task.pr! },
          `${r.reply}${fixedNote}`
        )
      ).catch((e) => log(`junior: thread reply failed on ${task.repo}#${task.issue}: ${e}`));
      if (r.fixed && shortSha) {
        await resolveThread(octokit, th.id).catch((e) =>
          log(`junior: thread resolve failed on ${task.repo}#${task.issue}: ${e}`)
        );
      }
    }

    if (!changed) {
      // No push means no synchronize webhook — ask the manager to re-judge
      // the same diff against the junior's explanations, so the task doesn't
      // sit in changes_requested forever.
      answeredRounds.add(roundKey);
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: task.pr! });
      store.enqueueJob({
        type: "review",
        repo: task.repo,
        installation_id: task.installation_id,
        issue: task.issue,
        pr: task.pr!,
        head_sha: pr.head.sha,
      });
    }
    // When changed: the push triggers pull_request.synchronize → re-review.
  } catch (e) {
    if (e instanceof RateLimitedError) {
      // Don't mark the round answered — retry it after the limit clears.
      recordRateLimit(store, claudeAccountAgents(), e.reason, e.resetAt, log);
      return;
    }
    answeredRounds.add(roundKey); // don't burn sessions retrying a broken round
    log(`junior: revision round failed on ${task.repo}#${task.issue}: ${e}`);
    await notify("Junior blocked on a revision", `Round ${task.revision_round} of "${task.title ?? `#${task.issue}`}" failed: ${String(e).slice(0, 180)}`, {
      priority: "high",
      tags: ["warning"],
      click: `https://github.com/${task.repo}/pull/${task.pr}`,
    });
  }
}

async function fail(task: TaskRow, store: Store, octokit: Octokit, reason: string): Promise<void> {
  store.updateTask(task.repo, task.issue, { status: "failed", lease_expires_at: null });
  await setStatusLabel(octokit, task.repo, task.issue, "failed").catch(() => {});
  await postMessage(
    octokit,
    task.repo,
    task.issue,
    { v: 1, type: "progress", from: config.juniorAgent, to: config.managerName, task: task.issue },
    `⚠️ ${reason}\n\nA human can relaunch this task from the dashboard.`
  ).catch(() => {});
  await notify("Junior blocked", `"${task.title ?? `task #${task.issue}`}": ${reason.slice(0, 180)}`, {
    priority: "high",
    tags: ["warning"],
    click: `https://github.com/${task.repo}/issues/${task.issue}`,
  });
}

/** Run the junior CLI in the workspace; parse its JSON self-report (tolerantly). */
async function runJuniorCmd(cmd: string, prompt: string, cwd: string, env?: Record<string, string>, onMetrics?: (usd: number, inT: number, outT: number) => void): Promise<JuniorReport> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, { shell: true, cwd, windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
    // Guard against EPIPE/EINVAL if the process dies before/while we write stdin.
    child.stdin.on("error", () => {});
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
      reject(new Error(`junior session timed out after ${config.juniorTimeoutMinutes} minutes`));
    }, config.juniorTimeoutMinutes * 60_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const rl = parseRateLimit(`${out}\n${err}`);
      if (rl.limited) {
        reject(new RateLimitedError(rl.reason, rl.resetAt));
        return;
      }
      if (code === 0) resolve(out);
      else reject(new Error(`junior exited with code ${code}; stderr: ${err.slice(0, 800) || "<empty>"}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
  try {
    const scan = scanOutput(stdout);
    if (!scan.clean) {
      console.warn(`secret-scan: ${scan.findings.join("; ")} — redacted from junior output`);
    }
    return extractJson<JuniorReport>(scan.redacted, onMetrics);
  } catch {
    // A session that worked but fumbled the report format is still useful —
    // the diff is the real deliverable.
    return { summary: stdout.slice(-1500) };
  }
}
