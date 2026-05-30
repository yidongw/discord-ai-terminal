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
import { parseAgentInvocations, starterMessageText, threadName } from "./parser.js";
import { resolveWorkDir } from "../utils/path-resolver.js";
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
    mcp.getPermissionManager().setDiscordBot(this);
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

  private async handleChannelMessage(msg: Message): Promise<void> {
    const channel = msg.channel as TextChannel;
    const channelName = channel.name;
    const resolved = resolveWorkDir(channelName, this.baseFolder) ?? { workDir: this.baseFolder, repo: channelName };

    const invocations = parseAgentInvocations(msg.content);
    if (invocations.length === 0) {
      await msg.reply("Mention an agent to start: `@cc`, `@codex`, etc.");
      return;
    }

    await msg.react("👀").catch(() => {});

    for (let i = 0; i < invocations.length; i++) {
      const { agent, prompt } = invocations[i];
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

      try {
        await this.sessionManager.runAgent(
          thread.id,
          channel.id,
          thread,
          agent,
          resolved.workDir,
          prompt,
          discordContext
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
        msg.content,
        discordContext
      );
    } catch (err: any) {
      await msg.reply(`❌ Failed to resume **${session.agent}**: ${err.message}`);
    }
  }
}
