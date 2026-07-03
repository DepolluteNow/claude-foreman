import type { ApplicationFunctionOptions, Probot } from "probot";
import { config } from "./config.js";
import { renderDashboard, threadKey, type RepoBranches, type RepoOption, type ThreadMap } from "./dashboard.js";
import { renderHandoff } from "./handoff.js";
import { LABEL_EPIC, taskBranch } from "./protocol/labels.js";
import { agentBranches, branchStateFor, ciStateFor, prChangedFiles, unresolvedThreads } from "./threads.js";
import { postMessage, setStatusLabel, splitRepo } from "./github.js";
import { readReadiness } from "./referee/readiness.js";
import { onComment, onEpicLabeled, onPrClosed, onPullRequest } from "./handlers.js";
import { onboardRepo } from "./onboarding.js";
import { sweepLeases, sweepSilentAgents } from "./leases.js";
import { sweepRateLimitRecoveries } from "./agentlimits.js";
import { sweepAutoMerge } from "./automerge.js";
import { startJunior } from "./junior/runner.js";
import { startWorker } from "./manager/worker.js";
import { isValidCoachKey, setCoachBackend } from "./manager/coach-backends.js";
import { renderRingSvg } from "./ringmap.js";
import { Store } from "./state/db.js";
import { recoverFromCrash, rebuildCacheFromGitHub } from "./state/sync.js";

const WORKER_INTERVAL_MS = 15_000;
const SWEEP_INTERVAL_MS = 60_000;
const AUTOMERGE_INTERVAL_MS = 90_000;
const JUNIOR_INTERVAL_MS = 30_000;

