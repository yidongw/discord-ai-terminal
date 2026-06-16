import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AttachmentBuilder, EmbedBuilder, type Client } from "discord.js";
import { formatForDiscord } from "../utils/discord-format.js";
import { getAgent, type AgentEvent, type AgentRunner } from "../agents/index.js";
import { DatabaseManager, toolIsHidden, type ActiveRun } from "../db/database.js";
import { mainRepoOf, removeWorktree, type RemoveResult } from "../utils/path-resolver.js";
import { setThreadStatus } from "../utils/thread-status.js";
import { escapeShellString, type DiscordContext } from "../utils/shell.js";
import { RunTailer, isPidAlive } from "./run-tailer.js";
import { parseSessionLimitReset } from "../utils/session-limit-reset.js";
import {
  SESSION_LIMIT_CONTINUATION_PROMPT,
  registerSessionLimitWakeup,
} from "./session-limit-wakeup.js";
import {
  extractGeneratedImagePath,
  extractLocalImageReferences,
  normalizeImagePathKey,
  tryClaimImageSend,
  getToolInputPath,
  isImageType,
  stripLocalImageReferences,
} from "../utils/attachments.js";
import { getChannelModelForAgent, resolveResumeSessionId } from "../utils/models.js";

// A side-effect to run when a run finishes (e.g. post a PR summary comment).
// Persisted in active_runs as JSON so it survives a bot restart, and dispatched
// at finalize from the FULL run text re-read off the log file. The actual work
// is done by a handler registered via setCompletionHandler (keeps this module
// free of any github/* dependency).

// A user message queued to run after the current agent finishes.
export interface QueuedMessage {
  prompt: string;
  originalText: string;
  discordContext: DiscordContext;
  agentKey: string;
  workDir: string;
  channelId: string;
  thread: any;
}

export type CompletionAction =
  | { kind: "pr_test"; repo: string; prNumber: number; agentKey: string };

export type CompletionHandler = (action: CompletionAction, text: string) => Promise<void>;

// Called after every session ends (branch-based worktrees only). Used to detect
// PRs created during the session when the GitHub webhook was missed.
export type SessionFinalizeCallback = (threadId: string, workDir: string, branch: string) => Promise<void>;

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
  finalized: boolean;
  thread: any;
  toolCalls: Map<string, { message: any }>;
  // Tool-use ids we deliberately hid (Bash/Read/Edit by default). Their
  // tool_done / tool_result events are dropped without enqueuing anything, so a
  // hidden tool's result can't seal the running "N hidden" summary embed.
  hiddenToolIds: Set<string>;
  // GenerateImage tool-use ids — image is sent from the tool result, not at call time.
  generateImageToolIds: Set<string>;
  // Generated image call ids already uploaded from Codex image events.
  sentGeneratedImageCallIds: Set<string>;
  // Normalized local image paths already sent (or queued) this run.
  sentImagePaths: Set<string>;
  // Read tool-use ids where the target was an image file. Like generateImageToolIds,
  // we defer sending until the tool result so we can use the base64 data directly
  // rather than re-reading from disk (which fails when the filename has non-ASCII
  // whitespace like U+202F that gets normalized to U+0020 in the tool input JSON).
  pendingImageReadIds: Map<string, string>; // tool_id → file_path fallback
  // Live task list built from TaskCreate/TaskUpdate calls, keyed by task ID.
  taskList: Map<number, { subject: string; status: string }>;
  workDir: string;
  // Model passed to the CLI for this run (from channel settings at start time).
  requestedModel: string;
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
  // Discord context from the run that started this session — reused when cc auto-
  // resumes after hitting a limit.
  discordContext?: DiscordContext;
  // Subscription usage limit ("resets 3:45pm") — scheduler wakes cc at reset time.
  pendingUsageLimitResume?: boolean;
  usageLimitResetAt?: number;
  usageLimitResetLabel?: string;
  usageLimitNoticeSent?: boolean;
  // Per-run turn cap (error_max_turns) — immediate --resume when no usage limit.
  pendingTurnLimitResume?: boolean;
  // Non-JSON lines from the agent's output (stderr merged in). Capped at 20 lines
  // so we have context when an error event arrives with no detail of its own.
  nonJsonOutput: string[];
  // True when this run used --resume (session already existed). Lets the error
  // handler give a more useful message when the resume itself fails.
  wasResume: boolean;
}

