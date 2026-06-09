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
  parseTestPlanFromBody,
  extractTestPlanFromComment,
} from "./pr-comment.js";
import { repoPathFor } from "../utils/path-resolver.js";

export class GitHubHandler {
  constructor(
    private client: Client,
    private sessionManager: SessionManager,
    private baseFolder: string
  ) {}

  // Called when pull_request.opened fires. Links the PR to the maker thread.
  // Tests are triggered later via handlePreviewUrl once the preview URL is ready.
  async handlePrOpened(repo: string, prNumber: number): Promise<void> {
    const repoName = repo.split("/")[1] ?? repo;

    const makerThreadId = this.sessionManager.getDb().findMakerThreadForRepo(repoName);
    if (makerThreadId) {
      this.sessionManager.getDb().setPrMakerThread(String(prNumber), repo, makerThreadId);
      console.log(`[github] PR #${prNumber} linked to maker thread ${makerThreadId}`);
    } else {
      console.log(`[github] PR #${prNumber}: no maker thread found for ${repoName}`);
    }
  }

  // Called when issue_comment.created fires with a /cc or /cx command.
  async handleComment(
    repo: string,
    prNumber: number,
    previewUrl: string,
    command: string, // "cc" or "cx"
    fixItems?: string[], // bugs from "/cc fix:\n- item"
    testItems?: string[] // checklist from "/cc test:\n- item"
  ): Promise<void> {
    const repoName = repo.split("/")[1] ?? repo;

    if (command === "cc" && fixItems?.length) {
      await this.runFix(repo, repoName, prNumber, fixItems);
    } else {
      await this.runTest(repo, repoName, prNumber, previewUrl, command, testItems ?? []);
    }
  }

  private async runTest(
    repo: string,
    repoName: string,
    prNumber: number,
    previewUrl: string,
    agentKey: string,
    testItems: string[]
  ): Promise<void> {
    const prState = this.sessionManager.getDb().getPrThreads(String(prNumber), repo);

    if (prState?.testsSkipped) {
      await postPrComment(
        repo,
        prNumber,
        `⏭️ Tests are currently skipped for PR #${prNumber}. Post \`/enable-tests\` to re-enable.`
      );
      return;
    }

    if (testItems.length === 0) {
      console.log(`[github] PR #${prNumber}: no test items, skipping`);
      return;
    }

    const pr = await getPr(repo, prNumber);
    if (pr?.merged) {
      console.log(`[github] PR #${prNumber}: already merged, skipping test`);
      return;
    }
    const prTitle = pr?.title ?? `PR #${prNumber}`;
    const prBody = pr?.body ?? "";

    const thread = await this.getOrCreateTestThread(repoName, prNumber);
    if (!thread) {
      console.error(`[github] Could not find/create test thread for PR #${prNumber}`);
      return;
    }

    const prompt = buildTestPrompt(prNumber, previewUrl, prTitle, prBody, testItems);

    await this.sessionManager.runAgent(
      thread.id,
      thread.parentId ?? thread.id,
      thread,
      agentKey,
      repoPathFor(repoName, this.baseFolder) ?? this.baseFolder,
      prompt,
      undefined,
      { completion: { kind: "pr_test", repo, prNumber, agentKey } }
    );
  }

  private async runFix(
    repo: string,
    repoName: string,
    prNumber: number,
    bugItems: string[]
  ): Promise<void> {
    const pr = await getPr(repo, prNumber);
    if (pr?.merged) {
      console.log(`[github] PR #${prNumber}: already merged, skipping fix`);
      return;
    }

    const makerThreadId = this.sessionManager
      .getDb()
      .getPrThreads(String(prNumber), repo)?.makerThreadId;

    let thread: ThreadChannel | null = null;
    if (makerThreadId) {
      thread = (await this.client.channels
        .fetch(makerThreadId)
        .catch(() => null)) as ThreadChannel | null;
    }

    if (!thread) {
      thread = await this.getOrCreateTestThread(repoName, prNumber);
    }

    if (!thread) {
      console.error(`[github] Could not find any thread for PR #${prNumber} fix`);
      return;
    }

    const workDir =
      this.sessionManager.getDb().getThreadSession(makerThreadId ?? "")?.workDir ??
      repoPathFor(repoName, this.baseFolder) ??
      this.baseFolder;

    await this.sessionManager.runAgent(
      thread.id,
      thread.parentId ?? thread.id,
      thread,
      "cc",
      workDir,
      buildFixPrompt(prNumber, bugItems),
      undefined,
      { prNumber, completion: { kind: "pr_fix", repo, prNumber } }
    );
  }

  // Dispatch a run's persisted CompletionAction once it finishes.
  async runCompletionAction(action: CompletionAction, text: string): Promise<void> {
    if (action.kind === "pr_test") {
      const statusMatch = text.match(/STATUS:\s*(PASS|FAIL)/i);
      const status = statusMatch ? statusMatch[1]!.toUpperCase() : "UNKNOWN";

      // Post the summary. The Test plan: block is included when STATUS is FAIL
      // so it's visible in the PR and readable by the bot for the next re-run.
      await postPrComment(
        action.repo,
        action.prNumber,
        buildPrTestSummary(action.agentKey, action.prNumber, text)
      );

      if (status === "FAIL") {
        // Post /cc fix: as its own comment so the webhook dispatch picks it up
        // and triggers the fix run.
        const fix = extractFixBlock(text);
        if (fix) await postPrComment(action.repo, action.prNumber, fix);
      }
      // On PASS the loop ends — nothing more to post.
    } else if (action.kind === "pr_fix") {
      await postPrComment(action.repo, action.prNumber, buildPrFixSummary(action.prNumber, text));

      // Auto-trigger re-test: read the Test plan from the last test summary comment.
      const comments = await getPrComments(action.repo, action.prNumber);
      for (let i = comments.length - 1; i >= 0; i--) {
        const plan = extractTestPlanFromComment(comments[i]!.body);
        if (plan && plan.length > 0) {
          const items = plan.map((t) => `- ${t}`).join("\n");
          await postPrComment(action.repo, action.prNumber, `/cc test:\n${items}`);
          break;
        }
      }
    }
  }

