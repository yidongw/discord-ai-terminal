import * as path from "path";
import {
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ChannelType,
  type Interaction,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ThreadChannel,
} from "discord.js";
import { SessionManager } from "./session-manager.js";
import { DEFAULT_HIDDEN_TOOLS, KNOWN_TOOLS, toolIsHidden } from "../db/database.js";
import { setThreadStatus } from "../utils/thread-status.js";
import type { PermissionMode, CcModel, CodexModel, CsModel } from "../db/database.js";
import {
  CC_MODEL_CHOICES, CODEX_MODEL_CHOICES, CS_MODEL_CHOICES,
  CC_MODEL_ALIASES, CODEX_MODEL_ALIASES, CS_MODEL_ALIASES,
  DEFAULT_CC_MODEL, DEFAULT_CODEX_MODEL, DEFAULT_CS_MODEL,
  getChannelModelForAgent,
} from "../utils/models.js";
import { getAgent, listAgentKeys } from "../agents/index.js";
import { mainRepoOf, worktreeCloseBlockReason } from "../utils/path-resolver.js";
import { createOrphanedThreadSession } from "./session-utils.js";

export class CommandHandler {
  constructor(
    private sessionManager: SessionManager,
    private allowedUserIds: string[],
    private baseFolder: string
  ) {}