export class SessionManager {
  private db: DatabaseManager;
  private active = new Map<string, ActiveSession>();
  // Delivery state keyed by thread, persisted ACROSS runs so overlapping runs
  // (e.g. a new run starting while a previous one is still draining) share a
  // single ordered queue and a single typing indicator instead of racing.
  private outboxes = new Map<string, Outbox>();
  private typing = new Map<string, TypingIndicator>();
  // Prompt queued to run once a thread's current run finishes (e.g. a CI fix
  // request that arrived while the agent was busy). At most one pending prompt
  // per thread — a newer failure overwrites the old one.
  private pendingPostRunPrompts = new Map<string, string>();
  // User messages queued while an agent was running (FIFO). Multiple messages
  // may be queued; each is dispatched in order once the thread becomes idle.
  private messageQueues = new Map<string, QueuedMessage[]>();
  // Where detached runs write their append-only output logs (one per run). The
  // bot tails these and re-attaches to them after a restart.
  private runsDir: string;
  // Dispatches a run's CompletionAction (registered by index.ts; only set when
  // the GitHub integration is enabled).
  private completionHandler?: CompletionHandler;
  private sessionFinalizeHandler?: SessionFinalizeCallback;

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

  setSessionFinalizeHandler(cb: SessionFinalizeCallback): void {
    this.sessionFinalizeHandler = cb;
  }

  // Queue a prompt to run in a thread once its current run finishes. If the
  // thread is already idle, the caller should invoke runAgent directly instead.
  // A newer call overwrites any previously queued prompt for the same thread.
  setPendingPostRunPrompt(threadId: string, prompt: string): void {
    this.pendingPostRunPrompts.set(threadId, prompt);
  }

  // Append a user-initiated message to the per-thread FIFO queue.
  enqueueMessage(threadId: string, msg: QueuedMessage): void {
    const queue = this.messageQueues.get(threadId) ?? [];
    queue.push(msg);
    this.messageQueues.set(threadId, queue);
  }

  // Pop the next queued user message for a thread, or undefined if empty.
  dequeueMessage(threadId: string): QueuedMessage | undefined {
    const queue = this.messageQueues.get(threadId);
    if (!queue || queue.length === 0) return undefined;
    const msg = queue.shift()!;
    if (queue.length === 0) this.messageQueues.delete(threadId);
    return msg;
  }

  // Number of user messages waiting in the queue for a thread.
  getQueueLength(threadId: string): number {
    return this.messageQueues.get(threadId)?.length ?? 0;
  }

  // Resolves once the thread's agent process has finished and its outbox is drained.
  async waitForIdle(threadId: string): Promise<void> {
    while (this.hasActiveProcess(threadId)) {
      await new Promise<void>((r) => setTimeout(r, 200));
    }
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
    this.messageQueues.delete(threadId);
  }

