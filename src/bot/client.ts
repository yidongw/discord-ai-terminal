import * as fs from "fs";
import * as path from "path";
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type ButtonInteraction,
} from "discord.js";
import { SessionManager, type QueuedMessage } from "./session-manager.js";
import { CommandHandler } from "./commands.js";
import { parseAgentInvocations, starterMessageText, threadName, firstLine } from "./parser.js";
import { listAgentKeys, getAgent } from "../agents/index.js";
import { resolveThreadWorkDir } from "../utils/path-resolver.js";
import { generateThreadTitle } from "../utils/title-summarizer.js";
import { setThreadStatus, renamingClosedThreads } from "../utils/thread-status.js";
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
import type { GitHubHandler } from "../github/handler.js";
import type { ThreadSession } from "../db/database.js";

interface PendingInteraction extends QueuedMessage {}

export class DiscordBot {
  public client: Client;
  private commands: CommandHandler;
  private mcpServer?: MCPPermissionServer;
  private githubHandler?: GitHubHandler;
  // Keyed by original user message ID. Stores context for queue/interrupt/cancel
  // button choices shown when a message arrives while an agent is running.
  private pendingInteractions = new Map<string, PendingInteraction>();
  // Keyed by original user message ID. Stores the raw prompt when buttons were shown to pick an agent.
  private pendingAgentSelectInteractions = new Map<string, { msg: Message; channel: TextChannel; prompt: string }>();
  // Keyed by original user message ID. Stores context for branch-confirm buttons.
  private pendingBranchInteractions = new Map<
    string,
    { msg: Message; thread: ThreadChannel; session: { agent: string; workDir: string; branch?: string; channelId: string } }
  >();

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

