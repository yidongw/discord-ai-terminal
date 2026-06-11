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
import { repoPathFor } from "../utils/path-resolver.js";
import { setPrInThreadName } from "../utils/thread-status.js";

export class GitHubHandler {
  constructor(
    private client: Client,
    private sessionManager: SessionManager,
    private baseFolder: string
  ) {}

  // Called when pull_request.{opened,reopened,ready_for_review} fires. Links the PR
  // to the maker thread, renames it with the PR number, and pins the PR URL.
  async handlePrOpened(repo: string, prNumber: number, headRef: string = ""): Promise<void> {
    await this.ensurePrLinkedToMakerThread(repo, prNumber, headRef);
  }

  // Idempotent: link PR → maker thread, rename, and pin. Skips if already linked.
  // headRef is optional — fetched from the GitHub API when missing (preview-ready path).
  async ensurePrLinkedToMakerThread(
    repo: string,
    prNumber: number,
    headRef: string = ""
  ): Promise<string | null> {
    const db = this.sessionManager.getDb();
    const existing = db.getPrThreads(String(prNumber), repo)?.makerThreadId;
    if (existing) return existing;

    const repoName = repo.split("/")[1] ?? repo;
    let ref = headRef;
    if (!ref) {
      const pr = await getPr(repo, prNumber);
      ref = pr?.head?.ref ?? "";
    }

    const makerThreadId = ref.startsWith("discord/")
      ? (db.findThreadByBranch(ref) ?? db.findMakerThreadForRepo(repoName))
      : db.findMakerThreadForRepo(repoName);

    if (!makerThreadId) {
      console.log(
        `[github] PR #${prNumber}: no maker thread found for ${repoName}` +
          (ref ? ` (branch ${ref})` : "")
      );
      return null;
    }

    db.setPrMakerThread(String(prNumber), repo, makerThreadId);
    console.log(`[github] PR #${prNumber} linked to maker thread ${makerThreadId}`);
    try {
      const thread = await this.client.channels.fetch(makerThreadId) as ThreadChannel | null;
      if (thread) {
        void setPrInThreadName(thread, prNumber);
        const prUrl = `https://github.com/${repo}/pull/${prNumber}`;
        try {
          const msg = await thread.send(prUrl);
          await msg.pin();
        } catch (err) {
          console.error(`[github] PR #${prNumber}: failed to post/pin PR URL:`, err);
        }
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

    let makerThreadId: string | null | undefined = null;

    if (prNumber) {
      makerThreadId =
        db.getPrThreads(String(prNumber), repo)?.makerThreadId ??
        db.getPrThreads(String(prNumber), repoName)?.makerThreadId;
    }

    if (!makerThreadId && headBranch) {
      makerThreadId = db.findThreadByBranch(headBranch);
    }

    if (!makerThreadId) {
      console.log(
        `[github] CI failure on ${repo} (${workflowName}): no maker thread found` +
          (prNumber ? ` for PR #${prNumber}` : "") +
          (headBranch ? ` branch=${headBranch}` : "")
      );
      return;
    }

    const label = prNumber ? `PR #${prNumber}` : headBranch || repo;
    const workflowLink = runUrl ? `[${workflowName}](${runUrl})` : workflowName;
    const fixPrompt = buildCiFixPrompt(label, workflowName, runUrl);

    let thread: import("discord.js").ThreadChannel | null = null;
    try {
      const ch = await this.client.channels.fetch(makerThreadId).catch(() => null);
      if (ch?.isThread()) thread = ch as import("discord.js").ThreadChannel;
    } catch (err) {
      console.error(`[github] CI failure: failed to fetch thread ${makerThreadId}:`, err);
      return;
    }

    if (!thread) {
      console.error(`[github] CI failure: thread ${makerThreadId} not found or not a thread`);
      return;
    }

    const isBusy = this.sessionManager.hasActiveProcess(makerThreadId);

    if (isBusy) {
      this.sessionManager.setPendingPostRunPrompt(makerThreadId, fixPrompt);
      await thread.send(
        `⚠️ GitHub Actions failed for ${label}: ${workflowLink}\n🔄 Agent is busy — will investigate once current task finishes.`
      );
      console.log(`[github] CI failure queued for ${makerThreadId} (busy)`);
    } else {
      await thread.send(`⚠️ GitHub Actions failed for ${label}: ${workflowLink}`);
      const session = db.getThreadSession(makerThreadId);
      if (!session) {
        console.log(`[github] CI failure: no thread session for ${makerThreadId}, cannot auto-fix`);
        return;
      }
      try {
        await this.sessionManager.runAgent(
          makerThreadId,
          session.channelId,
          thread,
          session.agent,
          session.workDir,
          fixPrompt,
          undefined
        );
        console.log(`[github] CI failure: started fix run in ${makerThreadId}`);
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
        const thread = await this.client.channels.fetch(threadId).catch(() => null);
        if (thread?.isThread()) {
          await thread.send(`🔗 Preview URL ready: ${previewUrl}`);
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