  getCommands() {
    return [
      new SlashCommandBuilder()
        .setName("test")
        .setDescription("Build a test plan and run the cx test agent for the PR linked to this thread"),

      new SlashCommandBuilder()
        .setName("stop")
        .setDescription("Kill the running agent in this thread"),

      new SlashCommandBuilder()
        .setName("clear")
        .setDescription("Clear the session for this thread (forget history)"),

      new SlashCommandBuilder()
        .setName("cleanup")
        .setDescription("Remove this thread's worktree + branch")
        .addBooleanOption((o) =>
          o
            .setName("force")
            .setDescription("Discard even if there are uncommitted changes")
            .setRequired(false)
        ),

      new SlashCommandBuilder()
        .setName("status")
        .setDescription("Show agent, session ID, and working directory for this thread"),

      new SlashCommandBuilder()
        .setName("mode")
        .setDescription("Set permission mode for this channel (affects cc)")
        .addStringOption((o) =>
          o
            .setName("mode")
            .setDescription("Permission mode")
            .setRequired(true)
            .addChoices(
              { name: "auto — skip all permission checks", value: "auto" },
              { name: "plan — show plan before executing", value: "plan" },
              { name: "approve — ask for each dangerous action", value: "approve" }
            )
        ),

      new SlashCommandBuilder()
        .setName("model")
        .setDescription("Set model — in a channel updates the default; in a thread overrides only that thread")
        .addSubcommand((s) =>
          s
            .setName("cc")
            .setDescription("Set the Claude Code model")
            .addStringOption((o) =>
              o
                .setName("model")
                .setDescription("Claude model to use")
                .setRequired(true)
                .addChoices(...CC_MODEL_CHOICES)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("codex")
            .setDescription("Set the Codex model")
            .addStringOption((o) =>
              o
                .setName("model")
                .setDescription("Codex model to use")
                .setRequired(true)
                .addChoices(...CODEX_MODEL_CHOICES)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("cs")
            .setDescription("Set the Cursor agent model")
            .addStringOption((o) =>
              o
                .setName("model")
                .setDescription("Cursor model to use")
                .setRequired(true)
                .addChoices(...CS_MODEL_CHOICES)
            )
        ),

      new SlashCommandBuilder()
        .setName("agents")
        .setDescription("List available @agent mentions and their model aliases"),

      new SlashCommandBuilder()
        .setName("goal")
        .setDescription("Set or clear a goal for this thread")
        .addSubcommand((s) =>
          s
            .setName("set")
            .setDescription("Set a goal for this thread")
            .addStringOption((o) =>
              o
                .setName("text")
                .setDescription("The goal description")
                .setRequired(true)
            )
        )
        .addSubcommand((s) =>
          s.setName("clear").setDescription("Clear the goal for this thread")
        )
        .addSubcommand((s) =>
          s.setName("show").setDescription("Show the current goal for this thread")
        ),

      new SlashCommandBuilder()
        .setName("queue")
        .setDescription("View messages queued to run after the current agent finishes"),

      new SlashCommandBuilder()
        .setName("update")
        .setDescription("Pull the latest default branch and restart the bot service"),

      new SlashCommandBuilder()
        .setName("tools")
        .setDescription("Show or hide specific tool-call messages for this channel")
        .addSubcommand((s) =>
          s
            .setName("hide")
            .setDescription("Hide a tool's messages in this channel")
            .addStringOption((o) =>
              o.setName("tool").setDescription("Tool name, e.g. Bash, Write, Grep").setRequired(true)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("show")
            .setDescription("Show a tool's messages in this channel")
            .addStringOption((o) =>
              o.setName("tool").setDescription("Tool name, e.g. Bash, Write, Grep").setRequired(true)
            )
        )
        .addSubcommand((s) =>
          s.setName("list").setDescription("List which tools are hidden/shown in this channel")
        ),

      new SlashCommandBuilder()
        .setName("handoff")
        .setDescription("Configure automatic handoff to another bot when agent completes")
        .addStringOption((o) =>
          o
            .setName("bot")
            .setDescription("Bot name to hand off to (e.g. 'hermes'), or 'clear' to disable")
            .setRequired(true)
        ),
    ];
  }

  async registerCommands(token: string, clientId: string): Promise<void> {
    const rest = new REST({ version: "10" }).setToken(token);
    await rest.put(Routes.applicationCommands(clientId), {
      body: this.getCommands().map((c) => c.toJSON()),
    });
    console.log("Slash commands registered.");
  }

  async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      if (!this.allowedUserIds.includes(interaction.user.id)) {
        await interaction.reply({ content: "Not authorised.", ephemeral: true });
        return;
      }
      if (interaction.customId.startsWith("worktree_force_close_")) {
        return this.handleWorktreeForceClose(interaction);
      }
      if (interaction.customId.startsWith("worktree_cancel_")) {
        return this.handleWorktreeCancel(interaction);
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    if (!this.allowedUserIds.includes(interaction.user.id)) {
      await interaction.reply({ content: "Not authorised.", ephemeral: true });
      return;
    }

    const { commandName } = interaction;

    if (commandName === "stop") return this.handleStop(interaction);
    if (commandName === "clear") return this.handleClear(interaction);
    if (commandName === "cleanup") return this.handleCleanup(interaction);
    if (commandName === "status") return this.handleStatus(interaction);
    if (commandName === "mode") return this.handleMode(interaction);
    if (commandName === "model") return this.handleModel(interaction);
    if (commandName === "goal") return this.handleGoal(interaction);
    if (commandName === "agents") return this.handleAgents(interaction);
    if (commandName === "tools") return this.handleTools(interaction);
    if (commandName === "queue") return this.handleQueue(interaction);
    if (commandName === "handoff") return this.handleHandoff(interaction);
    if (commandName === "update") return this.handleUpdate(interaction);
  }

  // Channel-level settings (mode/model/tools) are keyed by the parent channel,
  // because agent runs always read them with the parent channel's id. Resolve a
  // thread to its parent so these commands work whether run in the channel or a
  // thread inside it.
  private channelKey(i: ChatInputCommandInteraction): string {
    const ch = i.channel;
    if (ch && ch.isThread()) return ch.parentId ?? i.channelId;
    return i.channelId;
  }

  // ── Command handlers ────────────────────────────────────────────────────

  private async handleStop(i: ChatInputCommandInteraction): Promise<void> {
    const threadId = i.channelId;
    if (this.sessionManager.hasActiveProcess(threadId)) {
      this.sessionManager.killProcess(threadId);
      await i.reply({ embeds: [embed("🛑 Stopping", "Halted the agent — still delivering any output it already produced…", 0xffa500)] });
    } else {
      await i.reply({ embeds: [embed("ℹ️ Nothing Running", "No active agent in this thread.", 0x888888)] });
    }
  }

  private async handleClear(i: ChatInputCommandInteraction): Promise<void> {
    this.sessionManager.clearSession(i.channelId);
    await i.reply({ embeds: [embed("🗑️ Cleared", "Session history cleared.", 0x00ff00)] });
  }

  private async handleCleanup(i: ChatInputCommandInteraction): Promise<void> {
    const force = i.options.getBoolean("force") ?? false;

    if (!force) {
      const session = this.sessionManager.getDb().getThreadSession(i.channelId);
      if (session?.isWorktree) {
        const repoPath = mainRepoOf(session.workDir);
        if (repoPath) {
          const reason = worktreeCloseBlockReason(repoPath, session.workDir);
          if (reason) {
            void setThreadStatus(i.channel, "locked");
            await i.reply({
              embeds: [
                embed(
                  "🛑 Kept",
                  `Not removed — ${reason}. Re-run with \`force: true\` to discard it anyway.`,
                  0xffa500
                ),
              ],
            });
            return;
          }
        }
      }
    }

    const result = this.sessionManager.cleanupThreadWorktree(i.channelId, force);

    if (!result) {
      await i.reply({
        embeds: [embed("ℹ️ Nothing to clean", "This thread has no managed worktree.", 0x888888)],
      });
      return;
    }
    if (result.removed) {
      // Worktree + branch gone — this thread is "closed".
      void setThreadStatus(i.channel, "closed");
      await i.reply({
        embeds: [embed("🧹 Cleaned up", "Worktree and branch removed.", 0x00ff00)],
      });
    } else {
      // Kept deliberately (uncommitted work) — that's the "locked" state.
      void setThreadStatus(i.channel, "locked");
      await i.reply({
        embeds: [
          embed(
            "🛑 Kept",
            `Not removed — ${result.reason}. Re-run with \`force: true\` to discard it anyway.`,
            0xffa500
          ),
        ],
      });
    }
  }

  private async handleStatus(i: ChatInputCommandInteraction): Promise<void> {
    const db = this.sessionManager.getDb();
    const channelId = this.channelKey(i);
    const inThread = i.channel?.isThread() ?? false;
    const session = db.getThreadSession(i.channelId);
    if (!session) {
      await i.reply({ embeds: [embed("ℹ️ No Session", "No session found for this thread.", 0x888888)] });
      return;
    }
    const running = this.sessionManager.hasActiveProcess(i.channelId);
    const channelModel = getChannelModelForAgent(db, session.agent, channelId);
    const effectiveModel = session.modelOverride ?? channelModel;
    const modelSource =
      session.modelOverride === undefined
        ? "channel default"
        : session.modelOverride === channelModel
          ? "channel default (frozen at thread start)"
          : "thread override";
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("📊 Session Status")
          .addFields(
            { name: "Agent", value: session.agent, inline: true },
            { name: "Status", value: running ? "🟢 Running" : "⚫ Idle", inline: true },
            { name: "Active Model", value: `${effectiveModel} (${modelSource})`, inline: true },
            ...(inThread
              ? []
              : [
                  { name: "CC Model", value: db.getModel(channelId), inline: true },
                  { name: "Codex Model", value: db.getCodexModel(channelId), inline: true },
                  { name: "CS Model", value: db.getCsModel(channelId), inline: true },
                ]),
            { name: "Session ID", value: session.sessionId ?? "none", inline: false },
            { name: "Working Dir", value: `\`${session.workDir}\``, inline: false }
          )
          .setColor(0x5865f2),
      ],
    });
  }

