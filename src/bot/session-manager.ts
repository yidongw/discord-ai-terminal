import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { EmbedBuilder, type Client } from "discord.js";
import { formatForDiscord } from "../utils/discord-format.js";
import { getAgent, type AgentEvent, type AgentRunner } from "../agents/index.js";
import { DatabaseManager, toolIsHidden, type ActiveRun } from "../db/database.js";
import { mainRepoOf, removeWorktree, type RemoveResult } from "../utils/path-resolver.js";
import { setThreadStatus } from "../utils/thread-status.js";
import { escapeShellString, type DiscordContext } from "../utils/shell.js";
import { RunTailer, isPidAlive } from "./run-tailer.js";

// A side-effect to run when a run finishes (e.g. post a PR summary comment).
// Persisted in active_runs as JSON so it survives a bot restart, and dispatched
// at finalize from the FULL run text re-read off the log file. The actual work
// is done by a handler registered via setCompletionHandler (keeps this module
// free of any github/* dependency).
export type CompletionAction =
  | { kind: "pr_test"; repo: string; prNumber: number; agentKey: string }
  | { kind: "pr_fix"; repo: string; prNumber: number };

export type CompletionHandler = (action: CompletionAction, text: string) => Promise<void>;

const TIMEOUT_MS = 30 * 60 * 1000;
const MAX_EMBED = 4000;
// Grace period after SIGTERM before we escalate to SIGKILL. This keeps a
// runaway agent that ignores SIGTERM from streaming "already produced" output
// forever after a /stop.
const SIGKILL_GRACE_MS = 3000;
// Discord's typing indicator lasts ~10s; refresh a little sooner so it stays
// visible continuously while a run is active or its outbox is still draining.
const TYPING_REFRESH_MS = 8000;
// On graceful shutdown, how long we wait for outboxes to deliver already-parsed
// output before exiting. Kept under launchd's restart grace so the agents (which
// we deliberately leave running) are re-attached cleanly on the next boot.
const SHUTDOWN_DRAIN_MS = 4000;

interface ActiveSession {
  // Identity of the detached run this session is streaming. The run survives a
  // bot restart; `runId`/`pid`/`logPath` are what we persist and re-attach to.
  runId: string;
  pid: number;
  logPath: string;
  agentKey: string;
  channelId: string;
  startedAt: number;
  // Present only for runs THIS bot spawned (gives us the exit code). A
  // re-attached run has no handle — we watch its PID instead.
  proc?: ChildProcess;
  exited: boolean;
  exitCode?: number | null;
  tailer?: RunTailer;
  timeout?: ReturnType<typeof setTimeout>;
  finalized: boolean;
  thread: any;
  toolCalls: Map<string, { message: any }>;
  // Tool-use ids we deliberately hid (Bash/Read/Edit by default). Their
  // tool_done / tool_result events are dropped without enqueuing anything, so a
  // hidden tool's result can't seal the running "N hidden" summary embed.
  hiddenToolIds: Set<string>;
  workDir: string;
  // Per-channel tool-message visibility overrides ({ toolName: hidden }); see
  // toolIsHidden() and DEFAULT_HIDDEN_TOOLS.
  toolOverrides: Record<string, boolean>;
  outbox: Outbox;
  done: boolean;
  stopping: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  // Action to dispatch when the run finishes (e.g. post a PR summary). The text
  // it needs is re-read from the log at finalize, so it works after a restart.
  completion?: CompletionAction;
}

export class SessionManager {
  private db: DatabaseManager;
  private active = new Map<string, ActiveSession>();
  // Delivery state keyed by thread, persisted ACROSS runs so overlapping runs
  // (e.g. a new run starting while a previous one is still draining) share a
  // single ordered queue and a single typing indicator instead of racing.
  private outboxes = new Map<string, Outbox>();
  private typing = new Map<string, TypingIndicator>();
  // Where detached runs write their append-only output logs (one per run). The
  // bot tails these and re-attaches to them after a restart.
  private runsDir: string;
  // Dispatches a run's CompletionAction (registered by index.ts; only set when
  // the GitHub integration is enabled).
  private completionHandler?: CompletionHandler;

