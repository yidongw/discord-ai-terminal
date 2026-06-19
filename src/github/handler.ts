import { spawnSync } from "child_process";
import {
  ChannelType,
  type Client,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { SessionManager, CompletionAction } from "../bot/session-manager.js";
import {
  postPrComment,
  getPr,
  getPrComments,
  getPrCommits,
  parseTestPlanFromBody,
  extractTestPlanFromComment,
  extractPassedItems,
  extractLastFailedItems,
  buildPreviewUrl,
} from "./pr-comment.js";
import { repoPathFor, resolveBranchWorkDir } from "../utils/path-resolver.js";
import { setPrInThreadName } from "../utils/thread-status.js";
import { CI_FIX_RESUME_SESSION } from "./ci-fix-config.js";
import {
  formatPrClosedMessage,
  formatPrMergedMessage,
  formatPrNewCommitsMessage,
  formatPrOpenedMessage,
} from "./pr-notifications.js";
import {
  makerThreadMatchesBranch,
  resolveDefinitiveMakerThread,
  resolveDefinitiveMakerThreadForLink,
} from "./thread-resolution.js";

// Called by DiscordBot when a GitHub event targets a worker thread so the
// handler can spawn a worker process instead of using sessionManager.runAgent.
export type WorkerDispatch = (
  threadId: string,
  workDir: string,
  agentKey: string,
  prompt: string,
  channelId: string
) => void;

export class GitHubHandler {
  private discordAiTerminalChannelId?: string;
  private workerDispatch?: WorkerDispatch;

  constructor(
    private client: Client,
    private sessionManager: SessionManager,
    private baseFolder: string
  ) {}

  setWorkerDispatch(channelId: string, fn: WorkerDispatch): void {
    this.discordAiTerminalChannelId = channelId;
    this.workerDispatch = fn;
  }

  private isWorkerThread(makerThreadId: string): boolean {
    if (!this.discordAiTerminalChannelId || !this.workerDispatch) return false;
    const session = this.sessionManager.getDb().getThreadSession(makerThreadId);
    return !!session && session.channelId === this.discordAiTerminalChannelId;
  }

  // Called when pull_request.{opened,reopened,ready_for_review} fires. Links the PR
  // to the maker thread, renames it with the PR number, and pins the PR URL.
  async handlePrOpened(repo: string, prNumber: number, headRef: string = ""): Promise<void> {
    // Clear the closed flag so a reopened PR will notify again on next close/merge.
    const db = this.sessionManager.getDb();
    const repoName = repo.split("/")[1] ?? repo;
    db.clearClosedNotified(String(prNumber), repo);
    db.clearClosedNotified(String(prNumber), repoName);
    await this.ensurePrLinkedToMakerThread(repo, prNumber, headRef);
  }

  // Called when pull_request.synchronize fires (new commits pushed to the PR branch).
  // Ensures the PR is linked (idempotent) then notifies the maker thread.
  async handlePrSynchronized(repo: string, prNumber: number, headRef: string, headSha: string): Promise<void> {
    const makerThreadId = await this.ensurePrLinkedToMakerThread(repo, prNumber, headRef);
    const repoName = repo.split("/")[1] ?? repo;
    const shortSha = headSha ? ` — \`${headSha.slice(0, 7)}\`` : "";
    const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
    const msg = formatPrNewCommitsMessage(prNumber, shortSha, prUrl);

    if (!makerThreadId) {
      const channel = await this.findRepoTextChannel(repoName);
      if (channel) {
        await channel.send(msg).catch((err) =>
          console.error(`[github] PR #${prNumber}: failed to notify new commits in channel:`, err)
        );
      }
      return;
    }

    const ch = await this.client.channels.fetch(makerThreadId).catch(() => null);
    const thread = ch?.isThread() ? (ch as ThreadChannel) : null;
    if (!thread) return;

    if (thread.archived) {
      await thread.edit({ archived: false }).catch((err) => {
        console.error(`[github] PR #${prNumber}: failed to unarchive thread for sync:`, err);
      });
    }

    await thread
      .send(msg)
      .catch((err) => console.error(`[github] PR #${prNumber}: failed to notify new commits:`, err));
  }

  // Called when pull_request.closed fires. Notifies the maker thread whether the
  // PR was merged or closed without merging.
  async handlePrClosed(repo: string, prNumber: number, merged: boolean, mergedBy: string | null, prTitle: string, headRef: string = ""): Promise<void> {
    const db = this.sessionManager.getDb();
    const repoName = repo.split("/")[1] ?? repo;

    // Idempotency: skip if already notified (e.g. both webhook and fallback fire)
    if (db.isClosedNotified(String(prNumber), repo) || db.isClosedNotified(String(prNumber), repoName)) {
      console.log(`[github] PR #${prNumber}: close notification already sent — skipping`);
      return;
    }

    let makerThreadId: string | null | undefined =
      db.getPrThreads(String(prNumber), repo)?.makerThreadId ??
      db.getPrThreads(String(prNumber), repoName)?.makerThreadId;

    if (!makerThreadId) {
      // PR may not have been linked yet (bot missed opened/synchronize events) — try now
      makerThreadId = await this.ensurePrLinkedToMakerThread(repo, prNumber, headRef);
    } else if (headRef && !makerThreadMatchesBranch(db, makerThreadId, headRef)) {
      // Wrapper-linked entries are authoritative — the gh wrapper recorded which
      // thread ran `gh pr create` regardless of branch name. Only treat a
      // branch-mismatched link as stale if it was set by a non-wrapper path.
      const wrapperLinked =
        db.isPrLinkedViaWrapper(String(prNumber), repo) ||
        db.isPrLinkedViaWrapper(String(prNumber), repoName);
      if (!wrapperLinked) {
        console.log(`[github] PR #${prNumber}: ignoring stale maker thread link for close notification`);
        makerThreadId = null;
      }
    }

    const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
    const msg = merged
      ? formatPrMergedMessage(prNumber, prTitle, mergedBy, prUrl)
      : formatPrClosedMessage(prNumber, prTitle, prUrl);

    let target: ThreadChannel | TextChannel | null = null;
    let targetLabel = "";

    if (makerThreadId) {
      const ch = await this.client.channels.fetch(makerThreadId).catch(() => null);
      const thread = ch?.isThread() ? (ch as ThreadChannel) : null;
      if (thread) {
        if (thread.archived) {
          await thread.edit({ archived: false }).catch((err) => {
            console.error(`[github] PR #${prNumber}: failed to unarchive thread for close:`, err);
          });
        }
        target = thread;
        targetLabel = `thread ${makerThreadId}`;
      }
    }

    if (!target) {
      target = await this.findRepoTextChannel(repoName);
      targetLabel = target ? `channel #${repoName}` : "";
    }

    if (!target) {
      console.log(`[github] PR #${prNumber} closed/merged but no maker thread or repo channel found`);
      return;
    }

    try {
      await target.send(msg);
      db.setClosedNotified(String(prNumber), repo);
      db.setClosedNotified(String(prNumber), repoName);
      console.log(`[github] PR #${prNumber}: posted close/merge notification to ${targetLabel}`);
    } catch (err) {
      console.error(`[github] PR #${prNumber}: failed to post close/merge notification:`, err);
    }
  }

  // Called by the local PR linker server when an agent's gh wrapper reports a
  // successful `gh pr create`. We know exactly which thread made the PR so we
  // can link it definitively, overriding any earlier guessed linking.
  async handlePrLinkedByThread(
    threadId: string,
    repo: string,
    prNumber: number
  ): Promise<void> {
    console.log(
      `[github] PR #${prNumber} (${repo}): gh wrapper linked to thread ${threadId}`
    );
    await this.ensurePrLinkedToMakerThread(repo, prNumber, "", threadId);
  }

  // Idempotent: link PR → maker thread, rename, and pin. Skips if already linked.
  // headRef is optional — fetched from the GitHub API when missing (preview-ready path).
  // knownMakerThreadId is set when the gh wrapper told us exactly which thread
  // created the PR; it overrides any previous guessed linking so we correct races
  // where the webhook fires before the wrapper's link-pr call lands.
  async ensurePrLinkedToMakerThread(
    repo: string,
    prNumber: number,
    headRef: string = "",
    knownMakerThreadId?: string
  ): Promise<string | null> {
    const db = this.sessionManager.getDb();
    const repoName = repo.split("/")[1] ?? repo;
    let ref = headRef;
    // Only hit the GitHub API when we have neither a known thread nor a headRef.
    if (!ref && !knownMakerThreadId) {
      const pr = await getPr(repo, prNumber);
      ref = pr?.head?.ref ?? "";
    }

    const existing =
      db.getPrThreads(String(prNumber), repo)?.makerThreadId ??
      db.getPrThreads(String(prNumber), repoName)?.makerThreadId;
    if (existing) {
      if (knownMakerThreadId && existing === knownMakerThreadId) return existing;
      // Wrapper-linked entries are authoritative regardless of branch name —
      // any agent can open a PR with any branch, and the gh wrapper recorded
      // which thread did it. Skip the stale-link heuristic for those.
      const wrapperLinked =
        db.isPrLinkedViaWrapper(String(prNumber), repo) ||
        db.isPrLinkedViaWrapper(String(prNumber), repoName);
      if (wrapperLinked && !knownMakerThreadId) return existing;
      const definitive = resolveDefinitiveMakerThreadForLink(db, ref, repoName);
      if (!knownMakerThreadId) {
        if (definitive === existing) return existing;
        console.log(
          `[github] PR #${prNumber}: ignoring stale maker thread link ${existing}` +
            (ref ? ` (branch ${ref})` : "")
        );
      }
    }

    let makerThreadId =
      knownMakerThreadId ?? resolveDefinitiveMakerThreadForLink(db, ref, repoName);

    if (!makerThreadId) {
      // Webhook may have raced the wrapper's /link-pr POST. Wait briefly and
      // re-check the DB before falling through to the repo channel — if the
      // wrapper lands during the wait we route to the maker thread instead.
      await new Promise((r) => setTimeout(r, 3000));
      const recheck =
        db.getPrThreads(String(prNumber), repo)?.makerThreadId ??
        db.getPrThreads(String(prNumber), repoName)?.makerThreadId;
      if (recheck) {
        // Wrapper landed during the wait — link is already in DB; just return it.
        return recheck;
      }
      console.log(
        `[github] PR #${prNumber}: no definitive maker thread for ${repoName}` +
          (ref ? ` (branch ${ref})` : "") +
          " — posting to repo channel"
      );
      const channel = await this.findRepoTextChannel(repoName);
      if (channel) {
        const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
        try {
          await channel.send(formatPrOpenedMessage(prNumber, prUrl));
        } catch (err) {
          console.error(`[github] PR #${prNumber}: failed to post to repo channel:`, err);
        }
      }
      return null;
    }

    db.setPrMakerThread(String(prNumber), repo, makerThreadId, !!knownMakerThreadId);
    console.log(
      `[github] PR #${prNumber} linked to maker thread ${makerThreadId}` +
        (knownMakerThreadId ? " (via gh wrapper)" : "")
    );
    try {
      const ch = await this.client.channels.fetch(makerThreadId).catch(() => null);
      const thread = ch?.isThread() ? (ch as ThreadChannel) : null;
      if (!thread) {
        console.error(`[github] PR #${prNumber}: channel ${makerThreadId} not found or not a thread`);
        return makerThreadId;
      }
      // Unarchive before renaming or sending — Discord rejects both on archived
      // threads with a 400 error. Opening a PR is a natural signal to reactivate.
      if (thread.archived) {
        await thread.edit({ archived: false }).catch((err) => {
          console.error(`[github] PR #${prNumber}: failed to unarchive thread:`, err);
        });
      }
      void setPrInThreadName(thread, prNumber);
      const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
      try {
        const msg = await thread.send(prUrl);
        await msg.pin();
      } catch (err) {
        console.error(`[github] PR #${prNumber}: failed to post/pin PR URL:`, err);
      }
    } catch (err) {
      console.error(`[github] PR #${prNumber}: failed to update maker thread:`, err);
    }

    return makerThreadId;
  }

  // Called when the user types /test in a PR maker thread. Builds a smart test
  // plan by combining the PR description, commit history, and previous test results
  // (skipping items already marked PASS). Starts the cx test agent in a dedicated
  // test thread named "🔄 #{pr-number} • Test".
  async handleTestCommand(repo: string, prNumber: number, makerThread: ThreadChannel): Promise<void> {
    const repoName = repo.split("/")[1] ?? repo;

    const pr = await getPr(repo, prNumber);
    if (!pr) {
      await makerThread.send(`❌ Could not fetch PR #${prNumber}.`);
      return;
    }
    if (pr.merged) {
      await makerThread.send(`ℹ️ PR #${prNumber} is already merged.`);
      return;
    }

    const [comments, commits] = await Promise.all([
      getPrComments(repo, prNumber),
      getPrCommits(repo, prNumber),
    ]);

    // Build the combined item list: PR description + previously-failed items
    const descriptionItems = parseTestPlanFromBody(pr.body ?? "") ?? [];
    const failedItems = extractLastFailedItems(comments);
    const allItems = [...new Set([...descriptionItems, ...failedItems])];

    // Remove items that already PASS in any previous test summary
    const passedItems = extractPassedItems(comments);
    const pendingItems = allItems.filter((item) => !passedItems.has(item.toLowerCase()));

    if (pendingItems.length === 0) {
      if (allItems.length > 0) {
        await makerThread.send(`✅ All ${allItems.length} test item${allItems.length !== 1 ? "s" : ""} are already passing!`);
      } else {
        await makerThread.send(`⚠️ No test plan found. Add a \`## Test plan\` section to the PR description.`);
      }
      return;
    }

    const previewUrl = buildPreviewUrl(repo, prNumber);
    const skippedCount = allItems.length - pendingItems.length;
    const listText = pendingItems.map((t) => `- ${t}`).join("\n");
    const skippedNote = skippedCount > 0 ? ` *(${skippedCount} already passing — skipped)*` : "";

    // Post the test plan to the Discord maker thread
    await makerThread.send(
      `🧪 **Test plan for PR #${prNumber}**${skippedNote}\n\n${listText}\n\nPreview: ${previewUrl}`
    );

    // Post the test plan to the GitHub PR
    await postPrComment(
      repo,
      prNumber,
      `🧪 **Test plan** (${pendingItems.length} item${pendingItems.length !== 1 ? "s" : ""})\n\n${listText}\n\nPreview: ${previewUrl}`
    );

    // Get or create the test thread
    const testThread = await this.getOrCreateTestThread(repoName, prNumber);
    if (!testThread) {
      await makerThread.send(`❌ Could not create test thread for PR #${prNumber}.`);
      return;
    }

    if (this.sessionManager.hasActiveProcess(testThread.id)) {
      await makerThread.send(`⚠️ A test is already running in the test thread for PR #${prNumber}.`);
      return;
    }

    const commitHistory = commits
      .slice(-10)
      .map((c) => `- ${(c.commit.message.split("\n")[0] ?? "").slice(0, 80)}`)
      .join("\n");

    const prompt = buildTestPrompt(prNumber, previewUrl, pr.title, pr.body ?? "", pendingItems, commitHistory);

    await this.sessionManager.runAgent(
      testThread.id,
      testThread.parentId ?? testThread.id,
      testThread,
      "cx",
      repoPathFor(repoName, this.baseFolder) ?? this.baseFolder,
      prompt,
      undefined,
      { completion: { kind: "pr_test", repo, prNumber, agentKey: "cx" } }
    );
  }

  // Dispatch a run's persisted CompletionAction once it finishes.
  async runCompletionAction(action: CompletionAction, text: string): Promise<void> {
    if (action.kind === "pr_test") {
      const statusMatch = text.match(/STATUS:\s*(PASS|FAIL)/i);
      const status = statusMatch ? statusMatch[1]!.toUpperCase() : "UNKNOWN";
      const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️";
      const agent = action.agentKey === "cx" ? "Codex" : "Claude Code";

      await postPrComment(
        action.repo,
        action.prNumber,
        `${icon} **${agent} test result — PR #${action.prNumber}**\n\n${text.trim()}`
      );

      // On failure, ping the maker thread so the developer knows to fix and re-run /test
      if (status === "FAIL") {
        const db = this.sessionManager.getDb();
        const prThreads =
          db.getPrThreads(String(action.prNumber), action.repo) ??
          db.getPrThreads(String(action.prNumber), action.repo.split("/")[1] ?? action.repo);
        const makerThreadId = prThreads?.makerThreadId;
        if (makerThreadId) {
          try {
            const makerThread = await this.client.channels.fetch(makerThreadId).catch(() => null);
            if (makerThread?.isThread()) {
              await (makerThread as ThreadChannel).send(
                `❌ Tests failed for PR #${action.prNumber}. Fix the issues and run \`/test\` again.`
              );
            }
          } catch (err) {
            console.error(`[github] PR #${action.prNumber}: failed to ping maker thread:`, err);
          }
        }
      }
    }
  }

  // Called when a workflow_run completes with failure or timed_out. Finds the
  // maker thread, notifies it, then either runs the agent immediately or queues
  // a fix prompt to start as soon as the agent finishes its current task.
  async handleCiFailure(
    repo: string,
    prNumber: number | null,
    workflowName: string,
    runUrl: string,
    headBranch: string
  ): Promise<void> {
    const db = this.sessionManager.getDb();
    const repoName = repo.split("/")[1] ?? repo;

    const makerThreadId = resolveDefinitiveMakerThread(db, repo, repoName, prNumber, headBranch);

    const label = prNumber ? `PR #${prNumber}` : headBranch || repo;
    const workflowLink = runUrl ? `[${workflowName}](${runUrl})` : workflowName;
    const fixPrompt = buildCiFixPrompt(label, workflowName, runUrl);
    const runOpts = {
      prNumber: prNumber ?? undefined,
      freshSession: !CI_FIX_RESUME_SESSION,
    };

    let targetThread: ThreadChannel | null = null;
    let workDir: string | null = null;
    let channelId: string | null = null;
    let agentKey = "cc";

    if (makerThreadId) {
      const session = db.getThreadSession(makerThreadId);
      if (!session) {
        console.log(`[github] CI failure: no thread session for ${makerThreadId}, cannot auto-fix in maker thread`);
      } else {
        const chCi = await this.client.channels.fetch(makerThreadId).catch(() => null);
        const thread = chCi?.isThread() ? (chCi as ThreadChannel) : null;
        if (thread) {
          targetThread = thread;
          workDir = session.workDir;
          channelId = session.channelId;
          agentKey = session.agent;
        }
      }
    }

    if (!targetThread) {
      const fixThread = await this.getOrCreateCiFixThread(repoName, prNumber, headBranch);
      if (!fixThread) {
        console.log(
          `[github] CI failure on ${repo} (${workflowName}): no maker thread and could not create fix thread` +
            (prNumber ? ` for PR #${prNumber}` : "") +
            (headBranch ? ` branch=${headBranch}` : "")
        );
        return;
      }
      targetThread = fixThread;
      channelId = fixThread.parentId ?? fixThread.id;
      workDir =
        (headBranch
          ? resolveBranchWorkDir(repoName, this.baseFolder, fixThread.id, headBranch)
          : null) ??
        repoPathFor(repoName, this.baseFolder);
      if (!workDir) {
        console.error(`[github] CI failure: could not resolve work dir for ${repoName}`);
        return;
      }
      console.log(`[github] CI failure: using dedicated fix thread ${fixThread.id}`);
    }

    if (targetThread.archived) {
      await targetThread.edit({ archived: false }).catch((err) => {
        console.error(`[github] CI failure: failed to unarchive thread ${targetThread!.id}:`, err);
      });
    }

    const threadId = targetThread.id;

    // Worker thread: dispatch via worker process instead of the main SessionManager.
    if (this.isWorkerThread(threadId)) {
      const session = db.getThreadSession(threadId);
      if (!session) {
        console.log(`[github] CI failure: no thread session for worker ${threadId}, cannot auto-fix`);
        return;
      }
      await targetThread.send(`⚠️ GitHub Actions failed for ${label}: ${workflowLink}`);
      this.workerDispatch!(threadId, workDir!, session.agent, fixPrompt, session.channelId);
      console.log(`[github] CI failure: spawned worker fix run in ${threadId}`);
      return;
    }

    const isBusy = this.sessionManager.hasActiveProcess(threadId);

    if (isBusy) {
      this.sessionManager.setPendingPostRunPrompt(threadId, fixPrompt, runOpts);
      await targetThread.send(
        `⚠️ GitHub Actions failed for ${label}: ${workflowLink}\n🔄 Agent is busy — will investigate once current task finishes.`
      );
      console.log(`[github] CI failure queued for ${threadId} (busy)`);
    } else {
      await targetThread.send(`⚠️ GitHub Actions failed for ${label}: ${workflowLink}`);
      try {
        await this.sessionManager.runAgent(
          threadId,
          channelId!,
          targetThread,
          agentKey,
          workDir!,
          fixPrompt,
          undefined,
          { ...runOpts, branch: headBranch || undefined }
        );
        console.log(`[github] CI failure: started fix run in ${threadId}`);
      } catch (err) {
        console.error(`[github] CI failure: failed to start fix run:`, err);
      }
    }
  }

  async handlePreviewUrl(repo: string, prNumber: number, previewUrl: string): Promise<void> {
    const repoName = repo.split("/")[1] ?? repo;
    const db = this.sessionManager.getDb();

    // Second chance when pull_request.opened was missed (e.g. Actions didn't forward it).
    await this.ensurePrLinkedToMakerThread(repo, prNumber);

    // Prefer makerThreadId (where the developer is working); fall back to testThreadId.
    // testThreadId is stored under repoName; makerThreadId under repo (full name).
    const byName = db.getPrThreads(String(prNumber), repoName);
    const byFull = db.getPrThreads(String(prNumber), repo);
    const threadId =
      byName?.makerThreadId ?? byFull?.makerThreadId ??
      byName?.testThreadId ?? byFull?.testThreadId;

    console.log(
      `[github] PR #${prNumber}: preview-ready received — threadId=${threadId ?? "none"} ` +
      `(makerByName=${byName?.makerThreadId ?? "-"} makerByFull=${byFull?.makerThreadId ?? "-"} ` +
      `testByName=${byName?.testThreadId ?? "-"} testByFull=${byFull?.testThreadId ?? "-"})`
    );

    if (threadId) {
      try {
        const chPrev = await this.client.channels.fetch(threadId).catch(() => null);
        const prevThread = chPrev?.isThread() ? (chPrev as ThreadChannel) : null;
        if (prevThread) {
          if (prevThread.archived) {
            await prevThread.edit({ archived: false }).catch(() => {});
          }
          await prevThread.send(`🔗 Preview URL ready: ${previewUrl}`);
          console.log(`[github] PR #${prNumber}: posted preview URL to thread ${threadId}`);
        } else {
          console.error(`[github] PR #${prNumber}: thread ${threadId} not fetchable or not a thread — preview URL NOT delivered`);
        }
      } catch (err) {
        console.error(`[github] PR #${prNumber}: failed to post preview URL to thread ${threadId}:`, err);
      }
    } else {
      console.error(`[github] PR #${prNumber}: no thread found to post preview URL (repo=${repo})`);
    }
  }

  // Called at the end of every discord/ worktree session. Detects PRs that were
  // created while the bot was down or before the GitHub webhook was configured,
  // and links them to the Discord thread exactly as if the webhook had fired.
  async checkAndLinkPrForBranch(threadId: string, workDir: string, branch: string): Promise<void> {
    const remoteResult = spawnSync("git", ["-C", workDir, "remote", "get-url", "origin"], {
      encoding: "utf8", timeout: 5000,
    });
    if (remoteResult.status !== 0 || !remoteResult.stdout.trim()) return;

    const remoteUrl = remoteResult.stdout.trim();
    const repoMatch = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (!repoMatch) return;
    const repo = repoMatch[1]!;

    const prResult = spawnSync(
      "gh", ["pr", "list", "--head", branch, "--json", "number", "--repo", repo],
      { encoding: "utf8", timeout: 10000 }
    );
    if (prResult.status !== 0 || !prResult.stdout.trim()) return;

    let prs: Array<{ number: number }>;
    try { prs = JSON.parse(prResult.stdout); }
    catch { return; }
    if (prs.length === 0) {
      // No open PR — check if a linked PR was merged/closed without webhook delivery
      await this.checkLinkedPrClosed(threadId, repo);
      return;
    }

    const prNumber = prs[0]!.number;
    console.log(`[github] thread ${threadId}: found PR #${prNumber} on ${branch} — linking (webhook fallback)`);
    await this.ensurePrLinkedToMakerThread(repo, prNumber, branch);
    await this.checkLinkedPrClosed(threadId, repo);
  }

  // Called when checkAndLinkPrForBranch finds no open PR. Checks if there is a
  // linked PR for this thread that was merged/closed without the webhook firing.
  private async checkLinkedPrClosed(threadId: string, repo: string): Promise<void> {
    const db = this.sessionManager.getDb();
    const linked = db.findPrForMakerThread(threadId);
    if (!linked) return;

    if (db.isClosedNotified(linked.prNumber, linked.repo)) return;

    const viewResult = spawnSync(
      "gh", ["pr", "view", linked.prNumber, "--repo", linked.repo, "--json", "state,mergedAt,mergedBy,title"],
      { encoding: "utf8", timeout: 10000 }
    );
    if (viewResult.status !== 0 || !viewResult.stdout.trim()) return;

    let prData: { state: string; mergedAt: string | null; mergedBy: { login: string } | null; title: string };
    try { prData = JSON.parse(viewResult.stdout); }
    catch { return; }

    if (prData.state === "OPEN") return;

    const merged = prData.state === "MERGED" || prData.mergedAt !== null;
    console.log(`[github] PR #${linked.prNumber} on thread ${threadId}: state=${prData.state} — sending close notification (fallback)`);
    await this.handlePrClosed(
      linked.repo,
      Number(linked.prNumber),
      merged,
      prData.mergedBy?.login ?? null,
      prData.title
    );
  }

  private async findRepoTextChannel(repoName: string): Promise<TextChannel | null> {
    let guild = this.client.guilds.cache.first();
    if (!guild) {
      console.error("[github] No guild in cache — bot not ready?");
      return null;
    }

    if (guild.channels.cache.size === 0) {
      await guild.channels.fetch();
    }

    const channel = guild.channels.cache.find(
      (c) => c.name === repoName && c.type === ChannelType.GuildText
    ) as TextChannel | undefined;

    if (!channel) {
      console.error(
        `[github] No Discord channel named "${repoName}" (searched ${guild.channels.cache.size} channels)`
      );
      return null;
    }

    return channel;
  }

  private async getOrCreateCiFixThread(
    repoName: string,
    prNumber: number | null,
    headBranch: string
  ): Promise<ThreadChannel | null> {
    const db = this.sessionManager.getDb();

    if (prNumber) {
      const existing =
        db.getPrThreads(String(prNumber), repoName)?.ciFixThreadId;
      if (existing) {
        const cached = await this.client.channels.fetch(existing).catch(() => null);
        if (cached?.isThread()) return cached as ThreadChannel;
      }
    }

    const channel = await this.findRepoTextChannel(repoName);
    if (!channel) return null;

    const name = prNumber
      ? `🔧 #${prNumber} • CI Fix`
      : `🔧 ${headBranch.slice(0, 40) || repoName} • CI Fix`;
    console.log(`[github] Creating CI fix thread "${name}" in #${repoName}`);
    const thread = (await channel.threads.create({
      name,
      autoArchiveDuration: 1440,
    })) as ThreadChannel;

    if (prNumber) {
      db.setPrCiFixThread(String(prNumber), repoName, thread.id);
    }
    console.log(`[github] CI fix thread created: ${thread.id}`);
    return thread;
  }

  private async getOrCreateTestThread(
    repoName: string,
    prNumber: number
  ): Promise<ThreadChannel | null> {
    const db = this.sessionManager.getDb();
    const existing = db.getPrThreads(String(prNumber), repoName);

    if (existing?.testThreadId) {
      const cached = await this.client.channels
        .fetch(existing.testThreadId)
        .catch(() => null);
      if (cached?.isThread()) return cached as ThreadChannel;
    }

    const channel = await this.findRepoTextChannel(repoName);
    if (!channel) return null;

    const name = `🔄 #${prNumber} • Test`;
    console.log(`[github] Creating test thread "${name}" in #${repoName}`);
    const thread = (await channel.threads.create({
      name,
      autoArchiveDuration: 1440,
    })) as ThreadChannel;

    db.setPrTestThread(String(prNumber), repoName, thread.id);
    console.log(`[github] Test thread created: ${thread.id}`);
    return thread;
  }
}

function buildTestPrompt(
  prNumber: number,
  previewUrl: string,
  prTitle: string,
  prBody: string,
  testItems: string[],
  commitHistory: string
): string {
  const checklist = testItems.map((t, i) => `${i + 1}. ${t}`).join("\n");

  return `You are a QA agent for this project.
PR #${prNumber}: ${prTitle}
Preview URL: ${previewUrl}

Test plan:
${checklist}

Recent commits:
${commitHistory || "(no commits)"}

PR description (additional context):
${prBody || "(no description provided)"}

Use agent-browser to test the preview:
  agent-browser open <url>
  agent-browser snapshot -i
  agent-browser click @eN / agent-browser fill @eN "text"
  agent-browser screenshot --path /tmp/pr-${prNumber}-N.png

Test each item and report your findings in this exact format:
STATUS: PASS or FAIL
FINDINGS:
- <item> — PASS/FAIL — details

If STATUS is FAIL, append a Test plan for the next run — list only the items that failed plus any new issues you discovered:
Test plan:
- <item>`;
}

function buildCiFixPrompt(label: string, workflowName: string, runUrl: string): string {
  return `GitHub Actions failed for ${label}.

Workflow: ${workflowName}
Run URL: ${runUrl}

Please investigate the failure:
1. Run the failing tests or checks locally to reproduce the issue
2. Look at git log and recent changes to understand what might have caused it
3. Fix the root cause
4. Verify the fix works locally before finishing`;
}
