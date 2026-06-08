import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import { SessionManager } from "./session-manager.js";
import { CommandHandler } from "./commands.js";
import { parseAgentInvocations, starterMessageText, threadName, firstLine } from "./parser.js";
import { resolveThreadWorkDir } from "../utils/path-resolver.js";
import {
  ensureAttachmentDir,
  getTempPath,
  downloadAttachment,
  isImageType,
  buildPromptWithAttachments,
  cleanupOldAttachments,
  type DownloadedAttachment,
} from "../utils/attachments.js";
import type { MCPPermissionServer } from "../mcp/server.js";

export class DiscordBot {
  public client: Client;
  private commands: CommandHandler;
  private mcpServer?: MCPPermissionServer;

  constructor(
    private sessionManager: SessionManager,
    private allowedUserIds: string[],
    private baseFolder: string
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
      ],
    });
    this.commands = new CommandHandler(sessionManager, allowedUserIds, baseFolder);
    this.setupEvents();
  }

  setMCPServer(mcp: MCPPermissionServer): void {
    this.mcpServer = mcp;
    // setDiscordBot wires the bot into BOTH the server (used by ask_user_question)
    // and the permission manager (used by approve_tool). Calling the manager
    // directly would leave the server's own discordBot null, breaking questions.
    mcp.setDiscordBot(this);
  }

  async login(token: string): Promise<void> {
    await this.client.login(token);
  }

  private setupEvents(): void {
    this.client.once("ready", async () => {
      console.log(`Ready as ${this.client.user?.tag}`);
      await this.commands.registerCommands(
        process.env.DISCORD_TOKEN!,
        this.client.user!.id
      );
    });

    this.client.on("interactionCreate", (i) => this.commands.handleInteraction(i));

    this.client.on("messageCreate", async (msg) => {
      if (msg.author.bot) return;
      if (!this.allowedUserIds.includes(msg.author.id)) return;

      const isThread =
        msg.channel.type === ChannelType.PublicThread ||
        msg.channel.type === ChannelType.PrivateThread;

      if (isThread) {
        await this.handleThreadMessage(msg);
      } else {
        await this.handleChannelMessage(msg);
      }
    });

    // A deleted thread is gone for good — clean up its worktree (refusing if it
    // still holds uncommitted/unmerged work, which we then leave on disk).
    this.client.on("threadDelete", (thread) => {
      this.cleanupThread(thread.id, null, "deleted");
    });

    // A thread closing (archived) also triggers cleanup. Re-sending a message
    // un-archives it before anything is touched, so this only reaps idle threads.
    this.client.on("threadUpdate", (oldThread, newThread) => {
      if (!oldThread.archived && newThread.archived) {
        this.cleanupThread(newThread.id, newThread, "closed");
      }
    });

    this.client.on("messageReactionAdd", async (reaction, user) => {
      if ((user as any).bot) return;
      if (!this.allowedUserIds.includes((user as any).id)) return;
      if (!["✅", "❌"].includes(reaction.emoji.name ?? "")) return;
      if (this.mcpServer) {
        const approved = reaction.emoji.name === "✅";
        this.mcpServer
          .getPermissionManager()
          .handleApprovalReaction(
            reaction.message.channelId,
            reaction.message.id,
            (user as any).id,
            approved
          );
      }
    });
  }

  // Auto-cleanup a thread's worktree when it closes or is deleted. Never forces:
  // a worktree with unsaved/unmerged work is kept (and noted, if the thread is
  // still reachable) so nothing is silently lost — clear it later with /cleanup.
  private cleanupThread(threadId: string, thread: ThreadChannel | null, reason: string): void {
    const result = this.sessionManager.cleanupThreadWorktree(threadId);
    if (!result) return;
    if (result.removed) {
      console.log(`[cleanup] thread ${threadId} ${reason}: worktree removed`);
    } else {
      console.log(`[cleanup] thread ${threadId} ${reason}: kept (${result.reason})`);
      if (thread) {
        thread
          .send(
            `🌲 Worktree kept — it still has ${result.reason}, so it was not removed. Run \`/cleanup force:true\` to discard it.`
          )
          .catch(() => {});
      }
    }
  }

  private async handleChannelMessage(msg: Message): Promise<void> {
    const channel = msg.channel as TextChannel;
    const channelName = channel.name;

    const invocations = parseAgentInvocations(msg.content);
    if (invocations.length === 0) {
      await msg.reply("Mention an agent to start: `@cc`, `@codex`, etc.");
      return;
    }

    await msg.react("👀").catch(() => {});

    const attachments = await this.downloadMsgAttachments(msg);

    for (let i = 0; i < invocations.length; i++) {
      const { agent, prompt } = invocations[i];
      const fullPrompt = buildPromptWithAttachments(prompt, attachments);
      const tName = threadName(agent, prompt);

      // Single agent: thread from the user's own message (cleaner, no extra bot message).
      // Multiple agents: post a starter message per agent (Discord only allows one thread per message).
      let thread: ThreadChannel;
      if (invocations.length === 1) {
        thread = (await msg.startThread({
          name: tName,
          autoArchiveDuration: 1440,
        })) as ThreadChannel;
      } else {
        const starterMsg = await channel.send(starterMessageText(agent, prompt));
        thread = (await starterMsg.startThread({
          name: tName,
          autoArchiveDuration: 1440,
        })) as ThreadChannel;
      }

      const discordContext = {
        channelId: thread.id,
        channelName: tName,
        userId: msg.author.id,
        messageId: msg.id,
      };

      // Each thread runs in its own worktree on its own branch (off the repo's
      // default branch), so concurrent threads in this channel never conflict.
      // The branch/dir slug comes from the prompt's first line only (no agent
      // prefix), keeping names like `discord/fix-the-login-bug-456789`.
      const resolved =
        resolveThreadWorkDir(channelName, thread.id, firstLine(prompt), this.baseFolder) ??
        { workDir: this.baseFolder, repo: channelName };

      try {
        await this.sessionManager.runAgent(
          thread.id,
          channel.id,
          thread,
          agent,
          resolved.workDir,
          fullPrompt,
          discordContext,
          { branch: resolved.branch, isWorktree: !!resolved.worktree }
        );
      } catch (err: any) {
        await thread.send(`❌ Failed to start **${agent}**: ${err.message}`);
      }
    }
  }

  private async handleThreadMessage(msg: Message): Promise<void> {
    const thread = msg.channel as ThreadChannel;
    const session = this.sessionManager.getDb().getThreadSession(thread.id);

    if (!session) {
      await msg.reply("No session found for this thread.");
      return;
    }

    if (this.sessionManager.hasActiveProcess(thread.id)) {
      await msg.reply("Agent is still running. Use `/stop` to cancel.");
      return;
    }

    await msg.react("👀").catch(() => {});

    const attachments = await this.downloadMsgAttachments(msg);
    const fullPrompt = buildPromptWithAttachments(msg.content, attachments);

    const discordContext = {
      channelId: thread.id,
      channelName: thread.name,
      userId: msg.author.id,
      messageId: msg.id,
    };

    try {
      await this.sessionManager.runAgent(
        thread.id,
        session.channelId,
        thread,
        session.agent,
        session.workDir,
        fullPrompt,
        discordContext
      );
    } catch (err: any) {
      await msg.reply(`❌ Failed to resume **${session.agent}**: ${err.message}`);
    }
  }

  /**
   * Download all attachments on a Discord message to local temp files so the
   * agent can read them (e.g. images) by absolute path. Failures are logged
   * and skipped so a bad attachment never blocks the agent run.
   */
  private async downloadMsgAttachments(
    msg: Message
  ): Promise<DownloadedAttachment[]> {
    if (msg.attachments.size === 0) return [];

    ensureAttachmentDir();
    cleanupOldAttachments();

    const results: DownloadedAttachment[] = [];
    let index = 0;
    for (const att of msg.attachments.values()) {
      const name = att.name ?? "attachment";
      try {
        const tempPath = getTempPath(msg.channelId, name, index++);
        await downloadAttachment(att.url, tempPath);
        results.push({
          tempPath,
          originalName: name,
          contentType: att.contentType ?? undefined,
          isImage: isImageType(att.contentType ?? undefined, name),
        });
      } catch (err) {
        console.error(`Failed to download attachment ${name}:`, err);
      }
    }
    return results;
  }
}
