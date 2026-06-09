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
import type { PermissionMode, ClaudeModel } from "../db/database.js";

export class CommandHandler {
  constructor(
    private sessionManager: SessionManager,
    private allowedUserIds: string[],
    private baseFolder: string
  ) {}

  getCommands() {
    return [
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
            .setDescription("Discard even if there are uncommitted or unmerged changes")
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
        .setDescription("Set the Claude model for this channel")
        .addStringOption((o) =>
          o
            .setName("model")
            .setDescription("Model to use")
            .setRequired(true)
            .addChoices(
              { name: "sonnet — balanced (default)", value: "sonnet" },
              { name: "opus — most capable", value: "opus" },
              { name: "haiku — fastest", value: "haiku" }
            )
        ),

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
    if (commandName === "tools") return this.handleTools(interaction);
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
      // Kept deliberately (uncommitted/unmerged work) — that's the "locked" state.
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
    const session = this.sessionManager.getDb().getThreadSession(i.channelId);
    if (!session) {
      await i.reply({ embeds: [embed("ℹ️ No Session", "No session found for this thread.", 0x888888)] });
      return;
    }
    const running = this.sessionManager.hasActiveProcess(i.channelId);
    await i.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("📊 Session Status")
          .addFields(
            { name: "Agent", value: session.agent, inline: true },
            { name: "Status", value: running ? "🟢 Running" : "⚫ Idle", inline: true },
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

  private async handleModel(i: ChatInputCommandInteraction): Promise<void> {
    const model = i.options.getString("model", true) as ClaudeModel;
    this.sessionManager.getDb().setModel(this.channelKey(i), model);
    await i.reply({
      embeds: [embed("✅ Model Set", `Claude model set to **${model}** for this channel.`, 0x00ff00)],
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

  private async handleWorktreeForceClose(interaction: ButtonInteraction): Promise<void> {
    const result = this.sessionManager.cleanupThreadWorktree(interaction.channelId, true);
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
