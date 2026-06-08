import { spawn, type ChildProcess } from "child_process";
import { EmbedBuilder } from "discord.js";
import { formatForDiscord } from "../utils/discord-format.js";
import { getAgent, type AgentEvent } from "../agents/index.js";
import { DatabaseManager, toolIsHidden } from "../db/database.js";
import { mainRepoOf, removeWorktree, type RemoveResult } from "../utils/path-resolver.js";
import { setThreadStatus } from "../utils/thread-status.js";
import type { DiscordContext } from "../utils/shell.js";

const TIMEOUT_MS = 30 * 60 * 1000;
const MAX_EMBED = 4000;
// Grace period after SIGTERM before we escalate to SIGKILL. This keeps a
// runaway agent that ignores SIGTERM from streaming "already produced" output
// forever after a /stop.
const SIGKILL_GRACE_MS = 3000;
// Discord's typing indicator lasts ~10s; refresh a little sooner so it stays
// visible continuously while a run is active or its outbox is still draining.
const TYPING_REFRESH_MS = 8000;

interface ActiveSession {
  process: ChildProcess;
  thread: any;
  toolCalls: Map<string, { message: any }>;
  workDir: string;
  // Per-channel tool-message visibility overrides ({ toolName: hidden }); see
  // toolIsHidden() and DEFAULT_HIDDEN_TOOLS.
  toolOverrides: Record<string, boolean>;
  outbox: Outbox;
  done: boolean;
  stopping: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  // Accumulated plain-text output; used by onDone for GitHub PR summaries.
  textOutput: string;
  onDone?: (text: string) => void;
}

export class SessionManager {
  private db: DatabaseManager;
  private active = new Map<string, ActiveSession>();
  // Delivery state keyed by thread, persisted ACROSS runs so overlapping runs
  // (e.g. a new run starting while a previous one is still draining) share a
  // single ordered queue and a single typing indicator instead of racing.
  private outboxes = new Map<string, Outbox>();
  private typing = new Map<string, TypingIndicator>();

  constructor() {
    this.db = new DatabaseManager();
    this.db.cleanupOldThreadSessions();
  }

  getDb() { return this.db; }

  // A thread is "active" while its process is alive OR its outbox still has
  // queued/in-flight messages. The session stays in the map until both are
  // drained (see the close handler), so this never reports idle while messages
  // are still being delivered.
  hasActiveProcess(threadId: string) { return this.active.has(threadId); }

  // Graceful stop: signal the agent to stop producing NEW output, but let the
  // outbox keep delivering whatever it already produced. The close handler
  // drains the outbox and removes the session once delivery finishes.
  killProcess(threadId: string): void {
    const session = this.active.get(threadId);
    if (session) this.stopProcess(session);
  }

  clearSession(threadId: string): void {
    this.killProcess(threadId);
    this.db.deleteThreadSession(threadId);
  }

  // Remove a thread's isolated worktree + branch and forget the session.
  // Refuses (keeping everything) when the worktree has uncommitted or unmerged
  // work, unless `force` is set. Returns null when the thread had no worktree.
  cleanupThreadWorktree(threadId: string, force = false): RemoveResult | null {
    const session = this.db.getThreadSession(threadId);
    if (!session || !session.isWorktree) return null;

    this.killProcess(threadId);

    const repoPath = mainRepoOf(session.workDir);
    if (!repoPath) {
      return { removed: false, reason: "could not locate the parent repo" };
    }

    const result = removeWorktree(repoPath, session.workDir, session.branch, force);
    if (result.removed) {
      this.db.deleteThreadSession(threadId);
      this.db.deleteScheduledTasksForThread(threadId);
    }
    return result;
  }

  private stopProcess(session: ActiveSession): void {
    if (session.stopping) return;
    session.stopping = true;
    try { session.process.kill("SIGTERM"); } catch {}
    session.killTimer = setTimeout(() => {
      try { session.process.kill("SIGKILL"); } catch {}
    }, SIGKILL_GRACE_MS);
  }

  // The outbox belongs to the THREAD, not to a single run, so a run that starts
  // while a previous one is still draining reuses the same ordered queue (its
  // messages land after the leftovers instead of interleaving with them).
  private getOutbox(threadId: string, thread: any): Outbox {
    let outbox = this.outboxes.get(threadId);
    if (!outbox) {
      outbox = new Outbox(thread);
      this.outboxes.set(threadId, outbox);
    } else {
      outbox.updateThread(thread);
    }
    return outbox;
  }

  // Typing is also thread-scoped: start() is idempotent, so an overlapping run
  // keeps the indicator running seamlessly.
  private getTyping(threadId: string, thread: any): TypingIndicator {
    let typing = this.typing.get(threadId);
    if (!typing) {
      typing = new TypingIndicator(thread);
      this.typing.set(threadId, typing);
    } else {
      typing.updateThread(thread);
    }
    return typing;
  }

