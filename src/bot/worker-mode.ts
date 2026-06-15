import { spawnSync } from "child_process";
import { REST, Routes } from "discord.js";
import { SessionManager } from "./session-manager.js";
import { DatabaseManager } from "../db/database.js";
import type { DiscordContext } from "../utils/shell.js";

// REST-based Discord message — matches the subset of discord.js Message that
// session-manager reads back when editing tool-call embeds.
class RestMessage {
  embeds: { data: { description: string } }[];

  constructor(
    public id: string,
    description: string,
    private rest: REST,
    private threadId: string
  ) {
    this.embeds = [{ data: { description } }];
  }

  async edit(data: any): Promise<this> {
    try {
      await this.rest.patch(Routes.channelMessage(this.threadId, this.id), {
        body: serializeBody(data),
      });
      const desc = firstEmbedDescription(data);
      if (desc !== undefined) this.embeds = [{ data: { description: desc } }];
    } catch (err) {
      console.error("[worker] edit failed:", err);
    }
    return this;
  }
}

// REST-only stand-in for discord.js ThreadChannel. Implements the subset of the
// ThreadChannel API that session-manager and thread-status utilities call.
class RestThread {
  archived: boolean = false;

  constructor(
    public id: string,
    public parentId: string,
    public name: string,
    private rest: REST
  ) {}

  async send(data: any): Promise<RestMessage> {
    try {
      const response = (await this.rest.post(Routes.channelMessages(this.id), {
        body: serializeBody(data),
      })) as any;
      const desc = response.embeds?.[0]?.description ?? "";
      return new RestMessage(response.id, desc, this.rest, this.id);
    } catch (err) {
      console.error("[worker] send failed:", err);
      return new RestMessage("0", "", this.rest, this.id);
    }
  }

  async sendTyping(): Promise<void> {
    await this.rest.post(Routes.channelTyping(this.id)).catch(() => {});
  }

  async setName(name: string): Promise<void> {
    this.name = name;
    await this.rest.patch(Routes.channel(this.id), { body: { name } }).catch(() => {});
  }

  async edit(opts: any): Promise<void> {
    if (opts.name) this.name = opts.name;
    if (opts.archived !== undefined) this.archived = opts.archived;
    await this.rest.patch(Routes.channel(this.id), { body: opts }).catch(() => {});
  }

  toString(): string {
    return `<#${this.id}>`;
  }
}

