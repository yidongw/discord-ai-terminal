import { spawn, type ChildProcess } from "child_process";
import { EmbedBuilder } from "discord.js";
import { formatForDiscord } from "../utils/discord-format.js";
import { getAgent, type AgentEvent } from "../agents/index.js";
import { DatabaseManager } from "../db/database.js";
import type { DiscordContext } from "../utils/shell.js";

const TIMEOUT_MS = 30 * 60 * 1000;
const MAX_EMBED = 4000;

interface ActiveSession {
  process: ChildProcess;
  thread: any;
  toolCalls: Map<string, { message: any }>;
  workDir: string;
}

export class SessionManager {
  private db: DatabaseManager;
  private active = new Map<string, ActiveSession>();

  constructor() {
    this.db = new DatabaseManager();
    this.db.cleanupOldThreadSessions();
  }

  getDb() { return this.db; }
  hasActiveProcess(threadId: string) { return this.active.has(threadId); }

  killProcess(threadId: string): void {
    this.active.get(threadId)?.process.kill("SIGTERM");
    this.active.delete(threadId);
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

    console.log(`[${agentKey}] CMD: ${command}`);

    const proc = spawn("/bin/bash", ["-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SHELL: "/bin/bash" },
    });
    proc.stdin.end();

    const session: ActiveSession = { process: proc, thread, toolCalls: new Map(), workDir };
    this.active.set(threadId, session);

    if (!existing) {
      this.db.createThreadSession({ threadId, channelId, agent: agentKey, workDir, createdAt: Date.now() });
    }

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      thread.send({ embeds: [embed("⏰ Timeout", "30 min limit reached.", 0xffd700)] }).catch(console.error);
    }, TIMEOUT_MS);

    let buffer = "";
    let done = false;

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        console.log(`[${agentKey}] RAW: ${line}`);
        const event = agent.parseLine(line, workDir);
        if (event) this.handleEvent(threadId, event, session).catch(console.error);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      console.error(`[${agentKey}] stderr:`, text);
      if (text && !text.includes("INFO") && !text.includes("DEBUG")) {
        thread.send({ embeds: [embed("⚠️ Warning", text.slice(0, 2000), 0xffa500)] }).catch(console.error);
      }
    });

    proc.on("close", (code) => {
      clearTimeout(timeout);
      this.active.delete(threadId);
      if (code !== 0 && code !== null && !done) {
        thread.send({ embeds: [embed("❌ Process Failed", `Exit code: ${code}`, 0xff0000)] }).catch(console.error);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      this.active.delete(threadId);
      thread.send({ embeds: [embed("❌ Process Error", err.message, 0xff0000)] }).catch(console.error);
    });

    const handleEvent = this.handleEvent.bind(this);
    // Patch done flag via event
    const origHandle = this.handleEvent.bind(this);
    this.handleEvent = async (tid, event, sess) => {
      if (event.kind === "done" || event.kind === "error") {
        done = true;
        clearTimeout(timeout);
        proc.kill("SIGTERM");
        this.active.delete(tid);
      }
      return origHandle(tid, event, sess);
    };
  }

  private async handleEvent(threadId: string, event: AgentEvent, session: ActiveSession): Promise<void> {
    const { thread, toolCalls } = session;

    if (event.kind === "init") {
      this.db.updateSessionId(threadId, event.sessionId);
      await thread.send({ embeds: [embed("🚀 Session started", `**Dir:** \`${event.cwd}\`\n**Model:** ${event.model}`, 0x00ff00)] });
      return;
    }

    if (event.kind === "text") {
      await this.sendChunked(thread, event.content);
      return;
    }

    if (event.kind === "tool_start") {
      const msg = await thread.send({ embeds: [new EmbedBuilder().setDescription(`⏳ ${event.label}`).setColor(0x0099ff)] });
      toolCalls.set(event.id, { message: msg });
      return;
    }

    if (event.kind === "tool_done") {
      const tracked = toolCalls.get(event.id);
      if (tracked?.message) {
        const current = tracked.message.embeds[0].data.description ?? "";
        const updated = current.replace("⏳", event.isError ? "❌" : "✅");
        await tracked.message.edit({
          embeds: [new EmbedBuilder().setDescription(`${updated}${event.preview ? `\n*${event.preview.slice(0, 100)}*` : ""}`).setColor(event.isError ? 0xff0000 : 0x00ff00)],
        }).catch(console.error);
      }
      return;
    }

    if (event.kind === "done") {
      const parts: string[] = [];
      if (event.turns !== null) parts.push(`${event.turns} turns`);
      if (event.cost !== null) parts.push(event.cost < 0.01 ? `${(event.cost * 100).toFixed(2)}¢` : `$${event.cost.toFixed(2)}`);
      if (event.tokens) parts.push(event.tokens);
      await thread.send({ embeds: [embed("✅ Done", parts.length ? `*${parts.join(" · ")}*` : "Complete.", 0x00ff00)] });
      return;
    }

    if (event.kind === "error") {
      await thread.send({ embeds: [embed("❌ Failed", event.message, 0xff0000)] });
      return;
    }

    // Internal SDK events with extra fields — handle here
    const raw = event as any;
    if (raw.kind === "_sdk_assistant") {
      this.db.updateSessionId(threadId, raw.sessionId);
      if (raw.content?.trim()) await this.sendChunked(thread, raw.content);
      for (const tool of (raw.tools ?? [])) {
        const label = formatToolCall(tool, session.workDir);
        const msg = await thread.send({ embeds: [new EmbedBuilder().setDescription(`⏳ ${label}`).setColor(0x0099ff)] });
        toolCalls.set(tool.id, { message: msg });
      }
    }
    if (raw.kind === "_sdk_tool_results") {
      for (const result of (raw.results ?? [])) {
        const tracked = toolCalls.get(result.tool_use_id);
        if (!tracked?.message) continue;
        const firstLine = String(result.content ?? "").split("\n")[0].trim().slice(0, 100);
        const current = tracked.message.embeds[0].data.description ?? "";
        const updated = current.replace("⏳", result.is_error ? "❌" : "✅");
        await tracked.message.edit({
          embeds: [new EmbedBuilder().setDescription(`${updated}${firstLine ? `\n*${firstLine}*` : ""}`).setColor(result.is_error ? 0xff0000 : 0x00ff00)],
        }).catch(console.error);
      }
    }
  }

  private async sendChunked(thread: any, content: string): Promise<void> {
    const text = formatForDiscord(content);
    if (text.length <= MAX_EMBED) {
      await thread.send({ embeds: [new EmbedBuilder().setDescription(text).setColor(0x7289da)] });
      return;
    }
    const chunks = splitText(text, MAX_EMBED);
    for (let i = 0; i < chunks.length; i++) {
      await thread.send({
        embeds: [new EmbedBuilder().setDescription(chunks[i]).setColor(0x7289da).setFooter(i > 0 ? { text: `(${i + 1}/${chunks.length})` } : null)],
      });
    }
  }

  destroy(): void {
    for (const [id] of this.active) this.killProcess(id);
  }
}