  // Tear down per-thread delivery state once a thread is fully idle (process
  // closed AND outbox drained). Only the last/current session for the thread
  // calls this, so it won't clobber a newer run that has taken over.
  private releaseThread(threadId: string): void {
    this.active.delete(threadId);
    this.outboxes.delete(threadId);
    this.typing.get(threadId)?.stop();
    this.typing.delete(threadId);
    // Intentionally leave the "working" emoji in place when a turn finishes —
    // it marks the thread as in-progress until it's explicitly locked or closed.
    // Clearing it here would cost an extra rename against Discord's tight limit.
  }

  async runAgent(
    threadId: string,
    channelId: string,
    thread: any,
    agentKey: string,
    workDir: string,
    prompt: string,
    discordContext: DiscordContext | undefined,
    opts?: { branch?: string; isWorktree?: boolean; prNumber?: number; onDone?: (text: string) => void }
  ): Promise<void> {
    const agent = getAgent(agentKey);
    if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

    this.killProcess(threadId);

    const existing = this.db.getThreadSession(threadId);
    const mode = this.db.getMode(channelId);
    const model = this.db.getModel(channelId);
    const toolOverrides = this.db.getToolOverrides(channelId);

    const command = agent.buildCommand(workDir, prompt, {
      sessionId: existing?.sessionId,
      mode,
      model,
      discordContext,
      prNumber: opts?.prNumber,
    });

    console.log(`[${agentKey}] CMD: ${command}`);

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
      toolOverrides,
      outbox: this.getOutbox(threadId, thread),
      done: false,
      stopping: false,
      textOutput: "",
      onDone: opts?.onDone,
    };
    this.active.set(threadId, session);

    // Show "agent is typing…" right away — the agent is going to send messages —
    // and keep it alive until the thread is fully idle.
    this.getTyping(threadId, thread).start();

    // Mark the thread as "working". No-ops if it's already marked, so a run that
    // follows an earlier one in the same thread costs no rename. Fire-and-forget
    // so a (rate-limited) rename never delays the run itself.
    void setThreadStatus(thread, "working");

    if (!existing) {
      this.db.createThreadSession({
        threadId,
        channelId,
        agent: agentKey,
        workDir,
        branch: opts?.branch,
        isWorktree: !!opts?.isWorktree,
        createdAt: Date.now(),
      });
    }

    const timeout = setTimeout(() => {
      session.outbox.enqueue(() =>
        thread.send({ embeds: [embed("⏰ Timeout", "30 min limit reached.", 0xffd700)] })
      );
      this.stopProcess(session);
    }, TIMEOUT_MS);