  // Remove a thread's isolated worktree + branch and forget the session.
  // Refuses (keeping everything) when the worktree has uncommitted or unmerged
  // work, unless `force` is set. Returns null when the thread had no worktree.
  // Pass keepSession=true to preserve the DB session (e.g. auto-archive) so the
  // thread can be resumed later; false (default) deletes it permanently.
  cleanupThreadWorktree(threadId: string, force = false, keepSession = false): RemoveResult | null {
    const session = this.db.getThreadSession(threadId);
    if (!session || !session.isWorktree) return null;

    this.killProcess(threadId);

    // Worktree already gone — treat as removed without touching the session.
    if (!fs.existsSync(session.workDir)) {
      return { removed: true };
    }

    const repoPath = mainRepoOf(session.workDir);
    if (!repoPath) {
      return { removed: false, reason: "could not locate the parent repo" };
    }

    const result = removeWorktree(repoPath, session.workDir, session.branch, force);
    if (result.removed) {
      if (!keepSession) {
        this.db.deleteThreadSession(threadId);
      }
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
    const onLocalImageReference = (filePath: string) => {
      const callId = generatedImageCallIdFromPath(filePath);
      if (!callId) return;
      this.active.get(threadId)?.sentGeneratedImageCallIds.add(callId);
    };
    const claimImagePath = (filePath: string) => {
      const session = this.active.get(threadId);
      if (!session) return true;
      return tryClaimImageSend(session.sentImagePaths, filePath);
    };
    if (!outbox) {
      outbox = new Outbox(thread, onLocalImageReference, claimImagePath);
      this.outboxes.set(threadId, outbox);
    } else {
      outbox.updateThread(thread, onLocalImageReference, claimImagePath);
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
    opts?: { branch?: string; isWorktree?: boolean; prNumber?: number; completion?: CompletionAction; modelOverride?: string }
  ): Promise<void> {
    const agent = getAgent(agentKey);
    if (!agent) throw new Error(`Unknown agent: ${agentKey}`);

    this.killProcess(threadId);

    let existing = this.db.getThreadSession(threadId);
    const mode = this.db.getMode(channelId);
    const channelDefault = getChannelModelForAgent(this.db, agentKey, channelId);
    let model = this.db.getModel(channelId);
    let codexModel = this.db.getCodexModel(channelId);
    let csModel = this.db.getCsModel(channelId);
    // @mention wins, then thread /model override, then channel default. Freeze the
    // inherited default into the thread so a later channel /model doesn't switch
    // threads that never set their own override.
    let effectiveModelOverride = opts?.modelOverride ?? existing?.modelOverride;
    if (effectiveModelOverride === undefined) {
      effectiveModelOverride = channelDefault;
      if (existing?.modelOverride === undefined) {
        this.db.updateModelOverride(threadId, channelDefault);
        if (existing) existing = { ...existing, modelOverride: channelDefault, sessionId: undefined };
      }
    } else if (existing && effectiveModelOverride !== existing.modelOverride) {
      this.db.updateModelOverride(threadId, effectiveModelOverride);
      existing = { ...existing, modelOverride: effectiveModelOverride, sessionId: undefined };
    }
    if (effectiveModelOverride) {
      if (agentKey === "cx") codexModel = effectiveModelOverride as typeof codexModel;
      else if (agentKey === "cs") csModel = effectiveModelOverride as typeof csModel;
      else model = effectiveModelOverride as typeof model;
    }
    const requestedModel = agentKey === "cx" ? codexModel : agentKey === "cs" ? csModel : model;
    const toolOverrides = this.db.getToolOverrides(channelId);

    // Resuming keeps the prior model — only resume when the agent type matches
    // and the requested model is unchanged from the last run.
    const resumeSessionId = resolveResumeSessionId(existing, agentKey, requestedModel);
    const command = agent.buildCommand(workDir, prompt, {
      sessionId: resumeSessionId,
      mode,
      model,
      codexModel,
      csModel,
      discordContext,
      prNumber: opts?.prNumber,
    });

    // Per-run append-only log. The agent writes here (not to a pipe we own), so
    // it keeps streaming after a bot restart and a future bot can re-attach by
    // tailing this file from the persisted offset.
    const runId = `${threadId}-${Date.now()}`;
    const logPath = path.join(this.runsDir, `${runId}.jsonl`);
    // Pre-create the (empty) log so the tailer can open it right away — the
    // detached child won't have created the redirect target yet when we start
    // tailing in this same tick. bash's `>>` then appends to it.
    try { fs.closeSync(fs.openSync(logPath, "a")); } catch {}
    // Redirect at the shell. Bun's child_process can't reliably pass a raw fd via
    // `stdio`, and we already launch through bash — so bash owns the fd and keeps
    // it open after we exit. stderr is merged in (non-JSON lines just fail to
    // parse and are ignored).
    const fullCommand = `(${command}) >> ${escapeShellString(logPath)} 2>&1`;

    console.log(`[${agentKey}] CMD: ${command}`);
    console.log(`[${agentKey}] model: ${requestedModel}`);
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
      generateImageToolIds: new Set(),
      sentGeneratedImageCallIds: new Set(listCodexGeneratedImageIds(resumeSessionId)),
      sentImagePaths: new Set(
        listNewCodexGeneratedImages(resumeSessionId, new Set()).map((p) => normalizeImagePathKey(p))
      ),
      pendingImageReadIds: new Map(),
      taskList: new Map(),
      workDir,
      requestedModel,
      toolOverrides,
      outbox: this.getOutbox(threadId, thread),
      done: false,
      stopping: false,
      completion: opts?.completion,
      discordContext,
      nonJsonOutput: [],
      wasResume: !!resumeSessionId,
    };
    this.active.set(threadId, session);

    // Show "agent is typing…" right away — the agent is going to send messages —
    // and keep it alive until the thread is fully idle.
    this.getTyping(threadId, thread).start();

    // Mark the thread as "working". No-ops if it's already marked, so a run that
    // follows an earlier one in the same thread costs no rename. Fire-and-forget
    // so a (rate-limited) rename never delays the run itself.
    void setThreadStatus(thread, "working");

    if (!existing || existing.agent !== agentKey) {
      this.db.createThreadSession({
        threadId,
        channelId,
        agent: agentKey,
        workDir,
        branch: opts?.branch ?? existing?.branch,
        isWorktree: opts?.isWorktree ?? existing?.isWorktree ?? false,
        createdAt: existing?.createdAt ?? Date.now(),
        modelOverride: effectiveModelOverride,
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
        const event = agent.parseLine(line, session.workDir, {
          requestedModel: session.requestedModel,
          sessionId: this.db.getThreadSession(threadId)?.sessionId,
        });
        if (event) {
          try { this.handleEvent(threadId, event, session); }
          catch (err) { console.error(err); }
        } else {
          // Non-JSON line (e.g. stderr from the agent). Keep the last 20 so we
          // have context when an error event arrives with no detail of its own.
          session.nonJsonOutput.push(line);
          if (session.nonJsonOutput.length > 20) session.nonJsonOutput.shift();
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

    this.enqueueDiscoveredCodexImages(threadId, session);

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

    // Catch PRs created during the session when the GitHub webhook was missed.
    // Only for discord/ worktree branches; ensurePrLinkedToMakerThread is idempotent.
    if (this.sessionFinalizeHandler) {
      const sessionInfo = this.db.getThreadSession(threadId);
      if (sessionInfo?.branch?.startsWith("discord/")) {
        try { await this.sessionFinalizeHandler(threadId, session.workDir, sessionInfo.branch); }
        catch (err) { console.error(`[finalize] pr-check failed for ${threadId}:`, err); }
      }
    }

    if (session.pendingUsageLimitResume && session.usageLimitResetAt && session.agentKey === "cc") {
      this.scheduleUsageLimitResume(threadId, session);
    } else if (session.pendingTurnLimitResume && session.agentKey === "cc") {
      try {
        const ctx = session.discordContext ?? {
          channelId: threadId,
          channelName: session.thread?.name ?? "thread",
          userId: "",
          messageId: "",
        };
        await this.runAgent(
          threadId,
          session.channelId,
          session.thread,
          session.agentKey,
          session.workDir,
          SESSION_LIMIT_CONTINUATION_PROMPT,
          ctx
        );
      } catch (err) {
        console.error(`[turn-limit] auto-resume failed for ${threadId}:`, err);
        session.outbox.enqueue(() =>
          session.thread.send({
            embeds: [embed("❌ Resume failed", String((err as Error).message ?? err), 0xff0000)],
          })
        );
        await session.outbox.drain();
      }
    } else {
      // Only dispatch if this is still the active session — an interrupt may have
      // already started a newer run, in which case we must not steal the thread.
      if (this.active.get(threadId) === session) {
        const queued = this.dequeueMessage(threadId);
        if (queued) {
          // Restate the queued message so the user knows what's being processed.
          const preview = queued.originalText.length > 500
            ? queued.originalText.slice(0, 500) + "…"
            : queued.originalText;
          await queued.thread.send({
            embeds: [
              new EmbedBuilder()
                .setTitle("📋 Processing queued message")
                .setDescription(preview)
                .setColor(0x5865f2),
            ],
          });
          try {
            await this.runAgent(
              threadId,
              queued.channelId,
              queued.thread,
              queued.agentKey,
              queued.workDir,
              queued.prompt,
              queued.discordContext
            );
          } catch (err) {
            console.error(`[queue] run failed for ${threadId}:`, err);
          }
        } else {
          // No user queue — fall back to any pending post-run prompt (e.g. CI fix).
          const pendingPrompt = this.pendingPostRunPrompts.get(threadId);
          if (pendingPrompt) {
            this.pendingPostRunPrompts.delete(threadId);
            try {
              await this.runAgent(
                threadId,
                session.channelId,
                session.thread,
                session.agentKey,
                session.workDir,
                pendingPrompt,
                session.discordContext
              );
            } catch (err) {
              console.error(`[pending-prompt] auto-run failed for ${threadId}:`, err);
            }
          }
        }
      }
    }

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
      // session_limit is intentionally not "completed" — cc auto-resumes instead.
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
    const existingSession = this.db.getThreadSession(run.threadId);
    const modelOverride = existingSession?.modelOverride;
    const requestedModel = run.agent === "cx"
      ? (modelOverride ?? this.db.getCodexModel(run.channelId))
      : run.agent === "cs"
        ? (modelOverride ?? this.db.getCsModel(run.channelId))
        : (modelOverride ?? this.db.getModel(run.channelId));
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
      generateImageToolIds: new Set(),
      sentGeneratedImageCallIds: new Set(listCodexGeneratedImageIds(existingSession?.sessionId)),
      sentImagePaths: new Set(
        listNewCodexGeneratedImages(existingSession?.sessionId, new Set()).map((p) =>
          normalizeImagePathKey(p)
        )
      ),
      pendingImageReadIds: new Map(),
      taskList: new Map(),
      workDir: run.workDir,
      requestedModel,
      toolOverrides: this.db.getToolOverrides(run.channelId),
      outbox: this.getOutbox(run.threadId, thread),
      done: false,
      stopping: false,
      // The completion action was persisted, so a PR run that survives a restart
      // still posts its summary comment when it finishes — see finalizeRun.
      completion: parseCompletion(run.completionJson),
      discordContext: {
        channelId: run.threadId,
        channelName: thread.name ?? "thread",
        userId: "",
        messageId: "",
      },
      nonJsonOutput: [],
      wasResume: true,
    };
    this.active.set(run.threadId, session);
    this.getTyping(run.threadId, thread).start();

    if (alive) {
      console.log(`[reattach] ${run.runId} alive (pid ${run.pid}); resuming at offset ${run.stdoutOffset}`);
    } else {
      console.log(`[reattach] ${run.runId} already exited; draining remaining output`);
    }

    this.startTailer(run.threadId, session, agent, run.stdoutOffset, () => isPidAlive(run.pid));
  }

  // Arm a one-shot scheduled task that re-invokes cc when the subscription usage
  // window resets. Replaces any prior session-limit wakeup for this thread.
  private scheduleUsageLimitResume(threadId: string, session: ActiveSession): void {
    const task = registerSessionLimitWakeup(this.db, {
      threadId,
      channelId: session.channelId,
      workDir: session.workDir,
      userId: session.discordContext?.userId ?? "",
      resetAt: session.usageLimitResetAt!,
    });
    console.log(
      `[session-limit] scheduled resume for ${threadId} at ${new Date(task.nextRunAt).toISOString()}`
    );
  }

  // Detect "You've hit your session limit · resets …" in streamed text/errors.
  private noteUsageLimitReset(session: ActiveSession, text: string): void {
    if (session.agentKey !== "cc" || session.pendingUsageLimitResume) return;
    const parsed = parseSessionLimitReset(text);
    if (!parsed) return;
    session.pendingUsageLimitResume = true;
    session.pendingTurnLimitResume = false;
    session.usageLimitResetAt = parsed.resetAt;
    session.usageLimitResetLabel = parsed.resetLabel;
  }

  private enqueueUsageLimitNotice(session: ActiveSession): void {
    if (!session.pendingUsageLimitResume || !session.usageLimitResetLabel || session.usageLimitNoticeSent) {
      return;
    }
    session.usageLimitNoticeSent = true;
    const label = session.usageLimitResetLabel;
    session.outbox.enqueue(() =>
      session.thread.send({
        embeds: [
          embed(
            "⏸️ Session limit reached",
            `Usage limit hit — will resume at **${label}** and continue where you left off.`,
            0xffd700
          ),
        ],
      })
    );
  }

  // Translates a parsed agent event into ordered outbox operations. This is
  // synchronous: it only enqueues work, it never awaits Discord, so stdout
  // parsing stays ahead and the outbox handles delivery + ordering + batching.
  private handleEvent(threadId: string, event: AgentEvent, session: ActiveSession): void {
    const { outbox, toolCalls, thread } = session;

    if (event.kind === "init") {
      const actualModel = event.model ?? session.requestedModel;
      this.db.updateSessionId(threadId, event.sessionId);
      this.db.updateLastRunModel(threadId, actualModel);
      outbox.enqueue(() =>
        thread.send({ embeds: [embed("🚀 Session started", `**Dir:** \`${event.cwd}\`\n**Model:** ${actualModel}`, 0x00ff00)] })
      );
      return;
    }

    if (event.kind === "text") {
      this.noteUsageLimitReset(session, event.content);
      outbox.pushText(event.content);
      return;
    }

    if (event.kind === "image_file") {
      if (!tryClaimImageSend(session.sentImagePaths, event.filePath)) return;
      const callId = generatedImageCallIdFromPath(event.filePath);
      if (callId) session.sentGeneratedImageCallIds.add(callId);
      outbox.enqueue(async () => sendImageAttachment(thread, event.filePath));
      return;
    }

    if (event.kind === "image_data") {
      if (event.callId && session.sentGeneratedImageCallIds.has(event.callId)) return;
      if (event.callId) session.sentGeneratedImageCallIds.add(event.callId);
      outbox.enqueue(async () => sendImageFromBase64(thread, event.data, event.mediaType));
      return;
    }

    if (event.kind === "rate_limit") {
      if (session.agentKey !== "cc") return;
      if (!session.pendingUsageLimitResume) {
        session.pendingUsageLimitResume = true;
        session.pendingTurnLimitResume = false;
        session.usageLimitResetAt = event.resetAt;
        session.usageLimitResetLabel = event.resetLabel;
        this.enqueueUsageLimitNotice(session);
        this.stopProcess(session);
      } else {
        session.usageLimitResetAt = event.resetAt;
        session.usageLimitResetLabel = event.resetLabel;
      }
      return;
    }

    if (event.kind === "tool_start") {
      // Hidden tools don't get their own embed; instead they bump the running
      // "N hidden" summary. Remember the id so the matching tool_done is dropped
      // (it must not seal the summary).
      if (event.name === "TodoRead" || event.name === "TodoWrite" ||
          event.name === "TaskCreate" || event.name === "TaskUpdate" ||
          event.name === "TaskList" || event.name === "TaskGet" ||
          event.name === "TaskOutput" || event.name === "TaskStop") {
        session.hiddenToolIds.add(event.id);
        return;
      }
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

    if (event.kind === "session_limit") {
      if (session.agentKey === "cc") {
        if (session.pendingUsageLimitResume) {
          this.enqueueUsageLimitNotice(session);
        } else {
          session.pendingTurnLimitResume = true;
          const turns = event.turns !== null ? `${event.turns} turns` : "turn limit";
          outbox.enqueue(() =>
            thread.send({
              embeds: [
                embed(
                  "⏸️ Turn limit reached",
                  `Hit the ${turns} cap — continuing where you left off.`,
                  0xffd700
                ),
              ],
            })
          );
        }
      } else {
        session.done = true;
        outbox.enqueue(() =>
          thread.send({ embeds: [embed("❌ Failed", "error_max_turns", 0xff0000)] })
        );
      }
      this.stopProcess(session);
      return;
    }

    if (event.kind === "error") {
      this.noteUsageLimitReset(session, event.message);
      if (session.pendingUsageLimitResume) {
        this.enqueueUsageLimitNotice(session);
        this.stopProcess(session);
        return;
      }
      session.done = true;
      let msg = event.message;
      if (event.subtype === "error_during_execution" && session.wasResume) {
        msg = "Session failed to resume — it was likely interrupted mid-execution (e.g. bot restart). Use /clear to start a fresh conversation.";
      }
      const detail = session.nonJsonOutput.length
        ? `${msg}\n\n${session.nonJsonOutput.join("\n")}`
        : msg;
      outbox.enqueue(() =>
        thread.send({ embeds: [embed("❌ Failed", detail, 0xff0000)] })
      );
      this.stopProcess(session);
      return;
    }

    // Internal SDK events with extra fields — handle here
    const raw = event as any;
    if (raw.kind === "_sdk_assistant") {
      this.db.updateSessionId(threadId, raw.sessionId);
      if (raw.content?.trim()) {
        this.noteUsageLimitReset(session, raw.content);
        if (session.pendingUsageLimitResume) {
          this.enqueueUsageLimitNotice(session);
          this.stopProcess(session);
        }
        outbox.pushText(raw.content);
      }
      for (const tool of (raw.tools ?? [])) {
        if (tool.name === "TodoRead") {
          session.hiddenToolIds.add(tool.id);
          continue;
        }
        if (tool.name === "TodoWrite" && Array.isArray(tool.input?.todos)) {
          session.hiddenToolIds.add(tool.id);
          const todos = tool.input.todos;
          outbox.enqueue(async () => {
            await thread.send({ embeds: [buildTodoEmbed(todos)] });
          });
          continue;
        }
        if (tool.name === "TaskCreate" && tool.input?.subject) {
          session.hiddenToolIds.add(tool.id);
          const taskId = session.taskList.size + 1;
          session.taskList.set(taskId, { subject: String(tool.input.subject), status: "pending" });
          const snapshot = new Map(session.taskList);
          outbox.enqueue(async () => {
            await thread.send({ embeds: [buildTaskEmbed(snapshot)] });
          });
          continue;
        }
        if (tool.name === "TaskUpdate" && tool.input?.taskId != null) {
          session.hiddenToolIds.add(tool.id);
          const task = session.taskList.get(Number(tool.input.taskId));
          if (task && tool.input?.status) {
            task.status = String(tool.input.status);
            const snapshot = new Map(session.taskList);
            outbox.enqueue(async () => {
              await thread.send({ embeds: [buildTaskEmbed(snapshot)] });
            });
          }
          continue;
        }
        if (tool.name === "TaskList" || tool.name === "TaskGet" ||
            tool.name === "TaskOutput" || tool.name === "TaskStop") {
          session.hiddenToolIds.add(tool.id);
          continue;
        }
        if (tool.name === "GenerateImage") {
          session.hiddenToolIds.add(tool.id);
          session.generateImageToolIds.add(tool.id);
          outbox.pushHiddenTool(tool.name);
          continue;
        }
        if (tool.name === "Read") {
          const filePath = getToolInputPath(tool.input);
          if (filePath && isImageType(undefined, filePath)) {
            session.hiddenToolIds.add(tool.id);
            session.pendingImageReadIds.set(tool.id, filePath);
            outbox.pushHiddenTool(tool.name);
            continue;
          }
        }
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
        if (session.generateImageToolIds.has(result.tool_use_id)) {
          session.generateImageToolIds.delete(result.tool_use_id);
          const imagePath = extractGeneratedImagePath(result.content);
          if (imagePath && tryClaimImageSend(session.sentImagePaths, imagePath)) {
            const callId = generatedImageCallIdFromPath(imagePath);
            if (callId) session.sentGeneratedImageCallIds.add(callId);
            outbox.enqueue(async () => sendImageAttachment(thread, imagePath));
          }
          continue;
        }
        if (session.pendingImageReadIds.has(result.tool_use_id)) {
          const fallbackPath = session.pendingImageReadIds.get(result.tool_use_id)!;
          session.pendingImageReadIds.delete(result.tool_use_id);
          const b64 = extractBase64ImageFromResult(result.content);
          if (b64) {
            outbox.enqueue(async () => sendImageFromBase64(thread, b64.data, b64.mediaType));
          } else if (tryClaimImageSend(session.sentImagePaths, fallbackPath)) {
            outbox.enqueue(async () => sendImageAttachment(thread, fallbackPath));
          }
          // Still drop the result from the visible tool-call feed.
        }
        // Drop results for hidden tools entirely — enqueuing a no-op op would
        // seal the running summary between two batches of hidden calls.
        if (session.hiddenToolIds.has(result.tool_use_id)) continue;
        outbox.enqueue(async () => {
          const tracked = toolCalls.get(result.tool_use_id);
          if (!tracked?.message) return;
          const firstLine = (toolResultText(result.content).split("\n")[0] ?? "").trim().slice(0, 100);
          const current = tracked.message.embeds[0].data.description ?? "";
          const updated = current.replace("⏳", result.is_error ? "❌" : "✅");
          await tracked.message.edit({
            embeds: [new EmbedBuilder().setDescription(`${updated}${firstLine ? `\n*${firstLine}*` : ""}`).setColor(result.is_error ? 0xff0000 : 0x00ff00)],
          });
        });
      }
    }
  }

  private enqueueDiscoveredCodexImages(threadId: string, session: ActiveSession): void {
    if (session.agentKey !== "cx") return;
    const sessionId = this.db.getThreadSession(threadId)?.sessionId;
    for (const filePath of listNewCodexGeneratedImages(sessionId, session.sentGeneratedImageCallIds)) {
      if (!tryClaimImageSend(session.sentImagePaths, filePath)) continue;
      const callId = path.basename(filePath, path.extname(filePath));
      session.sentGeneratedImageCallIds.add(callId);
      session.outbox.enqueue(async () => sendImageAttachment(session.thread, filePath));
    }
  }

  // Graceful shutdown that PRESERVES running agents. Stop the tailers (each does
  // a final drain + offset flush + fd close), deliver whatever is already queued,
  // then return so the process can exit. The detached agents keep running and the
  // active_runs rows persist, so the next boot re-attaches via reattachRuns().
  async detachAndExit(): Promise<void> {
    for (const [, session] of this.active) {
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

  constructor(
    private thread: any,
    private onLocalImageReference?: (filePath: string) => void,
    private claimImagePath?: (filePath: string) => boolean
  ) {}

  // Point the outbox at the latest thread object when a new run reuses it.
  updateThread(
    thread: any,
    onLocalImageReference?: (filePath: string) => void,
    claimImagePath?: (filePath: string) => boolean
  ): void {
    this.thread = thread;
    this.onLocalImageReference = onLocalImageReference;
    this.claimImagePath = claimImagePath;
  }

  private get busy(): boolean {
    return this.running || this.queue.length > 0;
  }

  // Append streamed text. Merges into a pending text item so a burst (or
  // everything that accumulates while an earlier send is in flight) goes out
  // as one message.
  pushText(content: string): void {
    if (!content) return;
    if (this.onLocalImageReference) {
      for (const ref of extractLocalImageReferences(content)) {
        this.onLocalImageReference(ref.filePath);
      }
    }
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
            if (item.type === "text") await sendChunked(this.thread, item.content, this.claimImagePath);
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

async function sendChunked(
  thread: any,
  content: string,
  claimImagePath?: (filePath: string) => boolean
): Promise<void> {
  const imageRefs = extractLocalImageReferences(content);
  if (imageRefs.length > 0) {
    const cleaned = stripLocalImageReferences(content).trim();
    if (cleaned) {
      await sendChunkedText(thread, cleaned);
    }
    for (const ref of imageRefs) {
      if (claimImagePath && !claimImagePath(ref.filePath)) continue;
      await sendImageAttachment(thread, ref.filePath);
    }
    return;
  }

  await sendChunkedText(thread, content);
}

async function sendChunkedText(thread: any, content: string): Promise<void> {
  const text = formatForDiscord(content);
  if (!text) return;
  if (text.length <= MAX_EMBED) {
    await thread.send({ embeds: [new EmbedBuilder().setDescription(text).setColor(0x7289da)] });
    return;
  }
  const chunks = splitText(text, MAX_EMBED);
  for (let i = 0; i < chunks.length; i++) {
    await thread.send({
      embeds: [new EmbedBuilder().setDescription(chunks[i] ?? "").setColor(0x7289da).setFooter(i > 0 ? { text: `(${i + 1}/${chunks.length})` } : null)],
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
async function sendImageAttachment(thread: any, filePath: string): Promise<void> {
  try {
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).slice(1).toLowerCase().replace("jpeg", "jpg") || "png";
      const buffer = fs.readFileSync(filePath);
      await thread.send({ files: [new AttachmentBuilder(buffer, { name: `image.${ext}` })] });
    } else {
      console.warn(`[image] File not found, skipping: ${filePath}`);
    }
  } catch (err) {
    console.error(`[image] Failed to send image ${filePath}:`, err);
  }
}

async function sendImageFromBase64(thread: any, data: string, mediaType: string): Promise<void> {
  try {
    const ext = (mediaType.split("/")[1] ?? "png").replace("jpeg", "jpg");
    const buffer = Buffer.from(data, "base64");
    await thread.send({ files: [new AttachmentBuilder(buffer, { name: `image.${ext}` })] });
  } catch (err) {
    console.error("[image] Failed to send base64 image:", err);
  }
}

function generatedImageCallIdFromPath(filePath: string): string | undefined {
  const name = path.basename(filePath, path.extname(filePath));
  return name.startsWith("ig_") ? name : undefined;
}

export function listNewCodexGeneratedImages(sessionId: string | undefined, sentIds: Set<string>): string[] {
  if (!sessionId) return [];
  const dir = codexGeneratedImageDir(sessionId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  return entries
    .map((name) => path.join(dir, name))
    .filter((filePath) => {
      const id = path.basename(filePath, path.extname(filePath));
      return isImageType(undefined, filePath) && !sentIds.has(id);
    })
    .sort();
}

function listCodexGeneratedImageIds(sessionId: string | undefined): string[] {
  return listNewCodexGeneratedImages(sessionId, new Set()).map((filePath) =>
    path.basename(filePath, path.extname(filePath))
  );
}

function codexGeneratedImageDir(sessionId: string): string {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(codexHome, "generated_images", sessionId);
}

function extractBase64ImageFromResult(content: unknown): { data: string; mediaType: string } | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block?.type === "image" && block?.source?.type === "base64" && typeof block.source.data === "string") {
      return { data: block.source.data, mediaType: block.source.media_type ?? "image/png" };
    }
  }
  return null;
}

function toolResultText(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .map((c) => (typeof c === "string" ? c : c?.type === "text" ? c.text ?? "" : ""))
      .filter(Boolean);
    if (texts.length > 0) return texts.join(" ");
    if (content.some((c: any) => c?.type === "image")) return "[image]";
    return "";
  }
  if (typeof content === "object" && content.type === "text") return content.text ?? "";
  if (typeof content === "object" && content.type === "image") return "[image]";
  return "";
}


function formatToolCall(tool: any, workDir: string): string {
  const clean = (v: string) => v.startsWith(workDir + "/") ? v.replace(workDir + "/", "./") : v === workDir ? "." : v;
  if (tool.name === "Bash" && tool.input?.command) return `🔧 **Bash**\n\`\`\`bash\n${clean(String(tool.input.command)).slice(0, 400)}\n\`\`\``;
  const readPath = getToolInputPath(tool.input);
  if (tool.name === "Read" && readPath) return `🔧 **Read** \`${clean(readPath)}\``;
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

function buildTaskEmbed(taskList: Map<number, { subject: string; status: string }>): EmbedBuilder {
  const lines = [...taskList.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, task]) => {
      if (task.status === "completed") return `✅ ~~${task.subject}~~`;
      if (task.status === "in_progress") return `🔄 **${task.subject}**`;
      return `⬜ ${task.subject}`;
    });
  return new EmbedBuilder()
    .setTitle("📋 Todo List")
    .setDescription(lines.join("\n"))
    .setColor(0x5865F2);
}

function buildTodoEmbed(todos: Array<{ id: string; content: string; status: string; priority?: string }>): EmbedBuilder {
  const lines = todos.map((todo) => {
    if (todo.status === "completed") return `✅ ~~${todo.content}~~`;
    if (todo.status === "in_progress") return `🔄 **${todo.content}**`;
    return `⬜ ${todo.content}`;
  });
  return new EmbedBuilder()
    .setTitle("📋 Todo List")
    .setDescription(lines.join("\n"))
    .setColor(0x5865F2);
}
