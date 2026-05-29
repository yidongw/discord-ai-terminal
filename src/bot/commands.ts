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
import { listWorktrees, pruneWorktrees } from "../utils/path-resolver.js";
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
        .setName("worktree")
        .setDescription("Manage git worktrees for this channel's repo")
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("List all worktrees for this repo")
        )
        .addSubcommand((sub) =>
          sub.setName("prune").setDescription("Remove stale worktree refs")
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
    if (commandName === "status") return this.handleStatus(interaction);
    if (commandName === "mode") return this.handleMode(interaction);
    if (commandName === "model") return this.handleModel(interaction);
    if (commandName === "worktree") return this.handleWorktree(interaction);
  }

  // ── Command handlers ────────────────────────────────────────────────────

  private async handleStop(i: ChatInputCommandInteraction): Promise<void> {
    const threadId = i.channelId;
    if (this.sessionManager.hasActiveProcess(threadId)) {
      this.sessionManager.killProcess(threadId);
      await i.reply({ embeds: [embed("🛑 Stopped", "Agent process killed.", 0xffa500)] });
    } else {
      await i.reply({ embeds: [embed("ℹ️ Nothing Running", "No active agent in this thread.", 0x888888)] });
    }
  }

  private async handleClear(i: ChatInputCommandInteraction): Promise<void> {
    this.sessionManager.clearSession(i.channelId);
    await i.reply({ embeds: [embed("🗑️ Cleared", "Session history cleared.", 0x00ff00)] });
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

  private async handleWorktree(i: ChatInputCommandInteraction): Promise<void> {
    const sub = i.options.getSubcommand();
    const channelName =
      i.channel && "name" in i.channel ? (i.channel as any).name : null;

    if (!channelName) {
      await i.reply({ content: "Cannot determine channel name.", ephemeral: true });
      return;
    }

    if (sub === "list") {
      const trees = listWorktrees(channelName, this.baseFolder);
      const desc = trees.length ? trees.map((t) => `\`${t}\``).join("\n") : "*No worktrees found.*";
      await i.reply({ embeds: [embed("🌲 Worktrees", desc, 0x5865f2)] });
    } else if (sub === "prune") {
      const result = pruneWorktrees(channelName, this.baseFolder);
      await i.reply({ embeds: [embed("🌲 Prune", result, 0x00ff00)] });
    }
  }
}

function embed(title: string, description: string, color: number) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
}