function embed(title: string, description: string, color: number) {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(color);
}

function splitText(text: string, max: number): string[] {
  const chunks: string[] = [];
  let rem = text;
  while (rem.length > 0) {
    if (rem.length <= max) { chunks.push(rem); break; }
    let i = rem.lastIndexOf("\n\n", max);
    if (i < max / 2) i = rem.lastIndexOf("\n", max);
    if (i < max / 2) i = max;
    chunks.push(rem.slice(0, i));
    rem = rem.slice(i).trim();
  }
  return chunks;
}

function formatToolCall(tool: any, workDir: string): string {
  const clean = (v: string) => v.startsWith(workDir + "/") ? v.replace(workDir + "/", "./") : v === workDir ? "." : v;
  if (tool.name === "Bash" && tool.input?.command) return `🔧 **Bash**\n\`\`\`bash\n${clean(String(tool.input.command)).slice(0, 400)}\n\`\`\``;
  if (tool.name === "Read"  && tool.input?.file_path) return `🔧 **Read** \`${clean(String(tool.input.file_path))}\``;
  if (tool.name === "Edit"  && tool.input?.file_path) return `🔧 **Edit** \`${clean(String(tool.input.file_path))}\``;
  if (tool.name === "Write" && tool.input?.file_path) return `🔧 **Write** \`${clean(String(tool.input.file_path))}\``;
  if (tool.name === "Glob"  && tool.input?.pattern)   return `🔧 **Glob** \`${tool.input.pattern}\``;
  if (tool.name === "Grep"  && tool.input?.pattern)   return `🔧 **Grep** \`${tool.input.pattern}\``;
  const inputs = Object.entries(tool.input ?? {}).map(([k, v]) => `${k}=\`${String(v).slice(0, 60)}\``).join(", ");
  return `🔧 **${tool.name}**${inputs ? ` (${inputs})` : ""}`;
}
