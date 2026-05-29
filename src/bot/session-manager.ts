import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from "discord.js";
import type { SDKMessage } from "../types/index.js";
import { formatForDiscord } from "../utils/discord-format.js";
import { getAgent } from "../agents/index.js";
import { DatabaseManager } from "../db/database.js";
import type { DiscordContext } from "../utils/shell.js";

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes default
const MAX_EMBED = 4000;

interface ActiveSession {
  process: ChildProcess;
  thread: any; // Discord ThreadChannel
  toolCalls: Map<string, { message: any; toolId: string }>;
  workDir: string;
}

export class SessionManager {
  private db: DatabaseManager;
  private active = new Map<string, ActiveSession>();

  constructor() {
    this.db = new DatabaseManager();
    this.db.cleanupOldThreadSessions();
  }

  getDb(): DatabaseManager {
    return this.db;
  }

  hasActiveProcess(threadId: string): boolean {
    return this.active.has(threadId);
  }

  killProcess(threadId: string): void {
    const session = this.active.get(threadId);
    if (session?.process) {
      session.process.kill("SIGTERM");
      this.active.delete(threadId);
    }
  }

  clearSession(threadId: string): void {
    this.killProcess(threadId);
    this.db.deleteThreadSession(threadId);
  }

  async runAgent(
    threadId: string,
    channelId: string,
    thread: any,
    agentKey: string,
    workDir: string,
    prompt: string,
    discordContext: DiscordContext
  ): Promise<void> {
    const agent = getAgent(agentKey);
    if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

    // Kill any running process for this thread
    this.killProcess(threadId);

    const existing = this.db.getThreadSession(threadId);
    const mode = this.db.getMode(channelId);
    const model = this.db.getModel(channelId);

    const command = agent.buildCommand(workDir, prompt, {
      sessionId: existing?.sessionId,
      mode,
      model,
      discordContext,
    });

    console.log(`[${agentKey}] thread=${threadId} cmd=${command}`);

    const proc = spawn("/bin/bash", ["-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SHELL: "/bin/bash" },
    });

    proc.stdin.end();

    const session: ActiveSession = {
      process: proc,
      thread,
      toolCalls: new Map(),
      workDir,
    };
    this.active.set(threadId, session);

    // Ensure thread session row exists
    if (!existing) {
      this.db.createThreadSession({
        threadId,
        channelId,
        agent: agentKey,
        workDir,
        createdAt: Date.now(),
      });
    }

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      thread
        .send({
          embeds: [
            new EmbedBuilder()
              .setTitle("⏰ Timeout")
              .setDescription("Agent took too long to respond (30 min limit)")
              .setColor(0xffd700),
          ],
        })
        .catch(console.error);
    }, TIMEOUT_MS);

    let buffer = "";
    let gotResult = false;

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: SDKMessage = JSON.parse(line);
          this.handleLine(threadId, agentKey, msg, session).catch(console.error);

          if (msg.type === "result" && !gotResult) {
            gotResult = true;
            clearTimeout(timeout);
            proc.kill("SIGTERM");
            this.active.delete(threadId);
          }
        } catch {
          // non-JSON line, ignore
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      console.error(`[${agentKey}] stderr:`, text);
      if (text.trim() && !text.includes("INFO") && !text.includes("DEBUG")) {
        thread
          .send({
            embeds: [
              new EmbedBuilder()
                .setTitle("⚠️ Warning")
                .setDescription(text.trim().slice(0, 2000))
                .setColor(0xffa500),
            ],
          })
          .catch(console.error);
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      this.active.delete(threadId);
      if (code !== 0 && code !== null && !gotResult) {
        thread
          .send({
            embeds: [
              new EmbedBuilder()
                .setTitle("❌ Process Failed")
                .setDescription(`Exited with code: ${code}`)
                .setColor(0xff0000),
            ],
          })
          .catch(console.error);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      this.active.delete(threadId);
      thread
        .send({
          embeds: [
            new EmbedBuilder()
              .setTitle("❌ Process Error")
              .setDescription(err.message)
              .setColor(0xff0000),
          ],
        })
        .catch(console.error);
    });
  }

  private async handleLine(
    threadId: string,
    agentKey: string,
    msg: SDKMessage,
    session: ActiveSession
  ): Promise<void> {
    const { thread } = session;

    if (msg.type === "system" && msg.subtype === "init") {
      this.db.updateSessionId(threadId, msg.session_id);
      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🚀 ${agentKey} session started`)
            .setDescription(`**Dir:** \`${msg.cwd}\`\n**Model:** ${msg.model}`)
            .setColor(0x00ff00),
        ],
      });
      return;
    }

    if (msg.type === "assistant") {
      this.db.updateSessionId(threadId, msg.session_id);
      await this.handleAssistant(msg, session);
      return;
    }

    if (msg.type === "user") {
      await this.handleToolResults(msg, session);
      return;
    }

    if (msg.type === "result") {
      this.db.updateSessionId(threadId, msg.session_id);
      await this.handleResult(msg, session);
    }
  }

  private async handleAssistant(
    msg: SDKMessage & { type: "assistant" },
    session: ActiveSession
  ): Promise<void> {
    const { thread, toolCalls } = session;
    const content = Array.isArray(msg.message.content)
      ? msg.message.content.find((c: any) => c.type === "text")?.text ?? ""
      : msg.message.content ?? "";

    const tools: any[] = Array.isArray(msg.message.content)
      ? msg.message.content.filter((c: any) => c.type === "tool_use")
      : [];

    if (content.trim()) {
      await this.sendChunked(thread, "💬 Response", content, 0x7289da);
    }

    for (const tool of tools) {
      const toolMsg = this.formatToolCall(tool, session.workDir);
      const sent = await thread.send({
        embeds: [
          new EmbedBuilder()
            .setDescription(`⏳ ${toolMsg}`)
            .setColor(0x0099ff),
        ],
      });
      toolCalls.set(tool.id, { message: sent, toolId: tool.id });
    }
  }

  private async handleToolResults(
    msg: SDKMessage & { type: "user" },
    session: ActiveSession
  ): Promise<void> {
    const results: any[] = Array.isArray(msg.message.content)
      ? msg.message.content.filter((c: any) => c.type === "tool_result")
      : [];

    for (const result of results) {
      const tracked = session.toolCalls.get(result.tool_use_id);
      if (!tracked?.message) continue;
      try {
        const firstLine = String(result.content ?? "").split("\n")[0].trim();
        const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
        const current = tracked.message.embeds[0];
        const updated = current.data.description.replace("⏳", result.is_error ? "❌" : "✅");
        await tracked.message.edit({
          embeds: [
            new EmbedBuilder()
              .setDescription(`${updated}${preview ? `\n*${preview}*` : ""}`)
              .setColor(result.is_error ? 0xff0000 : 0x00ff00),
          ],
        });
      } catch (e) {
        console.error("Error updating tool result:", e);
      }
    }
  }

  private async handleResult(
    msg: SDKMessage & { type: "result" },
    session: ActiveSession
  ): Promise<void> {
    const { thread } = session;
    const cost = (msg as any).total_cost_usd ?? 0;
    const costStr = cost < 0.01 ? `${(cost * 100).toFixed(2)}¢` : `$${cost.toFixed(2)}`;
    const turns = (msg as any).num_turns ?? 0;

    if (msg.subtype === "success") {
      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ Done")
            .setDescription(`*${turns} turns · ${costStr}*`)
            .setColor(0x00ff00),
        ],
      });
    } else {
      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Failed")
            .setDescription(`${msg.subtype}\n*${turns} turns · ${costStr}*`)
            .setColor(0xff0000),
        ],
      });
    }
  }

  private async sendChunked(
    thread: any,
    title: string,
    content: string,
    color: number
  ): Promise<void> {
    const formatted = formatForDiscord(content);
    if (formatted.length <= MAX_EMBED) {
      await thread.send({
        embeds: [new EmbedBuilder().setTitle(title).setDescription(formatted).setColor(color)],
      });
      return;
    }

    const chunks = splitText(formatted, MAX_EMBED);
    await thread.send({
      embeds: [new EmbedBuilder().setTitle(title).setDescription(chunks[0]).setColor(color)],
    });
    for (let i = 1; i < chunks.length; i++) {
      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setDescription(chunks[i])
            .setColor(color)
            .setFooter({ text: `(${i + 1}/${chunks.length})` }),
        ],
      });
    }
  }

  private formatToolCall(tool: any, workDir: string): string {
    const clean = (v: string) =>
      v.startsWith(workDir + "/") ? v.replace(workDir + "/", "./") : v === workDir ? "." : v;

    if (tool.name === "Bash" && tool.input?.command)
      return `🔧 **Bash**\n\`\`\`bash\n${clean(String(tool.input.command)).slice(0, 400)}\n\`\`\``;
    if (tool.name === "Read" && tool.input?.file_path)
      return `🔧 **Read** \`${clean(String(tool.input.file_path))}\``;
    if (tool.name === "Edit" && tool.input?.file_path)
      return `🔧 **Edit** \`${clean(String(tool.input.file_path))}\``;
    if (tool.name === "Write" && tool.input?.file_path)
      return `🔧 **Write** \`${clean(String(tool.input.file_path))}\``;
    if (tool.name === "Glob" && tool.input?.pattern)
      return `🔧 **Glob** \`${tool.input.pattern}\``;
    if (tool.name === "Grep" && tool.input?.pattern)
      return `🔧 **Grep** \`${tool.input.pattern}\``;

    let msg = `🔧 **${tool.name}**`;
    if (tool.input && Object.keys(tool.input).length > 0) {
      const inputs = Object.entries(tool.input)
        .map(([k, v]) => {
          const val = typeof v === "object" ? JSON.stringify(v) : clean(String(v));
          return `${k}=\`${val.slice(0, 60)}\``;
        })
        .join(", ");
      msg += ` (${inputs})`;
    }
    return msg;
  }

  destroy(): void {
    for (const [threadId] of this.active) {
      this.killProcess(threadId);
    }
  }
}

function splitText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let idx = remaining.lastIndexOf("\n\n", maxLen);
    if (idx < maxLen / 2) idx = remaining.lastIndexOf("\n", maxLen);
    if (idx < maxLen / 2) idx = maxLen;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trim();
  }
  return chunks;
}