  async handlePreviewUrl(repo: string, prNumber: number, previewUrl: string): Promise<void> {
    const repoName = repo.split("/")[1] ?? repo;
    const db = this.sessionManager.getDb();

    // testThreadId is stored under repoName; makerThreadId under repo (full name)
    const byName = db.getPrThreads(String(prNumber), repoName);
    const byFull = db.getPrThreads(String(prNumber), repo);
    const threadId =
      byName?.testThreadId ?? byFull?.testThreadId ??
      byName?.makerThreadId ?? byFull?.makerThreadId;

    if (threadId) {
      const thread = await this.client.channels.fetch(threadId).catch(() => null);
      if (thread?.isThread()) {
        await thread.send(`🔗 Preview URL ready: ${previewUrl}`);
        console.log(`[github] PR #${prNumber}: posted preview URL to thread ${threadId}`);
      }
    } else {
      console.log(`[github] PR #${prNumber}: no thread found to post preview URL`);
    }

    // Guard against duplicate test triggers (e.g. both /preview-ready and bot comment webhook fire).
    const existingUrl = byName?.previewUrl ?? byFull?.previewUrl;
    if (existingUrl === previewUrl) {
      console.log(`[github] PR #${prNumber}: preview URL already processed, skipping test trigger`);
      return;
    }
    db.setPrPreviewUrl(String(prNumber), repoName, previewUrl);

    // Fetch PR to check merged state and extract test plan.
    const pr = await getPr(repo, prNumber);
    if (!pr || pr.merged) return;

    const testPlan = parseTestPlanFromBody(pr.body ?? "");
    if (!testPlan || testPlan.length === 0) {
      console.log(`[github] PR #${prNumber}: no test plan in description, skipping test trigger`);
      return;
    }

    console.log(`[github] PR #${prNumber}: triggering test with ${testPlan.length} items and real preview URL`);
    await this.runTest(repo, repoName, prNumber, previewUrl, "cc", testPlan);
  }

  async handleSkipTests(repo: string, prNumber: number): Promise<void> {
    this.sessionManager.getDb().setPrTestsSkipped(String(prNumber), repo, true);
    await postPrComment(
      repo,
      prNumber,
      `⏭️ Tests skipped for PR #${prNumber}. Post \`/enable-tests\` to re-enable.`
    );
  }

  async handleEnableTests(repo: string, prNumber: number): Promise<void> {
    this.sessionManager.getDb().setPrTestsSkipped(String(prNumber), repo, false);
    await postPrComment(
      repo,
      prNumber,
      `✅ Tests re-enabled for PR #${prNumber}. Post \`/cc test:\` or \`/cx test:\` with your test list to run them now.`
    );
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

    console.log(`[github] Creating test thread "PR #${prNumber} — tests" in #${repoName}`);
    const thread = (await channel.threads.create({
      name: `PR #${prNumber} — tests`,
      autoArchiveDuration: 1440,
    })) as ThreadChannel;

    db.setPrTestThread(String(prNumber), repoName, thread.id);
    console.log(`[github] Test thread created: ${thread.id}`);
    return thread;
  }
}

// Extract the "/cc fix:\n- item" block from the test agent's output.
// Posted as its own comment so the webhook picks it up and triggers a fix run.
function extractFixBlock(text: string): string | null {
  const idx = text.search(/^\/cc fix:\n/m);
  if (idx === -1) return null;
  const block = text.slice(idx).trim();
  return block.split("\n").length > 1 ? block : null;
}

function buildTestPrompt(
  prNumber: number,
  previewUrl: string,
  prTitle: string,
  prBody: string,
  testItems: string[]
): string {
  const checklist = testItems.map((t, i) => `${i + 1}. ${t}`).join("\n");

  return `You are a QA agent for this project.
PR #${prNumber}: ${prTitle}
Preview URL: ${previewUrl}

Test plan:
${checklist}

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

If STATUS is FAIL, append a Test plan for the next run — list only the items that failed plus any new issues you discovered that are not in the original checklist:
Test plan:
- <item>

If STATUS is FAIL, end with a /cc fix: block listing each bug on its own line:
/cc fix:
- <bug description>`;
}

function buildFixPrompt(prNumber: number, bugItems: string[]): string {
  const list = bugItems.map((b) => `- ${b}`).join("\n");
  return `The QA test agent found these bugs in PR #${prNumber}:

${list}

Fix all of them. After fixing, commit the changes with a short message describing what was fixed. Do not push — CI handles that.`;
}

function buildPrTestSummary(agentKey: string, prNumber: number, text: string): string {
  const agent = agentKey === "cx" ? "Codex" : "Claude Code";
  const statusMatch = text.match(/STATUS:\s*(PASS|FAIL)/i);
  const status = statusMatch ? (statusMatch[1] ?? "UNKNOWN").toUpperCase() : "UNKNOWN";
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️";

  // Strip the /cc fix: block — it's posted as a separate trigger comment
  const summary = text.replace(/\n\/cc fix:\n[\s\S]*$/, "").trim();

  return `${icon} **${agent} test result — PR #${prNumber}**

${summary}`;
}

function buildPrFixSummary(prNumber: number, text: string): string {
  return `🔧 **Claude Code fix attempt — PR #${prNumber}**

${text.trim()}`;
}
