import {
  ChannelType,
  type Client,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { SessionManager } from "../bot/session-manager.js";
import { postPrComment, getPr } from "./pr-comment.js";
import { repoPathFor } from "../utils/path-resolver.js";

export class GitHubHandler {
  constructor(
    private client: Client,
    private sessionManager: SessionManager,
    private baseFolder: string
  ) {}

  // Called when pull_request.opened fires. Links the PR to the Discord thread
  // that was most recently running CC for this repo (Thread A).
  async handlePrOpened(repo: string, prNumber: number): Promise<void> {
    const repoName = repo.split("/")[1] ?? repo;
    const makerThreadId = this.sessionManager.getDb().findMakerThreadForRepo(repoName);
    if (!makerThreadId) {
      console.log(`[github] PR #${prNumber}: no maker thread found for ${repoName}`);
      return;
    }
    this.sessionManager.getDb().setPrMakerThread(String(prNumber), repo, makerThreadId);
    console.log(`[github] PR #${prNumber} linked to maker thread ${makerThreadId}`);
  }

  // Called when issue_comment.created fires with a /cc or /cx command.
  async handleComment(
    repo: string,
    prNumber: number,
    previewUrl: string,
    command: string, // "cc" or "cx"
    fixBody?: string // set when command is "cc" and body starts with "/cc fix:"
  ): Promise<void> {
    const repoName = repo.split("/")[1] ?? repo;
    const isFix = command === "cc" && !!fixBody;

    if (isFix) {
      await this.runFix(repo, repoName, prNumber, fixBody!);
    } else {
      await this.runTest(repo, repoName, prNumber, previewUrl, command);
    }
  }

  private async runTest(
    repo: string,
    repoName: string,
    prNumber: number,
    previewUrl: string,
    agentKey: string
  ): Promise<void> {
    const pr = await getPr(repo, prNumber);
    const prTitle = pr?.title ?? `PR #${prNumber}`;
    const prBody = pr?.body ?? "";

    const thread = await this.getOrCreateTestThread(repoName, prNumber);
    if (!thread) {
      console.error(`[github] Could not find/create test thread for PR #${prNumber}`);
      return;
    }

    const prompt = buildTestPrompt(prNumber, previewUrl, prTitle, prBody);

    await this.sessionManager.runAgent(
      thread.id,
      thread.parentId ?? thread.id,
      thread,
      agentKey,
      repoPathFor(repoName, this.baseFolder) ?? this.baseFolder,
      prompt,
      undefined,
      {
        onDone: async (text) => {
          const summary = buildPrTestSummary(agentKey, prNumber, text);
          await postPrComment(repo, prNumber, summary);
        },
      }
    );
  }

  private async runFix(
    repo: string,
    repoName: string,
    prNumber: number,
    bugReport: string
  ): Promise<void> {
    const makerThreadId = this.sessionManager.getDb().getPrThreads(String(prNumber), repo)?.makerThreadId;

    let thread: ThreadChannel | null = null;
    if (makerThreadId) {
      thread = (await this.client.channels.fetch(makerThreadId).catch(() => null)) as ThreadChannel | null;
    }

    // Fall back to the test thread if maker thread is gone
    if (!thread) {
      thread = await this.getOrCreateTestThread(repoName, prNumber);
    }

    if (!thread) {
      console.error(`[github] Could not find any thread for PR #${prNumber} fix`);
      return;
    }

    const workDir = this.sessionManager.getDb().getThreadSession(makerThreadId ?? "")?.workDir
      ?? repoPathFor(repoName, this.baseFolder)
      ?? this.baseFolder;

    const prompt = buildFixPrompt(prNumber, bugReport);

    await this.sessionManager.runAgent(
      thread.id,
      thread.parentId ?? thread.id,
      thread,
      "cc",
      workDir,
      prompt,
      undefined,
      {
        prNumber,
        onDone: async (text) => {
          const summary = buildPrFixSummary(prNumber, text);
          await postPrComment(repo, prNumber, summary);
        },
      }
    );
  }

  private async getOrCreateTestThread(repoName: string, prNumber: number): Promise<ThreadChannel | null> {
    const db = this.sessionManager.getDb();
    const existing = db.getPrThreads(String(prNumber), repoName);

    // Try a cached test thread ID first
    if (existing?.testThreadId) {
      const cached = await this.client.channels.fetch(existing.testThreadId).catch(() => null);
      if (cached?.isThread()) return cached as ThreadChannel;
    }

    // Fetch the guild freshly if not cached (bot may have just started)
    let guild = this.client.guilds.cache.first();
    if (!guild) {
      console.error("[github] No guild in cache — bot not ready?");
      return null;
    }

    // Ensure channels are fetched (cache may be stale on first use)
    if (guild.channels.cache.size === 0) {
      await guild.channels.fetch();
    }

    const channel = guild.channels.cache.find(
      (c) => c.name === repoName && c.type === ChannelType.GuildText
    ) as TextChannel | undefined;

    if (!channel) {
      console.error(`[github] No Discord channel named "${repoName}" (searched ${guild.channels.cache.size} channels)`);
      return null;
    }

    console.log(`[github] Creating test thread "PR #${prNumber} — tests" in #${repoName}`);
    const thread = await channel.threads.create({
      name: `PR #${prNumber} — tests`,
      autoArchiveDuration: 1440,
    }) as ThreadChannel;

    db.setPrTestThread(String(prNumber), repoName, thread.id);
    console.log(`[github] Test thread created: ${thread.id}`);
    return thread;
  }
}

function buildTestPrompt(prNumber: number, previewUrl: string, prTitle: string, prBody: string): string {
  return `You are a QA agent for this project.
PR #${prNumber}: ${prTitle}
Preview URL: ${previewUrl}

Use the verify checklist from the PR description to guide your testing:
${prBody || "(no description provided)"}

Use agent-browser to test the preview:
  agent-browser open <url>
  agent-browser snapshot -i
  agent-browser click @eN / agent-browser fill @eN "text"
  agent-browser screenshot --path /tmp/pr-${prNumber}-N.png

Report your findings in this format:
STATUS: PASS or FAIL
FINDINGS:
- each checklist item — result and details

If STATUS is FAIL, your final line must be exactly:
/cc fix: <clear bug descriptions with reproduction steps>`;
}

function buildFixPrompt(prNumber: number, bugReport: string): string {
  return `The QA test agent found these bugs in PR #${prNumber}:

${bugReport}

Fix all of them. After fixing, commit the changes with a short message describing what was fixed. Do not push — CI handles that.`;
}

function buildPrTestSummary(agentKey: string, prNumber: number, text: string): string {
  const agent = agentKey === "cx" ? "Codex" : "Claude Code";
  const statusMatch = text.match(/STATUS:\s*(PASS|FAIL)/i);
  const status = statusMatch ? (statusMatch[1] ?? "UNKNOWN").toUpperCase() : "UNKNOWN";
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️";

  return `${icon} **${agent} test result — PR #${prNumber}**

${text.trim()}`;
}

function buildPrFixSummary(prNumber: number, text: string): string {
  return `🔧 **Claude Code fix attempt — PR #${prNumber}**

${text.trim()}`;
}