  setGitHubHandler(handler: GitHubHandler): void {
    this.githubHandler = handler;
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

    this.client.on("interactionCreate", (i) => this.handleInteraction(i));

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

    // Monitor thread lifecycle transitions and reflect them in the thread name.
    //
    //   locked  → "done for now": KEEP the worktree + branch, just mark it 🔒.
    //   closed  → "done for good": archived, so clean up the worktree and mark 🗑️.
    //
    // Closing wins over locking when both flip at once. Re-sending a message
    // un-archives a thread before anything is touched, so the closed branch only
    // reaps genuinely idle threads.
    this.client.on("threadUpdate", (oldThread, newThread) => {
      // Ignore archive transitions we triggered ourselves while renaming a closed
      // thread (reopen → rename → re-archive). Without this, our own re-archive
      // would look like a fresh user close and re-run cleanup. Consume the guard
      // once the thread settles back into the archived state.
      if (renamingClosedThreads.has(newThread.id)) {
        if (newThread.archived) renamingClosedThreads.delete(newThread.id);
        return;
      }
      if (!oldThread.archived && newThread.archived) {
        this.cleanupThread(newThread.id, newThread, "closed");
      } else if (!oldThread.locked && newThread.locked) {
        // Locked but not (newly) closed: keep everything, just mark it. If the
        // thread is already archived, preserve that so the rename doesn't reopen it.
        void setThreadStatus(newThread, "locked", newThread.archived ? { archived: true } : undefined);
      } else if (oldThread.archived && !newThread.archived) {
        // Thread was reopened by the user: restore the working indicator.
        void setThreadStatus(newThread, "working");
      } else if (oldThread.locked && !newThread.locked) {
        // Thread was unlocked by the user: restore the working indicator.
        void setThreadStatus(newThread, "working");
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
  // On "closed" (auto-archive) we keep the session so the thread can be resumed
  // by sending a new message; on "deleted" we clean up fully.
  private cleanupThread(threadId: string, thread: ThreadChannel | null, reason: string): void {
    const keepSession = reason === "closed";
    const result = this.sessionManager.cleanupThreadWorktree(threadId, false, keepSession);
    // A deleted thread is gone — no rename is possible regardless of outcome.
    const archived = reason === "closed";

    if (!result) {
      // Nothing to clean (no managed worktree), but the thread still closed.
      if (archived && thread) void setThreadStatus(thread, "closed", { archived: true });
      return;
    }
    if (result.removed) {
      console.log(`[cleanup] thread ${threadId} ${reason}: worktree removed`);
      if (archived && thread) void setThreadStatus(thread, "closed", { archived: true });
    } else {
      console.log(`[cleanup] thread ${threadId} ${reason}: kept (${result.reason})`);
      if (thread) {
        // Worktree kept — present buttons so the user can force-close or cancel.
        // Don't change the thread status yet; that happens when a button is clicked.
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`worktree_force_close_${thread.id}`)
            .setLabel("Force Close")
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(`worktree_cancel_${thread.id}`)
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Secondary)
        );
        thread
          .send({
            content: `🌲 Worktree kept — it still has ${result.reason}, so it was not removed.`,
            components: [row],
          })
          .catch(() => {});
      }
    }
  }

  private async handleInteraction(interaction: any): Promise<void> {
    if (interaction.isButton?.()) {
      if (!this.allowedUserIds.includes(interaction.user.id)) {
        await interaction.reply({ content: "Not authorised.", ephemeral: true });
        return;
      }
      if (interaction.customId.startsWith("agent_select_")) {
        return this.handleAgentSelect(interaction as ButtonInteraction);
      }
      if (interaction.customId.startsWith("agent_cancel_")) {
        return this.handleAgentCancel(interaction as ButtonInteraction);
      }
      if (interaction.customId.startsWith("msg_queue_")) {
        return this.handleMsgQueue(interaction as ButtonInteraction);
      }
      if (interaction.customId.startsWith("msg_interrupt_")) {
        return this.handleMsgInterrupt(interaction as ButtonInteraction);
      }
      if (interaction.customId.startsWith("msg_cancel_")) {
        return this.handleMsgCancel(interaction as ButtonInteraction);
      }
      if (interaction.customId.startsWith("branch_confirm_")) {
        return this.handleBranchConfirm(interaction as ButtonInteraction);
      }
      if (interaction.customId.startsWith("branch_here_")) {
        return this.handleBranchHere(interaction as ButtonInteraction);
      }
    }

    if (interaction.isChatInputCommand?.() && interaction.commandName === "test") {
      if (!this.allowedUserIds.includes(interaction.user.id)) {
        await interaction.reply({ content: "Not authorised.", ephemeral: true });
        return;
      }
      if (!this.githubHandler) {
        await interaction.reply({ content: "GitHub integration is not enabled.", ephemeral: true });
        return;
      }
      const channel = interaction.channel;
      if (!channel?.isThread?.()) {
        await interaction.reply({ content: "Use `/test` inside the PR maker thread.", ephemeral: true });
        return;
      }
      const prLink = this.sessionManager.getDb().findPrForMakerThread(channel.id);
      if (!prLink) {
        await interaction.reply({ content: "This thread is not linked to a PR.", ephemeral: true });
        return;
      }
      await interaction.reply({ content: "🧪 Building test plan…" });
      try {
        await this.githubHandler.handleTestCommand(prLink.repo, Number(prLink.prNumber), channel);
      } catch (err: any) {
        await channel.send(`❌ Failed to run test: ${err.message}`);
      }
      return;
    }
    await this.commands.handleInteraction(interaction);
  }

  private async handleChannelMessage(msg: Message): Promise<void> {
    const channel = msg.channel as TextChannel;
    const channelName = channel.name;

    const invocations = parseAgentInvocations(msg.content);
    if (invocations.length === 0) {
      const agentButtons = listAgentKeys().map((key) => {
        const agent = getAgent(key)!;
        return new ButtonBuilder()
          .setCustomId(`agent_select_${key}_${msg.id}`)
          .setLabel(`@${key} — ${agent.label}`)
          .setStyle(ButtonStyle.Primary);
      });
      const cancelButton = new ButtonBuilder()
        .setCustomId(`agent_cancel_${msg.id}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary);
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...agentButtons, cancelButton);
      this.pendingAgentSelectInteractions.set(msg.id, { msg, channel, prompt: msg.content });
      await msg.reply({ content: "Mention an agent to start:", components: [row] });
      return;
    }

    await msg.react("👀").catch(() => {});

    const attachments = await this.downloadMsgAttachments(msg);

    for (let i = 0; i < invocations.length; i++) {
      const { agent, prompt } = invocations[i]!;
      const fullPrompt = buildPromptWithAttachments(prompt, attachments);

      // Ask the same agent CLI for a concise title; fall back to first line.
      const titleLabel = await generateThreadTitle(agent, prompt).catch(
        () => firstLine(prompt)
      );
      const tName = threadName(agent, titleLabel);

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
      // The branch/dir slug comes from the AI-generated title (no agent prefix),
      // keeping names like `discord/fix-login-password-reset-456789`.
      const resolved =
        resolveThreadWorkDir(channelName, thread.id, titleLabel, this.baseFolder) ??
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

    // /test command: run manual test flow for the PR linked to this maker thread
    if (msg.content.trim() === "/test" && this.githubHandler) {
      const prLink = this.sessionManager.getDb().findPrForMakerThread(thread.id);
      if (prLink) {
        await msg.react("🧪").catch(() => {});
        try {
          await this.githubHandler.handleTestCommand(prLink.repo, Number(prLink.prNumber), thread);
        } catch (err: any) {
          await thread.send(`❌ Failed to run test: ${err.message}`);
        }
        return;
      }
    }

    const session = this.sessionManager.getDb().getThreadSession(thread.id);

    if (!session) {
      await msg.reply("No session found for this thread.");
      return;
    }

<<<<<<< HEAD
    // Record this message as seen so restart recovery picks up only newer ones.
    this.sessionManager.getDb().updateLastSeenMessageId(thread.id, msg.id);

=======
>>>>>>> 9873b80 (feat: confirm before branching and preserve original message text)
    // If the message mentions an agent, ask whether to branch into a new sibling
    // thread or just send the message to the current thread's agent.
    const invocations = parseAgentInvocations(msg.content);
    if (invocations.length > 0) {
      this.pendingBranchInteractions.set(msg.id, { msg, thread, session });
      const agentList = invocations.map((i) => `**${i.agent}**`).join(", ");
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`branch_confirm_${msg.id}`)
          .setLabel("Branch off → new thread")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`branch_here_${msg.id}`)
          .setLabel("Send to this thread")
          .setStyle(ButtonStyle.Secondary)
      );
      await msg.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🌿 Branch or continue here?")
            .setDescription(
              `You mentioned ${agentList}. Do you want to spin up a new thread branched off this one, or just send this message to the current agent?`
            )
            .setColor(0x5865f2),
        ],
        components: [row],
      });
      return;
    }

    if (this.sessionManager.hasActiveProcess(thread.id)) {
      // Download attachments now so we have the full prompt ready for queue/interrupt.
      const attachments = await this.downloadMsgAttachments(msg);
      const fullPrompt = buildPromptWithAttachments(msg.content, attachments);
      const discordContext = {
        channelId: thread.id,
        channelName: thread.name,
        userId: msg.author.id,
        messageId: msg.id,
      };

      this.pendingInteractions.set(msg.id, {
        prompt: fullPrompt,
        originalText: msg.content,
        discordContext,
        agentKey: session.agent,
        workDir: session.workDir,
        channelId: session.channelId,
        thread,
      });

      const queueLen = this.sessionManager.getQueueLength(thread.id);
      const queueNote = queueLen > 0
        ? `\n${queueLen} message${queueLen === 1 ? "" : "s"} already queued.`
        : "";
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`msg_queue_${msg.id}`)
          .setLabel("Queue")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(`msg_interrupt_${msg.id}`)
          .setLabel("Interrupt")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`msg_cancel_${msg.id}`)
          .setLabel("Cancel")
          .setStyle(ButtonStyle.Secondary)
      );
      await msg.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("⏸️ Agent is still running")
            .setDescription(`What would you like to do with your message?${queueNote}`)
            .setColor(0xffa500),
        ],
        components: [row],
      });
      return;
    }

    // If the worktree was removed when the thread was archived, re-create it so
    // the agent resumes in the same path with the same branch (or a fresh one off
    // the default branch if the old branch was already merged and deleted).
    if (session.isWorktree && !fs.existsSync(session.workDir)) {
      const channelName = thread.parent?.name;
      if (channelName) {
        // Recover the original label slug from the stored workDir basename,
        // e.g. "fix-auth-bug-a1b2c3" → "fix-auth-bug". resolveThreadWorkDir
        // will re-derive the same branch/dir names from that slug + thread id.
        const label = path.basename(session.workDir).replace(/-[a-z0-9]{6}$/i, "");
        resolveThreadWorkDir(channelName, thread.id, label, this.baseFolder);
      }
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

  // When the user @-mentions an agent inside an existing thread, open a new
  // sibling thread in the parent text channel and base its worktree on the
  // current thread's branch so it inherits any in-progress work.
  private async handleChildThreadSpawn(
    msg: Message,
    parentThread: ThreadChannel,
    parentSession: { agent: string; workDir: string; branch?: string; channelId: string }
  ): Promise<void> {
    const parentChannel = parentThread.parent as TextChannel | null;
    if (!parentChannel) {
      await msg.reply("Cannot spawn a new thread: parent channel not found.");
      return;
    }

    await msg.react("👀").catch(() => {});

    const attachments = await this.downloadMsgAttachments(msg);
    const invocations = parseAgentInvocations(msg.content);

    for (let i = 0; i < invocations.length; i++) {
      const { agent, prompt } = invocations[i]!;
      const fullPrompt = buildPromptWithAttachments(prompt, attachments);

      const titleLabel = await generateThreadTitle(agent, prompt).catch(
        () => firstLine(prompt)
      );
      const tName = threadName(agent, titleLabel);

      // Always post a starter message to the parent text channel and thread from
      // it — messages in threads can't reliably spawn sub-threads in Discord.
      // Preserve the original message text; only prefix with the branch icon.
      const starterMsg = await parentChannel.send(`🌲 ${msg.content}`);
      const childThread = (await starterMsg.startThread({
        name: tName,
        autoArchiveDuration: 1440,
      })) as ThreadChannel;

      // Add the user to the new thread and notify them in the originating thread.
      await childThread.members.add(msg.author.id).catch(() => {});
      await msg.reply(`<@${msg.author.id}> branched → ${childThread.toString()}`).catch(() => {});

      const discordContext = {
        channelId: childThread.id,
        channelName: tName,
        userId: msg.author.id,
        messageId: msg.id,
      };

      const channelName = parentChannel.name;
      // Branch the new worktree off the parent thread's branch so it starts
      // from the same state instead of the repo's default branch.
      const resolved =
        resolveThreadWorkDir(channelName, childThread.id, titleLabel, this.baseFolder, parentSession.branch) ??
        { workDir: this.baseFolder, repo: channelName };

      try {
        await this.sessionManager.runAgent(
          childThread.id,
          parentChannel.id,
          childThread,
          agent,
          resolved.workDir,
          fullPrompt,
          discordContext,
          { branch: (resolved as any).branch, isWorktree: !!(resolved as any).worktree }
        );
      } catch (err: any) {
        await childThread.send(`❌ Failed to start **${agent}**: ${err.message}`);
      }
    }
  }

  private async handleBranchConfirm(interaction: ButtonInteraction): Promise<void> {
    const msgId = interaction.customId.replace("branch_confirm_", "");
    const pending = this.pendingBranchInteractions.get(msgId);
    if (!pending) {
      await interaction.update({ embeds: [new EmbedBuilder().setDescription("⚠️ Context expired.").setColor(0x99aab5)], components: [] });
      return;
    }
    this.pendingBranchInteractions.delete(msgId);
    await interaction.update({ embeds: [new EmbedBuilder().setDescription("🌿 Branching off…").setColor(0x5865f2)], components: [] });
    await this.handleChildThreadSpawn(pending.msg, pending.thread, pending.session);
  }

  private async handleBranchHere(interaction: ButtonInteraction): Promise<void> {
    const msgId = interaction.customId.replace("branch_here_", "");
    const pending = this.pendingBranchInteractions.get(msgId);
    if (!pending) {
      await interaction.update({ embeds: [new EmbedBuilder().setDescription("⚠️ Context expired.").setColor(0x99aab5)], components: [] });
      return;
    }
    this.pendingBranchInteractions.delete(msgId);
    await interaction.update({ embeds: [new EmbedBuilder().setDescription("✉️ Sending to this thread…").setColor(0x57f287)], components: [] });

    const { msg, thread, session } = pending;
    await msg.react("👀").catch(() => {});
    const attachments = await this.downloadMsgAttachments(msg);
    const fullPrompt = buildPromptWithAttachments(msg.content, attachments);
    const discordContext = { channelId: thread.id, channelName: thread.name, userId: msg.author.id, messageId: msg.id };
    try {
      await this.sessionManager.runAgent(thread.id, session.channelId, thread, session.agent, session.workDir, fullPrompt, discordContext);
    } catch (err: any) {
      await msg.reply(`❌ Failed to resume **${session.agent}**: ${err.message}`);
    }
  }

<<<<<<< HEAD
  private async handleAgentSelect(interaction: ButtonInteraction): Promise<void> {
    // customId: agent_select_{agentKey}_{msgId}
    const withoutPrefix = interaction.customId.replace("agent_select_", "");
    const underscoreIdx = withoutPrefix.indexOf("_");
    const agentKey = withoutPrefix.slice(0, underscoreIdx);
    const msgId = withoutPrefix.slice(underscoreIdx + 1);

    const pending = this.pendingAgentSelectInteractions.get(msgId);
    if (!pending) {
      await interaction.update({ content: "⚠️ Context expired.", components: [] });
      return;
    }
    this.pendingAgentSelectInteractions.delete(msgId);
    await interaction.update({ content: `✅ Starting **@${agentKey}**…`, components: [] });

    const { msg, channel, prompt } = pending;
    const channelName = channel.name;
    const attachments = await this.downloadMsgAttachments(msg);
    const fullPrompt = buildPromptWithAttachments(prompt, attachments);

    const titleLabel = await generateThreadTitle(agentKey, fullPrompt).catch(() => firstLine(fullPrompt));
    const tName = threadName(agentKey, titleLabel);
    const thread = (await msg.startThread({ name: tName, autoArchiveDuration: 1440 })) as ThreadChannel;

    const discordContext = { channelId: thread.id, channelName: tName, userId: msg.author.id, messageId: msg.id };
    const resolved =
      resolveThreadWorkDir(channelName, thread.id, titleLabel, this.baseFolder) ??
      { workDir: this.baseFolder, repo: channelName };

    try {
      await this.sessionManager.runAgent(
        thread.id, channel.id, thread, agentKey, resolved.workDir, fullPrompt, discordContext,
        { branch: (resolved as any).branch, isWorktree: !!(resolved as any).worktree }
      );
    } catch (err: any) {
      await thread.send(`❌ Failed to start **${agentKey}**: ${err.message}`);
    }
  }

  private async handleAgentCancel(interaction: ButtonInteraction): Promise<void> {
    const msgId = interaction.customId.replace("agent_cancel_", "");
    this.pendingAgentSelectInteractions.delete(msgId);
    await interaction.update({ content: "❌ Cancelled.", components: [] });
  }

=======
>>>>>>> 9873b80 (feat: confirm before branching and preserve original message text)
  private async handleMsgQueue(interaction: ButtonInteraction): Promise<void> {
    const msgId = interaction.customId.replace("msg_queue_", "");
    const pending = this.pendingInteractions.get(msgId);
    if (!pending) {
      await interaction.update({
        embeds: [new EmbedBuilder().setDescription("⚠️ Message context expired.").setColor(0x99aab5)],
        components: [],
      });
      return;
    }

    this.sessionManager.enqueueMessage(pending.thread.id, pending);
    this.pendingInteractions.delete(msgId);

    const queueLen = this.sessionManager.getQueueLength(pending.thread.id);
    const preview = pending.originalText.length > 300
      ? pending.originalText.slice(0, 300) + "…"
      : pending.originalText;
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle(`✅ Queued — position ${queueLen}`)
          .setDescription(preview)
          .setColor(0x5865f2),
      ],
      components: [],
    });
  }

  private async handleMsgInterrupt(interaction: ButtonInteraction): Promise<void> {
    const msgId = interaction.customId.replace("msg_interrupt_", "");
    const pending = this.pendingInteractions.get(msgId);
    if (!pending) {
      await interaction.update({
        embeds: [new EmbedBuilder().setDescription("⚠️ Message context expired.").setColor(0x99aab5)],
        components: [],
      });
      return;
    }

    this.pendingInteractions.delete(msgId);
    const preview = pending.originalText.length > 300
      ? pending.originalText.slice(0, 300) + "…"
      : pending.originalText;
    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚡ Interrupting")
          .setDescription(preview)
          .setColor(0xff6b35),
      ],
      components: [],
    });

    try {
      await this.sessionManager.runAgent(
        pending.thread.id,
        pending.channelId,
        pending.thread,
        pending.agentKey,
        pending.workDir,
        pending.prompt,
        pending.discordContext
      );
    } catch (err: any) {
      await pending.thread.send(`❌ Failed to resume **${pending.agentKey}**: ${err.message}`);
    }
  }

  private async handleMsgCancel(interaction: ButtonInteraction): Promise<void> {
    const msgId = interaction.customId.replace("msg_cancel_", "");
    this.pendingInteractions.delete(msgId);
    await interaction.update({
      embeds: [new EmbedBuilder().setDescription("❌ Cancelled.").setColor(0x99aab5)],
      components: [],
    });
  }

  /**
   * After a restart, fetch and replay any user messages that arrived in known
   * threads while the bot was offline. Threads with no lastSeenMessageId (e.g.
   * created before this feature) are skipped — recovery kicks in on the next
   * restart after the first message is recorded.
   */
  async recoverMissedMessages(): Promise<void> {
    const sessions = this.sessionManager.getDb().getAllThreadSessions();
    for (const session of sessions) {
      if (!session.lastSeenMessageId) continue;
      try {
        await this.recoverThreadMessages(session);
      } catch (err) {
        console.error(`[recover] failed for thread ${session.threadId}:`, err);
      }
    }
  }

  private async recoverThreadMessages(session: ThreadSession): Promise<void> {
    let thread: ThreadChannel;
    try {
      const ch = await this.client.channels.fetch(session.threadId);
      if (!ch) return;
      const isThread =
        ch.type === ChannelType.PublicThread || ch.type === ChannelType.PrivateThread;
      if (!isThread) return;
      thread = ch as ThreadChannel;
    } catch (err: any) {
      if (err?.code === 10003) return; // Unknown Channel — deleted
      throw err;
    }

    const fetched = await thread.messages.fetch({
      after: session.lastSeenMessageId,
      limit: 100,
    });

    const ordered = [...fetched.values()]
      .filter((m) => !m.author.bot && this.allowedUserIds.includes(m.author.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1));

    if (ordered.length === 0) return;

    console.log(`[recover] ${ordered.length} missed message(s) in thread ${session.threadId}`);

    // Mark all as seen up front so a crash during processing doesn't re-fetch.
    const lastMsg = ordered[ordered.length - 1]!;
    this.sessionManager.getDb().updateLastSeenMessageId(session.threadId, lastMsg.id);

    // Re-create the worktree path if it was cleaned up while the thread was archived.
    if (session.isWorktree && !fs.existsSync(session.workDir)) {
      const channelName = thread.parent?.name;
      if (channelName) {
        const label = path.basename(session.workDir).replace(/-[a-z0-9]{6}$/i, "");
        resolveThreadWorkDir(channelName, thread.id, label, this.baseFolder);
      }
    }

    for (const msg of ordered) {
      const attachments = await this.downloadMsgAttachments(msg);
      const fullPrompt = buildPromptWithAttachments(msg.content, attachments);
      this.sessionManager.enqueueMessage(session.threadId, {
        prompt: fullPrompt,
        originalText: msg.content,
        discordContext: {
          channelId: session.threadId,
          channelName: thread.name,
          userId: msg.author.id,
          messageId: msg.id,
        },
        agentKey: session.agent,
        workDir: session.workDir,
        channelId: session.channelId,
        thread,
      });
    }

    // If no active run is streaming, kick off the first queued message now.
    // Threads with a re-attached run will drain the queue when the run finishes.
    if (!this.sessionManager.hasActiveProcess(session.threadId)) {
      const queued = this.sessionManager.dequeueMessage(session.threadId);
      if (!queued) return;

      const count = ordered.length;
      const preview =
        queued.originalText.length > 200
          ? queued.originalText.slice(0, 200) + "…"
          : queued.originalText;
      await thread.send(
        `📋 **Recovering ${count} missed message${count > 1 ? "s" : ""} from downtime:**\n>>> ${preview}`
      );

      try {
        await this.sessionManager.runAgent(
          session.threadId,
          session.channelId,
          thread,
          session.agent,
          session.workDir,
          queued.prompt,
          queued.discordContext
        );
      } catch (err: any) {
        await thread.send(`❌ Failed to resume **${session.agent}**: ${err.message}`);
      }
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
