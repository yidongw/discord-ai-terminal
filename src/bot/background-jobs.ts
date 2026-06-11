import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { ChannelType, EmbedBuilder, type Client } from "discord.js";
import type { SessionManager } from "./session-manager.js";
import type { DatabaseManager, BackgroundJob } from "../db/database.js";
import { escapeShellString } from "../utils/shell.js";
import { isPidAlive } from "./run-tailer.js";

// How often we re-stat running jobs for completion.
const POLL_INTERVAL_MS = 3 * 1000;
// Appended to a job's log by the wrapper so completion (and the exit code) is
// detectable from the FILE alone — survives a bot restart, no live-PID needed.
const SENTINEL_RE = /__JOB_DONE__ exit=(\d+)/;
const MAX_OUTPUT_CHARS = 4000;

interface StartJobArgs {
  threadId: string;
  channelId: string;
  workDir: string;
  command: string;
  label?: string;
}

/**
 * Runs user-requested shell commands detached from the bot and, when each one
 * finishes, re-invokes cc in the originating thread with the command's output.
 *
 * This is the completion-driven sibling of the (timer-driven) Scheduler: a
 * one-shot `claude -p` turn can't block on a long command (it backgrounds it and
 * exits), so instead the bot owns the command, watches for it to finish, and
 * "wakes" cc with the result. The command runs detached + logs to a file with an
 * exit-code sentinel, so it survives bot restarts and still wakes cc afterward.
 */
export class BackgroundJobManager {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private jobsDir: string;