    let buffer = "";

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        console.log(`[${agentKey}] RAW: ${line}`);
        const event = agent.parseLine(line, workDir);
        if (event) {
          try { this.handleEvent(threadId, event, session); }
          catch (err) { console.error(err); }
        }
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      console.error(`[${agentKey}] stderr:`, text);
      if (text && !text.includes("INFO") && !text.includes("DEBUG")) {
        session.outbox.enqueue(() =>
          thread.send({ embeds: [embed("⚠️ Warning", text.slice(0, 2000), 0xffa500)] })
        );
      }
    });

    proc.on("close", async (code) => {
      clearTimeout(timeout);
      if (session.killTimer) clearTimeout(session.killTimer);

      // Flush any trailing partial line the agent wrote without a newline.
      if (buffer.trim()) {
        const event = agent.parseLine(buffer, workDir);
        if (event) {
          try { this.handleEvent(threadId, event, session); }
          catch (err) { console.error(err); }
        }
        buffer = "";
      }

      // Only surface a failure if the agent didn't report a terminal event and
      // we didn't intentionally stop it (SIGTERM yields a non-zero/null code).
      if (code !== 0 && code !== null && !session.done && !session.stopping) {
        session.outbox.enqueue(() =>
          thread.send({ embeds: [embed("❌ Process Failed", `Exit code: ${code}`, 0xff0000)] })
        );
      }

      // Deliver everything already queued before marking the thread idle.
      await session.outbox.drain();
      // Guard against a newer run having replaced this session in the map.
      if (this.active.get(threadId) === session) this.releaseThread(threadId);
    });

    proc.on("error", async (err) => {
      clearTimeout(timeout);
      if (session.killTimer) clearTimeout(session.killTimer);
      session.outbox.enqueue(() =>
        thread.send({ embeds: [embed("❌ Process Error", err.message, 0xff0000)] })
      );
      await session.outbox.drain();
      if (this.active.get(threadId) === session) this.releaseThread(threadId);
    });
  }

  // Translates a parsed agent event into ordered outbox operations. This is
  // synchronous: it only enqueues work, it never awaits Discord, so stdout
  // parsing stays ahead and the outbox handles delivery + ordering + batching.
  private handleEvent(threadId: string, event: AgentEvent, session: ActiveSession): void {
    const { outbox, toolCalls, thread } = session;

    if (event.kind === "init") {
      this.db.updateSessionId(threadId, event.sessionId);
      outbox.enqueue(() =>
        thread.send({ embeds: [embed("🚀 Session started", `**Dir:** \`${event.cwd}\`\n**Model:** ${event.model}`, 0x00ff00)] })
      );
      return;
    }

    if (event.kind === "text") {
      session.textOutput += event.content;
      outbox.pushText(event.content);
      return;
    }

    if (event.kind === "tool_start") {
      // Skip hidden tools — we never create the embed, so the matching
      // tool_done no-ops (its toolCalls lookup misses).
      if (event.name && toolIsHidden(event.name, session.toolOverrides)) return;
      outbox.enqueue(async () => {
        const msg = await thread.send({ embeds: [new EmbedBuilder().setDescription(`⏳ ${event.label}`).setColor(0x0099ff)] });
        toolCalls.set(event.id, { message: msg });
      });
      return;
    }

    if (event.kind === "tool_done") {
      outbox.enqueue(async () => {
        const tracked = toolCalls.get(event.id);
        if (!tracked?.message) return;
        const current = tracked.message.embeds[0].data.description ?? "";
        const updated = current.replace("⏳", event.isError ? "❌" : "✅");
        await tracked.message.edit({
          embeds: [new EmbedBuilder().setDescription(`${updated}${event.preview ? `\n*${event.preview.slice(0, 100)}*` : ""}`).setColor(event.isError ? 0xff0000 : 0x00ff00)],
        });
      });
      return;
    }

    if (event.kind === "done") {
      session.done = true;
      const parts: string[] = [];
      if (event.turns !== null) parts.push(`${event.turns} turns`);
      if (event.cost !== null) parts.push(event.cost < 0.01 ? `${(event.cost * 100).toFixed(2)}¢` : `$${event.cost.toFixed(2)}`);
      if (event.tokens) parts.push(event.tokens);
      outbox.enqueue(() =>
        thread.send({ embeds: [embed("✅ Done", parts.length ? `*${parts.join(" · ")}*` : "Complete.", 0x00ff00)] })
      );
      if (session.onDone) {
        const cb = session.onDone;
        const text = session.textOutput;
        outbox.enqueue(async () => { try { cb(text); } catch {} });
      }
      this.stopProcess(session);
      return;
    }

    if (event.kind === "error") {
      session.done = true;
      outbox.enqueue(() =>
        thread.send({ embeds: [embed("❌ Failed", event.message, 0xff0000)] })
      );
      if (session.onDone) {
        const cb = session.onDone;
        const text = session.textOutput;
        outbox.enqueue(async () => { try { cb(text); } catch {} });
      }
      this.stopProcess(session);
      return;
    }

    // Internal SDK events with extra fields — handle here
    const raw = event as any;
    if (raw.kind === "_sdk_assistant") {
      this.db.updateSessionId(threadId, raw.sessionId);
      if (raw.content?.trim()) {
        session.textOutput += raw.content;
        outbox.pushText(raw.content);
      }
      for (const tool of (raw.tools ?? [])) {
        if (toolIsHidden(tool.name, session.toolOverrides)) continue;
        const label = formatToolCall(tool, session.workDir);
        outbox.enqueue(async () => {
          const msg = await thread.send({ embeds: [new EmbedBuilder().setDescription(`⏳ ${label}`).setColor(0x0099ff)] });
          toolCalls.set(tool.id, { message: msg });
        });
      }
    }
    if (raw.kind === "_sdk_tool_results") {
      for (const result of (raw.results ?? [])) {
        outbox.enqueue(async () => {
          const tracked = toolCalls.get(result.tool_use_id);
          if (!tracked?.message) return;
          const firstLine = toolResultText(result.content).split("\n")[0].trim().slice(0, 100);
          const current = tracked.message.embeds[0].data.description ?? "";
          const updated = current.replace("⏳", result.is_error ? "❌" : "✅");
          await tracked.message.edit({
            embeds: [new EmbedBuilder().setDescription(`${updated}${firstLine ? `\n*${firstLine}*` : ""}`).setColor(result.is_error ? 0xff0000 : 0x00ff00)],
          });
        });
      }
    }
  }

  destroy(): void {
    for (const [, session] of this.active) {
      if (session.killTimer) clearTimeout(session.killTimer);
      try { session.process.kill("SIGKILL"); } catch {}
    }
    for (const [, typing] of this.typing) typing.stop();
    this.active.clear();
    this.outboxes.clear();
    this.typing.clear();
  }
}

