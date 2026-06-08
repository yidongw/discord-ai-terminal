import {
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ChannelType,
  type Interaction,
  type ChatInputCommandInteraction,
  type ThreadChannel,
} from "discord.js";
import { SessionManager } from "./session-manager.js";
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
      await i.reply({
        embeds: [embed("🧹 Cleaned up", "Worktree and branch removed.", 0x00ff00)],
      });
    } else {
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
    this.sessionManager.getDb().setMode(i.channelId, mode);
    await i.reply({
      embeds: [embed("✅ Mode Set", `Permission mode set to **${mode}** for this channel.`, 0x00ff00)],
    });
  }

  private async handleModel(i: ChatInputCommandInteraction): Promise<void> {
    const model = i.options.getString("model", true) as ClaudeModel;
    this.sessionManager.getDb().setModel(i.channelId, model);
    await i.reply({
      embeds: [embed("✅ Model Set", `Claude model set to **${model}** for this channel.`, 0x00ff00)],
    });
  }

}

function embed(title: string, description: string, color: number) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
}