export default function app(probot: Probot, { addHandler }: Partial<ApplicationFunctionOptions> = {}): void {
  const store = new Store(config.dbPath);
  store.recoverStaleJobs();
  // M1-10: crash recovery — reset stale claimed tasks whose lease has expired
  const recovery = recoverFromCrash(store);
  if (recovery.staleTasksReset > 0) {
    probot.log.info(`crash recovery: reset ${recovery.staleTasksReset} stale task(s)`);
  }
  // M1-10: rebuild the SQLite cache from GitHub on startup (§5.7 — disposable cache)
  // Runs asynchronously so the daemon starts serving webhooks immediately.
  if (config.installationId) {
    probot.auth(config.installationId)
      .then(async (octokit) => {
        const { data: repos } = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100 });
        const repoNames = repos.repositories.map((r) => r.full_name);
        const report = await rebuildCacheFromGitHub(store, octokit, repoNames);
        probot.log.info(`cache rebuild: ${report.tasksRebuilt} tasks synced, ${report.tasksClosed} closed, ${report.prsLinked} PRs linked across ${report.reposScanned} repos`);
        if (report.errors.length > 0) {
          probot.log.warn(`cache rebuild errors: ${report.errors.join("; ")}`);
        }
      })
      .catch((e) => probot.log.error(`cache rebuild failed: ${e}`));
  }

  const auth = (installationId: number) => probot.auth(installationId);
  const log = (m: string) => probot.log.info(m);

  probot.on("issues.labeled", (ctx) => onEpicLabeled(ctx, store));
  probot.on("issue_comment.created", (ctx) => onComment(ctx, store));
  // Zero-touch onboarding: installing the app on a repo makes it ready
  probot.on("installation.created", async (ctx) => {
    for (const r of ctx.payload.repositories ?? []) {
      await onboardRepo(ctx.octokit, r.full_name, log).catch((e) => probot.log.error(`onboarding ${r.full_name}: ${e}`));
    }
    repoCache = { at: 0, repos: [] };
  });
  probot.on("installation_repositories.added", async (ctx) => {
    for (const r of ctx.payload.repositories_added ?? []) {
      await onboardRepo(ctx.octokit, r.full_name, log).catch((e) => probot.log.error(`onboarding ${r.full_name}: ${e}`));
    }
    repoCache = { at: 0, repos: [] };
  });
  probot.on(["pull_request.opened", "pull_request.synchronize", "pull_request.reopened"], (ctx) =>
    onPullRequest(ctx, store)
  );
  probot.on("pull_request.closed", (ctx) => onPrClosed(ctx, store));

  // Cache of repos the app is installed on (for the dashboard's project picker)
  let repoCache: { at: number; repos: RepoOption[] } = { at: 0, repos: [] };
  async function installedRepos(): Promise<RepoOption[]> {
    if (Date.now() - repoCache.at < 5 * 60_000) return repoCache.repos;
    // Fast-path: skip listing all installations when a single ID is configured.
    const { installationId } = config;
    if (installationId) {
      const octokit = await probot.auth(installationId);
      const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100 });
      const repos = data.repositories.map((r) => ({ fullName: r.full_name, installationId }));
      repoCache = { at: Date.now(), repos };
      return repos;
    }
    const appAuth = await probot.auth();
    const { data: installations } = await appAuth.rest.apps.listInstallations({ per_page: 100 });
    const repos: RepoOption[] = [];
    for (const inst of installations) {
      const octokit = await probot.auth(inst.id);
      const { data } = await octokit.rest.apps.listReposAccessibleToInstallation({ per_page: 100 });
      for (const r of data.repositories) repos.push({ fullName: r.full_name, installationId: inst.id });
    }
    repoCache = { at: Date.now(), repos };
    return repos;
  }

  // Live GitHub state per task (review threads + CI), cached briefly so
  // auto-refresh stays cheap
  let threadCache: { at: number; map: ThreadMap; branches: RepoBranches } = { at: 0, map: {}, branches: {} };
  async function liveState(): Promise<{ map: ThreadMap; branches: RepoBranches }> {
    if (Date.now() - threadCache.at < 60_000) return threadCache;
    const map: ThreadMap = {};
    const branches: RepoBranches = {};
    const active = store
      .listTasks()
      .filter((t) => ["claimed", "in_review", "changes_requested", "approved"].includes(t.status));
    for (const t of active) {
      try {
        const octokit = await probot.auth(t.installation_id);
        const branch = await branchStateFor(octokit, t.repo, taskBranch(t.agent, t.issue));
        if (t.pr) {
          const [threads, ci, files] = await Promise.all([
            unresolvedThreads(octokit, t.repo, t.pr),
            ciStateFor(octokit, t.repo, t.pr, config.checkName),
            prChangedFiles(octokit, t.repo, t.pr).catch(() => [] as string[]),
          ]);
          map[threadKey(t)] = { threads, ci, branch, files };
        } else {
          map[threadKey(t)] = { threads: { open: [], resolvedCount: 0, total: 0 }, branch };
        }
        if (!branches[t.repo]) {
          branches[t.repo] = await agentBranches(octokit, t.repo).catch(() => ({}));
        }
      } catch (e) {
        probot.log.warn(`live state fetch failed for ${t.repo}#${t.issue}: ${e}`);
      }
    }
    threadCache = { at: Date.now(), map, branches };
    return threadCache;
  }

  // Per-repo trust tier, cached briefly so the dashboard stays cheap.
  let tierCache: { at: number; tiers: Record<string, string> } = { at: 0, tiers: {} };
  async function trustTiersFor(repos: RepoOption[]): Promise<Record<string, string>> {
    if (Date.now() - tierCache.at < 5 * 60_000) return tierCache.tiers;
    const tiers: Record<string, string> = {};
    await Promise.all(
      repos.map(async (r) => {
        try {
          const octokit = await probot.auth(r.installationId);
          const [owner, name] = r.fullName.split("/");
          const result = await readReadiness(octokit, owner, name);
          tiers[r.fullName] = result.tier;
        } catch (e) {
          probot.log.warn(`readiness fetch failed for ${r.fullName}: ${e}`);
          tiers[r.fullName] = "L1";
        }
      }),
    );
    tierCache = { at: Date.now(), tiers };
    return tiers;
  }

  if (addHandler) {
    addHandler((req, res) => {
      const path = (req.url ?? "").split("?")[0];

      // Machine-readable fleet state, so a Claude (or any) session can pilot
      // the fleet conversationally: curl http://localhost:3000/api/state
      if (req.method === "GET" && path === "/api/state") {
        const tasks = store.listTasks().map((t) => ({
          repo: t.repo,
          issue: t.issue,
          agent: t.agent,
          status: t.status,
          title: t.title,
          pr: t.pr,
          revisionRound: t.revision_round,
          plainSummary: t.plain_summary,
          updatedAt: new Date(t.updated_at).toISOString(),
          issueUrl: `https://github.com/${t.repo}/issues/${t.issue}`,
          prUrl: t.pr ? `https://github.com/${t.repo}/pull/${t.pr}` : null,
          openRevisionPoints: store.openRevisionPoints(t.repo, t.issue).map((p) => p.text),
        }));
        const jobs = store.recentJobs(15).map((j) => ({
          id: j.id,
          type: j.type,
          repo: j.repo,
          issue: j.issue,
          status: j.status,
          error: j.error,
        }));
        const summary = {
          queued: tasks.filter((t) => t.status === "queued").length,
          working: tasks.filter((t) => ["claimed", "in_review", "changes_requested"].includes(t.status)).length,
          approved: tasks.filter((t) => t.status === "approved").length,
          done: tasks.filter((t) => t.status === "done").length,
          needsHuman: tasks.filter((t) => t.status === "failed").length + jobs.filter((j) => j.status === "needs_human").length,
        };
        const agentStatus = config.agents.map((a) => {
          const s = store.agentStatus(a);
          return {
            agent: a,
            state: s.state,
            reason: s.reason,
            resetAt: s.reset_at ? new Date(s.reset_at).toISOString() : null,
          };
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ generatedAt: new Date().toISOString(), autoMerge: config.autoMerge, agents: config.agents, agentStatus, summary, tasks, jobs }, null, 2));
        return true;
      }

      // Account-rotation handoff bundle: a compact, copy-pasteable Markdown
      // resume block (fleet snapshot + per-provider availability + the saved
      // "where we left off" note + resume steps). Paste it into a fresh Claude
      // session on another account when this one gets rate-limited.
      if (req.method === "GET" && path === "/api/handoff") {
        const url = new URL(req.url ?? "/", "http://localhost");
        const baseUrl = `http://${req.headers.host ?? "localhost:3000"}`;
        installedRepos()
          .catch(() => [] as RepoOption[])
          .then((repos) => {
            const markdown = renderHandoff(store, repos, { baseUrl });
            if (url.searchParams.get("format") === "json") {
              res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ generatedAt: new Date().toISOString(), markdown }, null, 2));
            } else {
              res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
              res.end(markdown);
            }
          });
        return true;
      }

      // Save the "where we left off" note that the handoff bundle renders.
      if (req.method === "POST" && path === "/dashboard/handoff-note") {
        (async () => {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 65536) { res.writeHead(413, { "content-type": "text/plain" }); res.end("Request Entity Too Large"); return; }
          }
          const params = new URLSearchParams(body);
          const note = (params.get("note") ?? "").trim();
          const author = (params.get("author") ?? "").trim() || null;
          if (note) store.saveHandoffNote(note, author);
          res.writeHead(303, {
            location: "/dashboard?notice=" + encodeURIComponent(note ? "Handoff note saved." : "Note was empty — nothing saved."),
          });
          res.end();
        })().catch((e) => {
          probot.log.error(`handoff-note failed: ${e}`);
          res.writeHead(303, { location: "/dashboard?err=" + encodeURIComponent("couldn't save the note — see server log") });
          res.end();
        });
        return true;
      }

      // The Ring Map fragment — polled by the dashboard every 8s for a live view.
      if (req.method === "GET" && path === "/api/ring") {
        res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
        res.end(renderRingSvg(store));
        return true;
      }

      // Archive everything inactive for 7+ days so the board reflects reality,
      // not a graveyard of old runs. Tasks flip to 'stopped' (relaunchable).
      if (req.method === "POST" && path === "/dashboard/archive-stale") {
        try {
          const cutoff = Date.now() - 7 * 24 * 3600_000;
          const stale = store
            .listTasks()
            .filter((t) => ["queued", "claimed", "in_review", "changes_requested", "approved", "failed"].includes(t.status) && t.updated_at < cutoff);
          for (const t of stale) {
            store.updateTask(t.repo, t.issue, { status: "stopped", lease_expires_at: null });
          }
          res.writeHead(303, {
            location: "/dashboard?notice=" + encodeURIComponent(
              stale.length ? `Archived ${stale.length} stale task(s) — relaunch any of them from its project card.` : "Nothing stale to archive."
            ),
          });
          res.end();
        } catch (e) {
          probot.log.error(`archive-stale failed: ${e}`);
          res.writeHead(303, { location: "/dashboard?err=" + encodeURIComponent("archive failed — see server log") });
          res.end();
        }
        return true;
      }

      // Live-switch which model plays Coach — takes effect on the next dispatch, no restart.
      if (req.method === "POST" && path === "/dashboard/set-coach") {
        (async () => {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 65536) { res.writeHead(413, { "content-type": "text/plain" }); res.end("Request Entity Too Large"); return; }
          }
          const params = new URLSearchParams(body);
          const coach = (params.get("coach") ?? "").trim();
          if (!isValidCoachKey(coach)) {
            res.writeHead(303, { location: "/dashboard?err=" + encodeURIComponent("unknown Coach backend") });
            res.end();
            return;
          }
          setCoachBackend(store, coach);
          res.writeHead(303, { location: "/dashboard?notice=" + encodeURIComponent("Coach switched.") });
          res.end();
        })().catch((e) => {
          probot.log.error(`set-coach failed: ${e}`);
          res.writeHead(303, { location: "/dashboard?err=" + encodeURIComponent("couldn't switch coach — see server log") });
          res.end();
        });
        return true;
      }

      if (req.method === "GET" && (path === "/dashboard" || path === "/dashboard/")) {
        const url = new URL(req.url ?? "/", "http://localhost");
        const notice = url.searchParams.get("ok")
          ? "Request sent! The manager is breaking it into tasks — they'll appear here in a few minutes."
          : url.searchParams.get("merged")
            ? "Accepted! The work is now part of your project. 🎉"
            : url.searchParams.get("notice")
              ? url.searchParams.get("notice")!
              : url.searchParams.get("err")
                ? `That didn't work: ${url.searchParams.get("err")}`
                : undefined;
        Promise.all([
          installedRepos().catch(() => [] as RepoOption[]),
          liveState().catch(() => ({ map: {} as ThreadMap, branches: {} as RepoBranches })),
        ]).then(async ([repos, live]) => {
          const trustTiers = await trustTiersFor(repos).catch(() => ({} as Record<string, string>));
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(renderDashboard(store, repos, notice, live.map, live.branches, trustTiers));
        });
        return true;
      }

      if (req.method === "POST" && (path === "/dashboard/stop" || path === "/dashboard/relaunch")) {
        (async () => {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 65536) { res.writeHead(413, { "content-type": "text/plain" }); res.end("Request Entity Too Large"); return; }
          }
          const params = new URLSearchParams(body);
          const repo = params.get("repo") ?? "";
          const issue = parseInt(params.get("issue") ?? "", 10);
          const task = store.getTask(repo, issue);
          if (!task) {
            res.writeHead(303, { location: "/dashboard?err=" + encodeURIComponent("task not found") });
            res.end();
            return;
          }
          const octokit = await probot.auth(task.installation_id);
          const { owner, repo: name } = splitRepo(repo);
          if (path === "/dashboard/stop") {
            store.updateTask(repo, issue, { status: "stopped", lease_expires_at: null });
            await setStatusLabel(octokit, repo, issue, "stopped");
            await postMessage(
              octokit,
              repo,
              issue,
              { v: 1, type: "reassignment", from: config.managerName, to: task.agent, task: issue },
              `🛑 **Stopped by the owner.** @${task.agent}: stand down on this task immediately. Do not push further commits; abandon local work on branch \`${taskBranch(task.agent, issue)}\`.`
            );
            if (task.pr) {
              await octokit.rest.pulls
                .update({ owner, repo: name, pull_number: task.pr, state: "closed" })
                .catch(() => {});
            }
          } else {
            store.updateTask(repo, issue, { status: "queued", pr: null, lease_expires_at: null, revision_round: 0 });
            await setStatusLabel(octokit, repo, issue, "queued");
            await postMessage(
              octokit,
              repo,
              issue,
              { v: 1, type: "assignment", from: config.managerName, to: task.agent, task: issue },
              `▶ **Relaunched by the owner.** @${task.agent}: this task is available again. Start fresh — pull the latest main first, then work on branch \`${taskBranch(task.agent, issue)}\`.`
            );
          }
          threadCache = { at: 0, map: {}, branches: {} };
          res.writeHead(303, { location: "/dashboard" });
          res.end();
        })().catch((e) => {
          probot.log.error(`${path} failed: ${e}`);
          res.writeHead(303, { location: "/dashboard?err=" + encodeURIComponent("the action failed — see server log") });
          res.end();
        });
        return true;
      }

      if (req.method === "POST" && path === "/dashboard/merge") {
        (async () => {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 65536) { res.writeHead(413, { "content-type": "text/plain" }); res.end("Request Entity Too Large"); return; }
          }
          const params = new URLSearchParams(body);
          const repo = params.get("repo") ?? "";
          const issue = parseInt(params.get("issue") ?? "", 10);
          const task = store.getTask(repo, issue);
          const fail = (msg: string) => {
            res.writeHead(303, { location: `/dashboard?err=${encodeURIComponent(msg)}` });
            res.end();
          };
          if (!task || !task.pr) return fail("that work item no longer exists");
          if (task.status !== "approved") return fail("the manager hasn't approved this work yet");
          const octokit = await probot.auth(task.installation_id);
          // Final safety: automated tests must not be failing or still running
          const ci = await ciStateFor(octokit, repo, task.pr, config.checkName);
          if (ci.overall === "red") return fail(`automated tests are failing (${ci.detail})`);
          if (ci.overall === "pending") return fail("automated tests are still running — try again in a minute");
          const { owner, repo: name } = splitRepo(repo);
          await octokit.rest.pulls.merge({
            owner,
            repo: name,
            pull_number: task.pr,
            merge_method: "squash",
          });
          // pull_request.closed webhook flips the task to done
          threadCache = { at: 0, map: {}, branches: {} };
          res.writeHead(303, { location: "/dashboard?merged=1" });
          res.end();
        })().catch((e) => {
          probot.log.error(`merge failed: ${e}`);
          res.writeHead(303, {
            location: `/dashboard?err=${encodeURIComponent("GitHub refused the merge — it may have conflicts that need a developer")}`,
          });
          res.end();
        });
        return true;
      }

      if (req.method === "POST" && path === "/dashboard/new-work") {
        (async () => {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 65536) { res.writeHead(413, { "content-type": "text/plain" }); res.end("Request Entity Too Large"); return; }
          }
          const params = new URLSearchParams(body);
          const repo = params.get("repo") ?? "";
          const description = (params.get("description") ?? "").trim();
          const repos = await installedRepos();
          const target = repos.find((r) => r.fullName === repo);
          if (!target || !description) {
            res.writeHead(303, { location: "/dashboard" });
            res.end();
            return;
          }
          const octokit = await probot.auth(target.installationId);
          const [owner, name] = repo.split("/");
          const firstLine = description.split("\n")[0].slice(0, 80);
          await octokit.rest.issues.create({
            owner,
            repo: name,
            title: firstLine,
            body: description,
            labels: [LABEL_EPIC],
          });
          // issues.labeled webhook arrives momentarily and queues the decompose
          res.writeHead(303, { location: "/dashboard?ok=1" });
          res.end();
        })().catch((e) => {
          probot.log.error(`new-work failed: ${e}`);
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("Something went wrong creating the request — check the server log.");
        });
        return true;
      }

      return false;
    });
  } else {
    probot.log.warn("addHandler unavailable — dashboard route not mounted");
  }

  const tick = startWorker(store, auth, log);
  const juniorTick = startJunior(store, auth, log);
  // Heartbeat: stamp every tick so the Ring Map can prove the engine is alive
  // (or say loudly that it isn't) — the owner's #1 trust question.
  const beatAndTick = () => {
    store.setSetting("last_worker_tick", String(Date.now()));
    void tick();
  };
  beatAndTick();
  const workerTimer = setInterval(beatAndTick, WORKER_INTERVAL_MS);
  let sweeping = false;
  const sweepTimer = setInterval(async () => {
    if (sweeping) return; // skip if the previous (async, network-bound) sweep is still running
    sweeping = true;
    try {
      await sweepLeases(store, auth, log);
      sweepSilentAgents(store, log);
      sweepRateLimitRecoveries(store, log);
    } finally {
      sweeping = false;
    }
  }, SWEEP_INTERVAL_MS);
  const mergeTimer = setInterval(() => void sweepAutoMerge(store, auth, log), AUTOMERGE_INTERVAL_MS);
  const juniorTimer = setInterval(() => void juniorTick(), JUNIOR_INTERVAL_MS);
  workerTimer.unref();
  sweepTimer.unref();
  mergeTimer.unref();
  juniorTimer.unref();

  probot.log.info(
    `foreman up — agents: [${config.agents.join(", ")}], lease TTL ${config.leaseTtlMinutes}m, ` +
      `manager: ${config.managerDisabled ? "DISABLED" : config.managerCmd}, ` +
      `junior '${config.juniorAgent}': ${config.juniorEnabled ? "on" : "off"}, auto-merge: ${config.autoMerge ? "on" : "off"}`
  );
}