// Recursively serialize an object that may contain discord.js builder instances
// (EmbedBuilder, etc.) by calling .toJSON() where available.
function serializeBody(data: any): any {
  if (!data || typeof data !== "object") return data;
  if (typeof (data as any).toJSON === "function") return (data as any).toJSON();
  if (Array.isArray(data)) {
    return data.map((item: any) =>
      item && typeof item.toJSON === "function" ? item.toJSON() : serializeBody(item)
    );
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      out[k] = v.map((item: any) =>
        item && typeof item.toJSON === "function" ? item.toJSON() : serializeBody(item)
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Extract the description string from the first embed in a message body,
// whether the embed is a plain API object or an EmbedBuilder instance.
function firstEmbedDescription(data: any): string | undefined {
  const embed = data?.embeds?.[0];
  if (!embed) return undefined;
  if (typeof embed.description === "string") return embed.description;
  if (typeof embed.data?.description === "string") return embed.data.description;
  return undefined;
}

// After the agent run, check if it pushed a branch with an open PR and write
// the PR→thread link into the MAIN BOT's sessions.db so that CI failure
// webhooks can find this worker thread and dispatch the fix prompt.
function linkOpenPrToMainDb(threadId: string, workDir: string, mainDbPath: string): void {
  const branchResult = spawnSync(
    "git", ["-C", workDir, "rev-parse", "--abbrev-ref", "HEAD"],
    { encoding: "utf8" }
  );
  const branch = branchResult.stdout.trim();
  if (!branch || branch === "HEAD") return; // detached HEAD — nothing to link

  const remoteResult = spawnSync(
    "git", ["-C", workDir, "remote", "get-url", "origin"],
    { encoding: "utf8", timeout: 5000 }
  );
  if (remoteResult.status !== 0 || !remoteResult.stdout.trim()) return;

  const repoMatch = remoteResult.stdout.trim().match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!repoMatch) return;
  const repo = repoMatch[1]!;

  const prResult = spawnSync(
    "gh", ["pr", "list", "--head", branch, "--json", "number", "--repo", repo],
    { encoding: "utf8", timeout: 10000 }
  );
  if (prResult.status !== 0 || !prResult.stdout.trim()) return;

  let prs: Array<{ number: number }>;
  try { prs = JSON.parse(prResult.stdout); } catch { return; }
  if (prs.length === 0) return;

  const prNumber = prs[0]!.number;
  try {
    const mainDb = new DatabaseManager(mainDbPath);
    mainDb.setPrMakerThread(String(prNumber), repo, threadId);
    console.log(`[worker] linked PR #${prNumber} (${repo}) → thread ${threadId} in main DB`);
  } catch (err) {
    console.error("[worker] failed to link PR in main DB:", err);
  }
}

export interface WorkerMessage {
  prompt: string;
  agentKey: string;
  discordContext: DiscordContext;
}

export async function runWorkerMode(): Promise<void> {
  const threadId = process.env.DISCORD_AI_TERMINAL_THREAD_ID!;
  const channelId = process.env.DISCORD_AI_TERMINAL_CHANNEL_ID!;
  const token = process.env.DISCORD_TOKEN!;
  const mainDbPath = process.env.WORKER_MAIN_DB_PATH;

  // Read the message JSON written to stdin by the main bot.
  let stdinData = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) stdinData += chunk;

  let message: WorkerMessage;
  try {
    message = JSON.parse(stdinData.trim());
  } catch {
    console.error("[worker] invalid stdin JSON:", stdinData.slice(0, 200));
    process.exit(1);
  }

  const { prompt, agentKey, discordContext } = message;

  const rest = new REST({ version: "10" }).setToken(token);

  // Fetch the thread name for the mock object so status renames are accurate.
  let threadName = `bot-${threadId.slice(-6)}`;
  try {
    const ch = (await rest.get(Routes.channel(threadId))) as any;
    if (ch?.name) threadName = ch.name;
  } catch {}

  const thread = new RestThread(threadId, channelId, threadName, rest);

  // SessionManager uses process.cwd() for sessions.db and runs/.
  // We run with cwd = the worktree, so each thread gets its own isolated DB.
  const sessionManager = new SessionManager();

  // Wire up the gh wrapper so agents in this worker also link PRs to the thread.
  // Port and secret are inherited from the main bot's environment.
  const linkerPortStr = process.env.GITHUB_PR_LINKER_PORT;
  const linkerSecret =
    process.env.GITHUB_PR_LINKER_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET;
  if (linkerPortStr && linkerSecret) {
    sessionManager.setGhLinkerConfig(parseInt(linkerPortStr), linkerSecret);
  }

  // Mirror active_run mutations into the main bot's DB so the main bot can
  // re-attach to this worker's detached agent after a service restart. The
  // worker process is a child of the main bot and gets killed on restart, but
  // the agent it spawns is detached and keeps running — the main bot needs to
  // find it in its own active_runs table.
  if (mainDbPath) {
    const mainDb = new DatabaseManager(mainDbPath);
    sessionManager.getDb().setMirrorDb(mainDb);
  }

  await sessionManager.runAgent(
    threadId,
    channelId,
    thread,
    agentKey,
    process.cwd(),
    prompt,
    discordContext
  );

  // Keep the event loop alive until the agent is done and all Discord sends land.
  await sessionManager.waitForIdle(threadId);

  // If the agent pushed a branch with an open PR, register the PR→thread link
  // in the main bot's DB so CI failure webhooks can route back to this thread.
  if (mainDbPath) {
    linkOpenPrToMainDb(threadId, process.cwd(), mainDbPath);
  }
}