  constructor(
    private client: Client,
    private sessionManager: SessionManager,
    private db: DatabaseManager
  ) {
    this.jobsDir = path.join(process.cwd(), "jobs");
    try { fs.mkdirSync(this.jobsDir, { recursive: true }); } catch {}
    this.cleanupOrphanLogs();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    void this.tick();
    console.log(`Background job manager started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // Spawn a detached command that appends its exit code to its log on completion.
  // The command is raw shell (that's the whole point); workDir/logPath are quoted.
  startJob(args: StartJobArgs): { jobId: string; pid: number } {
    const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const logPath = path.join(this.jobsDir, `${jobId}.log`);
    // Pre-create so a (future) reader never races a not-yet-created file.
    try { fs.closeSync(fs.openSync(logPath, "a")); } catch {}

    const log = escapeShellString(logPath);
    const wrapped =
      `(cd ${escapeShellString(args.workDir)} && ${args.command}) >> ${log} 2>&1; ` +
      `echo "__JOB_DONE__ exit=$?" >> ${log}`;

    const proc = spawn("/bin/bash", ["-c", wrapped], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, SHELL: "/bin/bash" },
    });
    proc.unref();
    const pid = proc.pid ?? -1;

    this.db.createBackgroundJob({
      jobId,
      threadId: args.threadId,
      channelId: args.channelId,
      workDir: args.workDir,
      command: args.command,
      label: args.label,
      pid,
      logPath,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
    });
    console.log(`[bgjob] started ${jobId} (pid ${pid}): ${args.command.slice(0, 120)}`);
    return { jobId, pid };
  }

  // Kill a running job's process group and forget it. Returns false if unknown.
  cancelJob(jobId: string): boolean {
    const job = this.db.getBackgroundJob(jobId);
    if (!job) return false;
    killGroup(job.pid);
    this.cleanup(job);
    return true;
  }

  list(threadId?: string): BackgroundJob[] {
    return this.db.listBackgroundJobs(threadId);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    // channels.fetch needs the gateway; wait for the next tick if not ready.
    if (!this.client.isReady()) return;
    this.ticking = true;
    try {
      for (const job of this.db.listBackgroundJobs()) {
        try {
          let current = job;
          if (current.status === "running") {
            const done = this.detectCompletion(current);
            if (!done) continue; // still running
            this.db.markBackgroundJobFinished(current.jobId, done.exitCode);
            current = { ...current, status: "finished", exitCode: done.exitCode };
          }
          await this.tryWake(current);
        } catch (err) {
          console.error(`[bgjob] ${job.jobId} tick failed:`, err);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  // Finished if the log carries the exit-code sentinel; or, as a fallback, if the
  // process is simply gone (died/killed before writing one → unknown exit).
  private detectCompletion(job: BackgroundJob): { exitCode: number | null } | null {
    let text = "";
    try { text = fs.readFileSync(job.logPath, "utf8"); } catch {}
    const m = text.match(SENTINEL_RE);
    if (m) return { exitCode: parseInt(m[1]!, 10) };
    if (!isPidAlive(job.pid)) return { exitCode: null };
    return null;
  }

  // Re-invoke cc in the job's thread with the command output. Deferred while the
  // thread already has an active run (so we never pile on); the job row stays
  // until the wake run is launched, so a restart re-wakes (at-least-once).
  private async tryWake(job: BackgroundJob): Promise<void> {
    if (this.sessionManager.hasActiveProcess(job.threadId)) return; // busy → retry next tick

    const session = this.db.getThreadSession(job.threadId);
    if (!session) { this.cleanup(job); return; } // nothing to resume

    let thread: any;
    try {
      thread = await this.client.channels.fetch(job.threadId);
    } catch (err: any) {
      if (err?.code === 10003) this.cleanup(job); // thread gone for good
      return; // transient → retry next tick
    }
    if (!thread || (thread.type !== ChannelType.PublicThread && thread.type !== ChannelType.PrivateThread)) {
      this.cleanup(job);
      return;
    }

    const output = this.readOutput(job);
    const prompt = buildWakePrompt(job, output);

    try {
      await thread.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("🔔 Background job finished")
            .setDescription(
              `${job.label ? `**${job.label}**\n` : ""}\`${truncate(job.command, 200)}\`\n` +
                `*${job.exitCode === null || job.exitCode === undefined ? "process died (no exit code)" : `exit ${job.exitCode}`}*`
            )
            .setColor(0x9b59b6),
        ],
      });

      await this.sessionManager.runAgent(
        job.threadId,
        session.channelId,
        thread,
        session.agent,
        session.workDir,
        prompt,
        { channelId: job.threadId, channelName: thread.name ?? "thread", userId: "", messageId: "" }
      );
      // Launched successfully — drop the job (its run now owns the thread).
      this.cleanup(job);
    } catch (err) {
      console.error(`[bgjob] wake failed for ${job.jobId}, will retry:`, err);
    }
  }

  private readOutput(job: BackgroundJob): string {
    let text = "";
    try { text = fs.readFileSync(job.logPath, "utf8"); } catch { return "(no output captured)"; }
    text = text.replace(/\n?__JOB_DONE__ exit=\d+\s*$/, "").trimEnd();
    if (text.length > MAX_OUTPUT_CHARS) text = "…(earlier output truncated)…\n" + text.slice(-MAX_OUTPUT_CHARS);
    return text || "(no output)";
  }

  private cleanup(job: BackgroundJob): void {
    this.db.deleteBackgroundJob(job.jobId);
    try { fs.unlinkSync(job.logPath); } catch {}
  }

  // Remove leftover .log files with no backing row (e.g. a wake that cleaned the
  // row but failed to unlink), preserving logs for jobs we still track.
  private cleanupOrphanLogs(): void {
    let files: string[];
    try { files = fs.readdirSync(this.jobsDir); } catch { return; }
    const keep = new Set(this.db.listBackgroundJobs().map((j) => path.basename(j.logPath)));
    for (const f of files) {
      if (!f.endsWith(".log") || keep.has(f)) continue;
      try { fs.unlinkSync(path.join(this.jobsDir, f)); } catch {}
    }
  }
}

function buildWakePrompt(job: BackgroundJob, output: string): string {
  const result =
    job.exitCode === null || job.exitCode === undefined
      ? "the process died without an exit code"
      : `exit code ${job.exitCode}`;
  return (
    `A background command you started in this thread has finished.\n\n` +
    `Command: ${job.command}\n` +
    `Result: ${result}\n\n` +
    `Output:\n\`\`\`\n${output}\n\`\`\`\n\n` +
    `Report the result to the user and take any follow-up you intended.`
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Kill a detached job's whole process group (the bash wrapper started its own
// session via detached:true), falling back to the bare PID.
function killGroup(pid: number): void {
  if (!pid || pid <= 0) return;
  try { process.kill(-pid, "SIGKILL"); }
  catch {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}