/**
 * Per-thread outbound message queue. Sends are serialized (preserving order and
 * applying natural backpressure against Discord's rate limit) and consecutive
 * text is coalesced into as few embeds as possible — but only when a backlog
 * actually forms, so light traffic still sends immediately.
 */
export class Outbox {
  private queue: OutItem[] = [];
  private running = false;
  private idleWaiters: Array<() => void> = [];

  constructor(private thread: any) {}

  // Point the outbox at the latest thread object when a new run reuses it.
  updateThread(thread: any): void { this.thread = thread; }

  private get busy(): boolean {
    return this.running || this.queue.length > 0;
  }

  // Append streamed text. Merges into a pending text item so a burst (or
  // everything that accumulates while an earlier send is in flight) goes out
  // as one message.
  pushText(content: string): void {
    if (!content) return;
    const last = this.queue[this.queue.length - 1];
    if (last && last.type === "text") last.content += content;
    else this.queue.push({ type: "text", content });
    void this.pump();
  }

  // Enqueue an ordered async send/edit. Any pending text already queued ahead
  // of it is delivered first, so message order matches agent output order.
  enqueue(run: () => Promise<unknown>): void {
    this.queue.push({ type: "op", run });
    void this.pump();
  }

  // Resolves once the queue is fully drained.
  drain(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          if (item.type === "text") await sendChunked(this.thread, item.content);
          else await item.run();
        } catch (err) {
          console.error("[outbox] send failed:", err);
        }
      }
    } finally {
      this.running = false;
    }
    // Items added during the final await are handled by re-pumping; only once
    // the queue is genuinely empty do we settle the idle waiters.
    if (this.queue.length > 0) { void this.pump(); return; }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}

type OutItem =
  | { type: "text"; content: string }
  | { type: "op"; run: () => Promise<unknown> };

/**
 * Keeps Discord's "<bot> is typing…" indicator alive in a thread while a run is
 * active. Discord's indicator expires after ~10s, so we re-trigger it on an
 * interval. start() is idempotent so overlapping runs don't stack timers.
 */
export class TypingIndicator {
  private timer?: ReturnType<typeof setInterval>;

  constructor(private thread: any, private intervalMs: number = TYPING_REFRESH_MS) {}

  updateThread(thread: any): void { this.thread = thread; }

  start(): void {
    if (this.timer) return;
    this.fire();
    this.timer = setInterval(() => this.fire(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private fire(): void {
    try {
      const p = this.thread?.sendTyping?.();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {}
  }
}

async function sendChunked(thread: any, content: string): Promise<void> {
  const text = formatForDiscord(content);
  if (!text) return;
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

// A tool_result's `content` is either a plain string or an array of content
// blocks (e.g. [{type:"text", text:"..."}]). MCP tools return the array form, so
// String(content) would render "[object Object]". Flatten to the text we can
// preview.
function toolResultText(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.type === "text" ? c.text ?? "" : ""))
      .filter(Boolean)
      .join(" ");
  }
  if (typeof content === "object" && content.type === "text") return content.text ?? "";
  return "";
}

function formatToolCall(tool: any, workDir: string): string {
  const clean = (v: string) => v.startsWith(workDir + "/") ? v.replace(workDir + "/", "./") : v === workDir ? "." : v;
  if (tool.name === "Bash" && tool.input?.command) return `🔧 **Bash**\n\`\`\`bash\n${clean(String(tool.input.command)).slice(0, 400)}\n\`\`\``;
  if (tool.name === "Read"  && tool.input?.file_path) return `🔧 **Read** \`${clean(String(tool.input.file_path))}\``;
  if (tool.name === "Edit"  && tool.input?.file_path) return `🔧 **Edit** \`${clean(String(tool.input.file_path))}\``;
  if (tool.name === "Write" && tool.input?.file_path) return `🔧 **Write** \`${clean(String(tool.input.file_path))}\``;
  if (tool.name === "Glob"  && tool.input?.pattern)   return `🔧 **Glob** \`${tool.input.pattern}\``;
  if (tool.name === "Grep"  && tool.input?.pattern)   return `🔧 **Grep** \`${tool.input.pattern}\``;
  const inputs = Object.entries(tool.input ?? {}).map(([k, v]) => `${escapeMd(k)}=\`${String(v).slice(0, 60)}\``).join(", ");
  return `🔧 **${escapeMd(tool.name)}**${inputs ? ` (${inputs})` : ""}`;
}

// Escape Discord markdown so tool names/keys with underscores or asterisks
// (e.g. mcp__discord-permissions__schedule_task) render literally instead of
// being interpreted as underline/bold/italic.
function escapeMd(text: string): string {
  return String(text).replace(/[\\_*~`|]/g, "\\$&");
}