  constructor() {
    this.db = new DatabaseManager();
    this.db.cleanupOldThreadSessions();
    this.runsDir = path.join(process.cwd(), "runs");
    try { fs.mkdirSync(this.runsDir, { recursive: true }); } catch {}
    this.cleanupOrphanLogs();
  }

  getDb() { return this.db; }

  setCompletionHandler(handler: CompletionHandler): void {
    this.completionHandler = handler;
  }

  // A thread is "active" while its run is in flight OR its outbox still has
  // queued/in-flight messages. We check the in-memory map AND the persisted
  // active_runs table — the latter covers the window on startup after a restart,
  // before reattachRuns() has wired the tailer back up, so an incoming message
  // or scheduler tick can't double-spawn onto a thread that already has a live
  // detached run.
  hasActiveProcess(threadId: string) {
    return this.active.has(threadId) || this.db.hasActiveRun(threadId);
  }

  // Delete leftover .jsonl logs whose run already finalized (but whose unlink
  // failed), while preserving logs for runs we still need to re-attach to.
  private cleanupOrphanLogs(): void {
    let files: string[];
    try { files = fs.readdirSync(this.runsDir); } catch { return; }
    const keep = new Set(this.db.listActiveRuns().map((r) => path.basename(r.logPath)));
    for (const f of files) {
      if (!f.endsWith(".jsonl") || keep.has(f)) continue;
      try { fs.unlinkSync(path.join(this.runsDir, f)); } catch {}
    }
  }

  private removeLog(logPath: string): void {
    try { fs.unlinkSync(logPath); } catch {}
  }

  // Signal a detached run's whole process group (the bash wrapper AND the
  // claude/codex child). `detached: true` makes the bash PID a group leader, so
  // a negative PID reaches the group; fall back to the bare PID if that fails.
  private signalGroup(pid: number, sig: NodeJS.Signals): void {
    try { process.kill(-pid, sig); }
    catch {
      try { process.kill(pid, sig); } catch {}
    }
  }