  private async handleMode(i: ChatInputCommandInteraction): Promise<void> {
    const mode = i.options.getString("mode", true) as PermissionMode;
    this.sessionManager.getDb().setMode(this.channelKey(i), mode);
    await i.reply({
      embeds: [embed("✅ Mode Set", `Permission mode set to **${mode}** for this channel.`, 0x00ff00)],
    });
  }

  private async handleGoal(i: ChatInputCommandInteraction): Promise<void> {
    const db = this.sessionManager.getDb();
    const sub = i.options.getSubcommand();
    const threadId = i.channelId;

    // Goal only works in threads
    if (!i.channel?.isThread()) {
      await i.reply({
        embeds: [embed("ℹ️ Use in Thread", "The `/goal` command only works in threads, not channels.", 0x888888)],
        ephemeral: true,
      });
      return;
    }

    const session = db.getThreadSession(threadId);
    if (!session) {
      await i.reply({
        embeds: [embed("ℹ️ No Session", "No session found for this thread. Start a conversation first.", 0x888888)],
        ephemeral: true,
      });
      return;
    }

    if (sub === "set") {
      const goalText = i.options.getString("text", true);
      db.updateGoal(threadId, goalText);

      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("🎯 Goal Set")
            .setDescription(`Goal for this thread:\n\n> ${goalText}`)
            .setColor(0x00ff00),
        ],
      });

      // Send /goal message to start the agent working immediately
      const thread = i.channel as ThreadChannel;
      await thread.send(`/goal ${goalText}`);
    } else if (sub === "clear") {
      if (!session.goal) {
        await i.reply({
          embeds: [embed("ℹ️ No Goal", "No goal is currently set for this thread.", 0x888888)],
          ephemeral: true,
        });
        return;
      }

      // Send /goal clear to the agent to properly stop the goal loop
      await i.reply({
        embeds: [embed("🔄 Clearing Goal", "Sending `/goal clear` to agent...", 0xffa500)],
      });

      // Clear from database immediately - the agent will confirm
      db.updateGoal(threadId, null);

      // Send /goal clear message to the agent
      const thread = i.channel as ThreadChannel;
      const agentMessage = await thread.send("/goal clear");
    } else if (sub === "show") {
      const goal = session.goal;
      if (!goal) {
        await i.reply({
          embeds: [embed("ℹ️ No Goal", "No goal set for this thread.", 0x888888)],
          ephemeral: true,
        });
      } else {
        await i.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle("🎯 Current Goal")
              .setDescription(`> ${goal}`)
              .setColor(0x5865f2),
          ],
          ephemeral: true,
        });
      }
    }
  }

  private modelSubcommandAgent(sub: string): string {
    if (sub === "codex") return "cx";
    if (sub === "cs") return "cs";
    return "cc";
  }

  private modelSubcommandLabel(sub: string): string {
    if (sub === "codex") return "codex";
    if (sub === "cs") return "cs";
    return "cc";
  }

  private async handleModel(i: ChatInputCommandInteraction): Promise<void> {
    const db = this.sessionManager.getDb();
    const sub = i.options.getSubcommand();
    const expectedAgent = this.modelSubcommandAgent(sub);
    const modelLabel = this.modelSubcommandLabel(sub);

    let model: CcModel | CodexModel | CsModel;
    if (sub === "cc") model = i.options.getString("model", true) as CcModel;
    else if (sub === "cs") model = i.options.getString("model", true) as CsModel;
    else model = i.options.getString("model", true) as CodexModel;

    // In a thread: override the model for this thread only.
    if (i.channel?.isThread()) {
      const session = db.getThreadSession(i.channelId);
      if (!session) {
        await i.reply({
          embeds: [
            embed(
              "ℹ️ No Session",
              "Start an agent in this thread first — `/model` here will then apply only to this thread.",
              0x888888
            ),
          ],
        });
        return;
      }
      if (session.agent !== expectedAgent) {
        const agentLabel = this.modelSubcommandLabel(
          session.agent === "cx" ? "codex" : session.agent
        );
        await i.reply({
          embeds: [
            embed(
              "⚠️ Command Does Not Apply",
              `This is an **@${session.agent}** thread — \`/model ${modelLabel}\` has no effect here. Use \`/model ${agentLabel}\` instead.`,
              0xffa500
            ),
          ],
        });
        return;
      }
      db.updateModelOverride(i.channelId, model);
      await i.reply({
        embeds: [
          embed(
            "✅ Thread Model Set",
            `${modelLabel === "cc" ? "Claude Code" : modelLabel === "cs" ? "Cursor agent" : "Codex"} model set to **${model}** for this thread. All future runs here will use it.`,
            0x00ff00
          ),
        ],
      });
      return;
    }

    // In a channel: default for new threads only (existing threads keep their frozen model).
    const channelId = i.channelId;
    if (sub === "cc") {
      db.setModel(channelId, model as CcModel);
      await i.reply({
        embeds: [embed("✅ CC Model Set", `Claude Code model set to **${model}** for this channel. New threads will use it; existing threads are unchanged.`, 0x00ff00)],
      });
      return;
    }

    if (sub === "cs") {
      db.setCsModel(channelId, model as CsModel);
      await i.reply({
        embeds: [embed("✅ CS Model Set", `Cursor agent model set to **${model}** for this channel. New threads will use it; existing threads are unchanged.`, 0x00ff00)],
      });
      return;
    }

    db.setCodexModel(channelId, model as CodexModel);
    await i.reply({
      embeds: [embed("✅ Codex Model Set", `Codex model set to **${model}** for this channel. New threads will use it; existing threads are unchanged.`, 0x00ff00)],
    });
  }

  private async handleHandoff(i: ChatInputCommandInteraction): Promise<void> {
    const db = this.sessionManager.getDb();
    const threadId = i.channelId;

    // Handoff only works in threads
    if (!i.channel?.isThread()) {
      await i.reply({
        embeds: [embed("ℹ️ Use in Thread", "The `/handoff` command only works in threads, not channels.", 0x888888)],
        ephemeral: true,
      });
      return;
    }

    let session = db.getThreadSession(threadId);

    // If no session exists, try to create one from thread name
    if (!session) {
      const thread = i.channel as any;
      const created = createOrphanedThreadSession(thread, db, this.baseFolder);

      if (!created) {
        await i.reply({
          embeds: [embed("ℹ️ No Session", "No session found for this thread. Start a conversation first.", 0x888888)],
          ephemeral: true,
        });
        return;
      }

      session = db.getThreadSession(threadId)!;
    }

    const botName = i.options.getString("bot", true).trim().toLowerCase();

    if (botName === "clear") {
      db.setThreadHandoffBot(threadId, null);
      await i.reply({
        embeds: [embed("✅ Handoff Cleared", "Agent will no longer send handoff messages.", 0x00ff00)],
      });
    } else {
      db.setThreadHandoffBot(threadId, botName);
      await i.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ Handoff Configured")
            .setDescription(`Agent will mention **@${botName}** when done.`)
            .setColor(0x00ff00),
        ],
      });
    }
  }

  private async handleAgents(i: ChatInputCommandInteraction): Promise<void> {
    const aliasesByAgent: Record<string, { aliases: Record<string, string>; defaultModel: string }> = {
      cc: { aliases: CC_MODEL_ALIASES, defaultModel: DEFAULT_CC_MODEL },
      cx: { aliases: CODEX_MODEL_ALIASES, defaultModel: DEFAULT_CODEX_MODEL },
      cs: { aliases: CS_MODEL_ALIASES, defaultModel: DEFAULT_CS_MODEL },
    };

    const sections = listAgentKeys().map((key) => {
      const agent = getAgent(key)!;
      const info = aliasesByAgent[key];
      const aliasList = info
        ? Object.keys(info.aliases).map((a) => `\`@${key}${a}\``).join(", ")
        : "none";
      const defaultLine = info ? ` (default: \`${info.defaultModel}\`)` : "";
      return `**@${key}** — ${agent.label}${defaultLine}\nModel aliases: ${aliasList}`;
    });

    await i.reply({
      embeds: [embed("Available @mentions", sections.join("\n\n"), 0x5865f2)],
    });
  }

  private async handleTools(i: ChatInputCommandInteraction): Promise<void> {
    const db = this.sessionManager.getDb();
    const channelId = this.channelKey(i);
    const sub = i.options.getSubcommand();

    if (sub === "list") {
      const overrides = db.getToolOverrides(channelId);
      // Curated known tools first, then any tool this channel has an override
      // for (e.g. an MCP tool) that isn't in the known list.
      const names = [
        ...KNOWN_TOOLS,
        ...Object.keys(overrides).filter((t) => !KNOWN_TOOLS.includes(t)),
      ];
      const hidden = names.filter((t) => toolIsHidden(t, overrides));
      const shown = names.filter((t) => !toolIsHidden(t, overrides));
      const fmt = (arr: string[]) => (arr.length ? arr.map((t) => `\`${t}\``).join(", ") : "none");
      const desc =
        `🙈 **Hidden:** ${fmt(hidden)}\n\n` +
        `👁️ **Shown:** ${fmt(shown)}\n\n` +
        `*Any tool not listed (e.g. MCP tools) shows by default. Use \`/tools hide <tool>\` or \`/tools show <tool>\`.*`;
      await i.reply({ embeds: [embed("🔧 Tool Visibility", desc, 0x5865f2)] });
      return;
    }

    const tool = i.options.getString("tool", true).trim();
    const hidden = sub === "hide";
    db.setToolHidden(channelId, tool, hidden);
    await i.reply({
      embeds: [
        embed(
          "✅ Tool Visibility",
          `\`${tool}\` messages will be **${hidden ? "hidden" : "shown"}** in this channel.`,
          0x00ff00
        ),
      ],
    });
  }

  private async handleQueue(i: ChatInputCommandInteraction): Promise<void> {
    const ch = i.channel;

    if (ch?.isThread()) {
      const threadId = ch.id;
      const queue = this.sessionManager.listQueuedMessages(threadId);
      const usageWait = this.sessionManager.getUsageLimitWait(threadId);

      if (queue.length === 0) {
        const extra = usageWait.waiting
          ? `\n\n⏸️ Waiting for usage limit reset at **${usageWait.resetLabel}**.`
          : "";
        await i.reply({
          embeds: [embed("📋 Queue", `No messages queued in this thread.${extra}`, 0x888888)],
        });
        return;
      }

      const lines = queue.map((m) => `**${m.position}.** ${m.preview}`).join("\n\n");
      const waitNote = usageWait.waiting
        ? `\n\n⏸️ Usage limit resets at **${usageWait.resetLabel}** — queued messages run after auto-resume.`
        : "";
      await i.reply({
        embeds: [embed(`📋 Queue (${queue.length})`, lines + waitNote, 0x5865f2)],
      });
      return;
    }

    const channelId = i.channelId;
    const groups = this.sessionManager.listQueuedMessagesForChannel(channelId);
    if (groups.length === 0) {
      await i.reply({
        embeds: [embed("📋 Channel Queue", "No messages queued in this channel.", 0x888888)],
      });
      return;
    }

    const total = groups.reduce((n, g) => n + g.messages.length, 0);
    const sections = groups
      .map((g) => {
        const lines = g.messages.map((m) => `  **${m.position}.** ${m.preview}`).join("\n");
        return `**${g.threadName}** (${g.messages.length})\n${lines}`;
      })
      .join("\n\n");

    await i.reply({
      embeds: [embed(`📋 Channel Queue (${total} in ${groups.length} thread${groups.length === 1 ? "" : "s"})`, sections, 0x5865f2)],
    });
  }

  private async handleUpdate(i: ChatInputCommandInteraction): Promise<void> {
    await i.deferReply();

    const repoDir = path.resolve(import.meta.dir, "../..");

    // Fetch then hard-reset so divergent local commits never block the update.
    let pullOutput: string;
    try {
      const fetch = Bun.spawn(["git", "-C", repoDir, "fetch", "origin", "main"], { stderr: "pipe" });
      const fetchErr = await new Response(fetch.stderr).text();
      await fetch.exited;
      if (fetch.exitCode !== 0) throw new Error(fetchErr.trim() || "git fetch failed");

      // Check whether we're already at origin/main before resetting.
      const revLocal = Bun.spawn(["git", "-C", repoDir, "rev-parse", "HEAD"], { stderr: "pipe" });
      const revRemote = Bun.spawn(["git", "-C", repoDir, "rev-parse", "origin/main"], { stderr: "pipe" });
      const [localSha, remoteSha] = await Promise.all([
        new Response(revLocal.stdout).text(),
        new Response(revRemote.stdout).text(),
      ]);

      if (localSha.trim() === remoteSha.trim()) {
        pullOutput = "Already up to date.";
      } else {
        const reset = Bun.spawn(["git", "-C", repoDir, "reset", "--hard", "origin/main"], { stderr: "pipe" });
        const [resetOut, resetErr] = await Promise.all([
          new Response(reset.stdout).text(),
          new Response(reset.stderr).text(),
        ]);
        await reset.exited;
        if (reset.exitCode !== 0) throw new Error((resetOut + resetErr).trim() || "git reset failed");
        pullOutput = (resetOut + resetErr).trim() || "Reset to origin/main.";
      }
    } catch (err: any) {
      await i.editReply({
        embeds: [embed("❌ Update Failed", `\`\`\`\n${String(err.message ?? err).slice(0, 1800)}\n\`\`\``, 0xff0000)],
      });
      return;
    }

    if (pullOutput.includes("Already up to date")) {
      await i.editReply({
        embeds: [embed("✅ Already up to date", "Nothing to pull — already on the latest commit.", 0x00ff00)],
      });
      return;
    }

    const msg = await i.editReply({
      embeds: [
        embed(
          "🔄 Restarting…",
          `\`\`\`\n${pullOutput.slice(0, 1800)}\n\`\`\`\nPulled. Restarting service — back in a moment.`,
          0x5865f2
        ),
      ],
    });

    this.sessionManager.getDb().setRestartNotification(i.channelId, msg.id);

    // Spawn the restart detached so it fires after Discord receives the reply.
    // The service manager kills and relaunches this process, so nothing after
    // the spawn will run reliably.
    const isMac = process.platform === "darwin";
    const uid = process.getuid?.() ?? 501;
    const restartCmd = isMac
      ? `launchctl kickstart -k gui/${uid}/com.discord-ai-terminal`
      : "systemctl --user restart discord-ai-terminal";

    Bun.spawn(["sh", "-c", `sleep 1 && ${restartCmd}`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  }

  private async handleWorktreeForceClose(interaction: ButtonInteraction): Promise<void> {
    const result = this.sessionManager.cleanupThreadWorktree(interaction.channelId, true, true);
    if (result?.removed) {
      void setThreadStatus(interaction.channel, "closed", { archived: true });
      await interaction.update({ content: "🧹 Worktree forcibly removed.", components: [] });
    } else {
      await interaction.update({ content: "⚠️ Could not remove worktree.", components: [] });
    }
  }

  private async handleWorktreeCancel(interaction: ButtonInteraction): Promise<void> {
    await interaction.update({ content: "🌲 Worktree kept. No changes made.", components: [] });
  }

}

function embed(title: string, description: string, color: number) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
}