  // Graceful stop: signal the agent to stop producing NEW output, but let the
  // outbox keep delivering whatever it already produced. The close handler
  // drains the outbox and removes the session once delivery finishes.
  killProcess(threadId: string): void {
    const session = this.active.get(threadId);
    if (session) this.stopProcess(session);
    // Drop any persisted run row for this thread that we have NOT re-attached
    // (e.g. a dead run from before a restart). For an in-memory session the
    // tailer's finalize also deletes it; deleting here too is idempotent.
    this.db.deleteActiveRunsForThread(threadId);
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

  // Graceful stop: signal the run's process group to stop. The tailer notices
  // the process is gone, drains whatever it already wrote, and finalizes (which
  // deletes the active_runs row, removes the log, and releases the thread).
  private stopProcess(session: ActiveSession): void {
    if (session.stopping) return;
    session.stopping = true;
    this.signalGroup(session.pid, "SIGTERM");
    session.killTimer = setTimeout(() => {
      this.signalGroup(session.pid, "SIGKILL");
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
    opts?: { branch?: string; isWorktree?: boolean; prNumber?: number; completion?: CompletionAction }
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

    // Per-run append-only log. The agent writes here (not to a pipe we own), so
    // it keeps streaming after a bot restart and a future bot can re-attach by
    // tailing this file from the persisted offset.
    const runId = `${threadId}-${Date.now()}`;
    const logPath = path.join(this.runsDir, `${runId}.jsonl`);
    // Redirect at the shell. Bun's child_process can't reliably pass a raw fd via
    // `stdio`, and we already launch through bash — so bash owns the fd and keeps
    // it open after we exit. stderr is merged in (non-JSON lines just fail to
    // parse and are ignored).
    const fullCommand = `(${command}) >> ${escapeShellString(logPath)} 2>&1`;

    console.log(`[${agentKey}] CMD: ${command}`);
    console.log(`[${agentKey}] LOG: ${logPath}`);

    // `detached: true` puts the run in its own process group/session so killing
    // the bot job (launchctl kickstart -k) doesn't take it down; unref() so it
    // doesn't keep the bot's event loop alive.
    const proc = spawn("/bin/bash", ["-c", fullCommand], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, SHELL: "/bin/bash" },
    });
    proc.unref();

    const pid = proc.pid ?? -1;
    const startedAt = Date.now();

    // Replace any stale run row for this thread BEFORE recording the new one, so
    // a restart never re-attaches to two runs for the same thread.
    this.db.deleteActiveRunsForThread(threadId);
    this.db.createActiveRun({
      runId, threadId, channelId, agent: agentKey, workDir, pid, logPath,
      stdoutOffset: 0, startedAt,
      completionJson: opts?.completion ? JSON.stringify(opts.completion) : undefined,
    });

    const session: ActiveSession = {
      runId,
      pid,
      logPath,
      agentKey,
      channelId,
      startedAt,
      proc,
      exited: false,
      exitCode: null,
      finalized: false,
      thread,
      toolCalls: new Map(),
      hiddenToolIds: new Set(),
      workDir,
      toolOverrides,
      outbox: this.getOutbox(threadId, thread),
      done: false,
      stopping: false,
      completion: opts?.completion,
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

    // Capture the exit code so the tailer can surface an abnormal exit. (A
    // re-attached run has no handle, so it relies on the agent's own done/error
    // event instead — see finalizeRun.)
    proc.on("exit", (code) => { session.exited = true; session.exitCode = code; });
    proc.on("error", (err) => {
      session.exited = true;
      session.outbox.enqueue(() =>
        thread.send({ embeds: [embed("❌ Process Error", err.message, 0xff0000)] })
      );
    });

    session.timeout = setTimeout(() => {
      session.outbox.enqueue(() =>
        thread.send({ embeds: [embed("⏰ Timeout", "30 min limit reached.", 0xffd700)] })
      );
      this.stopProcess(session);
    }, TIMEOUT_MS);

    this.startTailer(threadId, session, agent, 0, () => !session.exited);
  }

  // Stream a run's output by tailing its log file and feeding each complete line
  // through the same parse → handleEvent → outbox pipeline the old stdout handler
  // used. This is the single code path for both fresh runs and re-attached ones.
  private startTailer(
    threadId: string,
    session: ActiveSession,
    agent: AgentRunner,
    startOffset: number,
    isAlive: () => boolean
  ): void {
    const tailer = new RunTailer({
      logPath: session.logPath,
      startOffset,
      isAlive,
      onLine: (line) => {
        const event = agent.parseLine(line, session.workDir);
        if (event) {
          try { this.handleEvent(threadId, event, session); }
          catch (err) { console.error(err); }
        }
      },
      onOffset: (offset) => {
        try { this.db.updateActiveRunOffset(session.runId, offset); } catch {}
      },
      onFinalize: () => this.finalizeRun(threadId, session),
    });
    session.tailer = tailer;
    tailer.start();
  }

  // Run the end-of-life logic once the agent process is gone and its output is
  // fully drained: surface an abnormal exit, deliver everything queued, then drop
  // the persisted run + log and release the thread.
  private async finalizeRun(threadId: string, session: ActiveSession): Promise<void> {
    if (session.finalized) return;
    session.finalized = true;
    if (session.timeout) clearTimeout(session.timeout);
    if (session.killTimer) clearTimeout(session.killTimer);

    // Only for fresh runs (exitCode known): surface a crash the agent didn't
    // report and we didn't intentionally stop. A SIGTERM/SIGKILL yields a null
    // code, so an intentional /stop or timeout won't trip this.
    const code = session.exitCode;
    if (code !== undefined && code !== null && code !== 0 && !session.done && !session.stopping) {
      session.outbox.enqueue(() =>
        session.thread.send({ embeds: [embed("❌ Process Failed", `Exit code: ${code}`, 0xff0000)] })
      );
    }

    // Deliver everything already queued before marking the thread idle.
    await session.outbox.drain();

    // Run the completion action (e.g. post a PR summary). We re-read the FULL run
    // text from the log here rather than accumulating it in memory, so it's the
    // complete output regardless of how far a restart made us resume — and it
    // fires whether the run finished before or after the restart. Must happen
    // before we remove the log.
    if (session.completion && this.completionHandler) {
      const { text, completed } = this.extractRunResult(session);
      if (completed) {
        try { await this.completionHandler(session.completion, text); }
        catch (err) { console.error(`[completion] ${session.completion.kind} failed:`, err); }
      }
    }

    this.db.deleteActiveRun(session.runId);
    this.removeLog(session.logPath);

    // Guard against a newer run having replaced this session in the map.
    if (this.active.get(threadId) === session) this.releaseThread(threadId);
  }

  // Re-parse a run's whole log to recover its full assistant text and whether it
  // reached a terminal (done/error) event. Used to dispatch completion actions
  // with the complete output, independent of the streaming resume offset.
  private extractRunResult(session: ActiveSession): { text: string; completed: boolean } {
    const agent = getAgent(session.agentKey);
    if (!agent) return { text: "", completed: false };
    let raw: string;
    try { raw = fs.readFileSync(session.logPath, "utf8"); }
    catch { return { text: "", completed: false }; }

    let text = "";
    let completed = false;
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const event = agent.parseLine(t, session.workDir) as any;
      if (!event) continue;
      if (event.kind === "text") text += event.content;
      else if (event.kind === "_sdk_assistant" && event.content) text += event.content;
      else if (event.kind === "done" || event.kind === "error") completed = true;
    }
    return { text, completed };
  }

  // On startup, re-attach to every run that was in flight when the bot last
  // exited. Detached agents keep running across a restart; here we re-open their
  // logs and resume streaming from the persisted offset. A run whose thread is
  // gone, or whose process already exited while we were down, is finalized.
  //
  // MUST run before the scheduler starts and before incoming messages can spawn
  // new runs (see index.ts) — hasActiveProcess() already guards via the DB rows,
  // but sequencing keeps the window tight.
  async reattachRuns(client: Client): Promise<void> {
    const runs = this.db.listActiveRuns();
    if (runs.length === 0) return;
    console.log(`[reattach] re-attaching to ${runs.length} in-flight run(s)`);
    for (const run of runs) {
      try {
        await this.reattachOne(client, run);
      } catch (err) {
        console.error(`[reattach] run ${run.runId} failed:`, err);
      }
    }
  }

  private async reattachOne(client: Client, run: ActiveRun): Promise<void> {
    const agent = getAgent(run.agent);
    if (!agent) {
      this.db.deleteActiveRun(run.runId);
      this.removeLog(run.logPath);
      return;
    }

    let thread: any;
    try {
      thread = await client.channels.fetch(run.threadId);
    } catch (err: any) {
      // 10003 = Unknown Channel → the thread is gone for good.
      if (err?.code === 10003) {
        this.db.deleteActiveRun(run.runId);
        this.removeLog(run.logPath);
        return;
      }
      throw err; // transient — leave the row so a later boot can retry.
    }
    if (!thread) {
      this.db.deleteActiveRun(run.runId);
      this.removeLog(run.logPath);
      return;
    }

    const alive = isPidAlive(run.pid);
    const session: ActiveSession = {
      runId: run.runId,
      pid: run.pid,
      logPath: run.logPath,
      agentKey: run.agent,
      channelId: run.channelId,
      startedAt: run.startedAt,
      proc: undefined,
      exited: !alive,
      exitCode: undefined, // unknown for a re-attached run
      finalized: false,
      thread,
      toolCalls: new Map(),
      hiddenToolIds: new Set(),
      workDir: run.workDir,
      toolOverrides: this.db.getToolOverrides(run.channelId),
      outbox: this.getOutbox(run.threadId, thread),
      done: false,
      stopping: false,
      // The completion action was persisted, so a PR run that survives a restart
      // still posts its summary comment when it finishes — see finalizeRun.
      completion: parseCompletion(run.completionJson),
    };
    this.active.set(run.threadId, session);
    this.getTyping(run.threadId, thread).start();

    if (alive) {
      // Re-arm the timeout relative to the original start.
      const remaining = run.startedAt + TIMEOUT_MS - Date.now();
      const fire = () => {
        session.outbox.enqueue(() =>
          thread.send({ embeds: [embed("⏰ Timeout", "30 min limit reached.", 0xffd700)] })
        );
        this.stopProcess(session);
      };
      if (remaining <= 0) fire();
      else session.timeout = setTimeout(fire, remaining);
      console.log(`[reattach] ${run.runId} alive (pid ${run.pid}); resuming at offset ${run.stdoutOffset}`);
    } else {
      console.log(`[reattach] ${run.runId} already exited; draining remaining output`);
    }

    this.startTailer(run.threadId, session, agent, run.stdoutOffset, () => isPidAlive(run.pid));
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
      outbox.pushText(event.content);
      return;
    }

    if (event.kind === "tool_start") {
      // Hidden tools don't get their own embed; instead they bump the running
      // "N hidden" summary. Remember the id so the matching tool_done is dropped
      // (it must not seal the summary).
      if (event.name && toolIsHidden(event.name, session.toolOverrides)) {
        session.hiddenToolIds.add(event.id);
        outbox.pushHiddenTool(event.name);
        return;
      }
      outbox.enqueue(async () => {
        const msg = await thread.send({ embeds: [new EmbedBuilder().setDescription(`⏳ ${event.label}`).setColor(0x0099ff)] });
        toolCalls.set(event.id, { message: msg });
      });
      return;
    }

    if (event.kind === "tool_done") {
      // Hidden tool → no embed to update, and we must not enqueue anything that
      // would seal the running summary.
      if (session.hiddenToolIds.has(event.id)) return;
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
      // The completion action (if any) runs at finalize, from the full log text.
      this.stopProcess(session);
      return;
    }

    if (event.kind === "error") {
      session.done = true;
      outbox.enqueue(() =>
        thread.send({ embeds: [embed("❌ Failed", event.message, 0xff0000)] })
      );
      this.stopProcess(session);
      return;
    }

    // Internal SDK events with extra fields — handle here
    const raw = event as any;
    if (raw.kind === "_sdk_assistant") {
      this.db.updateSessionId(threadId, raw.sessionId);
      if (raw.content?.trim()) {
        outbox.pushText(raw.content);
      }
      for (const tool of (raw.tools ?? [])) {
        if (toolIsHidden(tool.name, session.toolOverrides)) {
          session.hiddenToolIds.add(tool.id);
          outbox.pushHiddenTool(tool.name);
          continue;
        }
        const label = formatToolCall(tool, session.workDir);
        outbox.enqueue(async () => {
          const msg = await thread.send({ embeds: [new EmbedBuilder().setDescription(`⏳ ${label}`).setColor(0x0099ff)] });
          toolCalls.set(tool.id, { message: msg });
        });
      }
    }
    if (raw.kind === "_sdk_tool_results") {
      for (const result of (raw.results ?? [])) {
        // Drop results for hidden tools entirely — enqueuing a no-op op would
        // seal the running summary between two batches of hidden calls.
        if (session.hiddenToolIds.has(result.tool_use_id)) continue;
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

  // Graceful shutdown that PRESERVES running agents. Stop the tailers (each does
  // a final drain + offset flush + fd close), deliver whatever is already queued,
  // then return so the process can exit. The detached agents keep running and the
  // active_runs rows persist, so the next boot re-attaches via reattachRuns().
  async detachAndExit(): Promise<void> {
    for (const [, session] of this.active) {
      if (session.timeout) clearTimeout(session.timeout);
      if (session.killTimer) clearTimeout(session.killTimer);
      try { session.tailer?.stop(); } catch {}
    }
    const drains = Array.from(this.outboxes.values()).map((o) => o.drain());
    await Promise.race([
      Promise.all(drains),
      new Promise<void>((res) => setTimeout(res, SHUTDOWN_DRAIN_MS)),
    ]);
    for (const [, typing] of this.typing) typing.stop();
  }

  // Hard teardown: SIGKILL every run's process group and clear all state. Used by
  // tests; the live bot uses detachAndExit() so runs survive restarts.
  killAll(): void {
    for (const [, session] of this.active) {
      if (session.timeout) clearTimeout(session.timeout);
      if (session.killTimer) clearTimeout(session.killTimer);
      try { session.tailer?.stop(); } catch {}
      this.signalGroup(session.pid, "SIGKILL");
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
  // The live "N hidden" summary embed and its accumulated per-tool counts. While
  // open, consecutive hidden tool calls edit this one message; the next visible
  // message (text, a shown tool, a status embed) seals it, so the following
  // hidden run starts a fresh summary in the correct stream position.
  private hiddenMessage: any = null;
  private hiddenCounts: Map<string, number> | null = null;

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

  // Record one hidden tool call. Consecutive hidden calls coalesce into a single
  // queued item (and ultimately a single edited summary embed) the same way text
  // does; a visible message between them seals the summary and resets the count.
  pushHiddenTool(name: string): void {
    if (!name) return;
    const last = this.queue[this.queue.length - 1];
    if (last && last.type === "hidden") last.counts.set(name, (last.counts.get(name) ?? 0) + 1);
    else this.queue.push({ type: "hidden", counts: new Map([[name, 1]]) });
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
          if (item.type === "hidden") {
            await this.flushHidden(item.counts);
          } else {
            // Any visible message ends the current hidden run: drop the summary
            // reference so the next hidden tool opens a new embed below this one.
            this.sealHidden();
            if (item.type === "text") await sendChunked(this.thread, item.content);
            else await item.run();
          }
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

  // Close the current hidden-tool summary so the next hidden call starts a fresh
  // embed. The already-sent message keeps its final count.
  private sealHidden(): void {
    this.hiddenMessage = null;
    this.hiddenCounts = null;
  }

  // Create the summary embed for the first hidden call in a run, or merge the new
  // counts into the open one and edit it in place.
  private async flushHidden(counts: Map<string, number>): Promise<void> {
    if (!this.hiddenMessage) {
      this.hiddenCounts = new Map(counts);
      this.hiddenMessage = await this.thread.send({ embeds: [hiddenEmbed(this.hiddenCounts)] });
      return;
    }
    for (const [name, n] of counts) this.hiddenCounts!.set(name, (this.hiddenCounts!.get(name) ?? 0) + n);
    await this.hiddenMessage.edit({ embeds: [hiddenEmbed(this.hiddenCounts!)] });
  }
}

type OutItem =
  | { type: "text"; content: string }
  | { type: "op"; run: () => Promise<unknown> }
  | { type: "hidden"; counts: Map<string, number> };

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

// The collapsed summary embed for a run of hidden tool calls, e.g.
// "🙈 10 Bash, 3 Edit messages hidden". Muted color so it reads as a marker
// rather than real output.
function hiddenEmbed(counts: Map<string, number>) {
  return new EmbedBuilder().setDescription(hiddenSummaryText(counts)).setColor(0x99aab5);
}

function hiddenSummaryText(counts: Map<string, number>): string {
  const parts = [...counts.entries()].map(([name, n]) => `${n} ${escapeMd(name)}`);
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return `🙈 ${parts.join(", ")} ${total === 1 ? "message" : "messages"} hidden`;
}

// Parse a persisted CompletionAction back from its JSON, tolerating null/garbage.
function parseCompletion(json?: string): CompletionAction | undefined {
  if (!json) return undefined;
  try { return JSON.parse(json) as CompletionAction; }
  catch { return undefined; }
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
