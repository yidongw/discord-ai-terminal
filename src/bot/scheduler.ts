import type { Client } from "discord.js";
import { ChannelType } from "discord.js";
import { EmbedBuilder } from "discord.js";
import type { SessionManager } from "./session-manager.js";
import type { DatabaseManager, ScheduledTask } from "../db/database.js";

// How often we wake up to look for due tasks. Tasks fire on the first tick at or
// after their next_run_at, so effective granularity is ~this interval.
const POLL_INTERVAL_MS = 30 * 1000;
// If a task is due but its thread is mid-run, retry soon rather than skipping
// the whole interval.
const BUSY_RETRY_MS = 60 * 1000;
// Floor on user-supplied intervals — a runaway 5-second loop would hammer the
// agent and Discord. Enforced again here in case a row was written directly.
export const MIN_INTERVAL_SECONDS = 60;

/**
 * Bot-side timer that replays scheduled prompts. The agent processes themselves
 * are disposable (spawned per turn, exit when done); this loop is what survives
 * between runs, so it owns the "wake me again in N minutes" obligation. Each due
 * task is fed back through SessionManager.runAgent() exactly as if the stored
 * prompt had just arrived as a Discord message — so output routing, session
 * resume, and the MCP bridge all work unchanged.
 */
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private client: Client,
    private sessionManager: SessionManager,
    private db: DatabaseManager
  ) {}

  start(): void {
    if (this.timer) return;
    // Kick once shortly after startup to catch tasks that came due while the
    // bot was down, then settle into the poll cadence.
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    void this.tick();
    console.log(`Scheduler started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    // Ticks can outlast POLL_INTERVAL_MS (a run that has to await Discord fetch);
    // never overlap them.
    if (this.ticking) return;
    // The gateway may not be connected yet on the very first tick (or during a
    // reconnect). channels.fetch would fail then — wait for the next tick.
    if (!this.client.isReady()) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const due = this.db.getDueScheduledTasks(now);
      for (const task of due) {
        try {
          await this.runTask(task, now);
        } catch (err) {
          console.error(`[scheduler] task ${task.id} failed:`, err);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async runTask(task: ScheduledTask, now: number): Promise<void> {
    // Don't pile a scheduled run on top of an in-flight one in the same thread.
    if (this.sessionManager.hasActiveProcess(task.threadId)) {
      this.db.rescheduleScheduledTask(task.id, now + BUSY_RETRY_MS);
      return;
    }

    // Resolve the live thread object. Distinguish "thread is genuinely gone"
    // (disable the task) from a transient fetch error (retry next tick) so a
    // blip doesn't silently kill a recurring task.
    let thread: any;
    try {
      thread = await this.client.channels.fetch(task.threadId);
    } catch (err: any) {
      // 10003 = Unknown Channel → the thread no longer exists.
      if (err?.code === 10003) {
        console.error(`[scheduler] thread ${task.threadId} gone, disabling task ${task.id}`);
        this.db.setScheduledTaskEnabled(task.id, false);
      } else {
        console.error(`[scheduler] transient fetch error for ${task.threadId}, will retry:`, err);
        this.db.rescheduleScheduledTask(task.id, now + BUSY_RETRY_MS);
      }
      return;
    }
    if (!thread || (thread.type !== ChannelType.PublicThread && thread.type !== ChannelType.PrivateThread)) {
      console.error(`[scheduler] thread ${task.threadId} missing/not a thread, disabling task ${task.id}`);
      this.db.setScheduledTaskEnabled(task.id, false);
      return;
    }

    const intervalSeconds = Math.max(task.intervalSeconds, MIN_INTERVAL_SECONDS);
    // Arm the next run BEFORE launching so a crash mid-run can't double-fire, and
    // so the run's own duration doesn't drift the schedule.
    this.db.markScheduledTaskRun(task.id, now, now + intervalSeconds * 1000);

    const discordContext = {
      channelId: task.threadId,
      channelName: thread.name ?? task.label ?? "scheduled",
      userId: task.userId,
      messageId: "",
    };

    await thread.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("⏰ Scheduled run")
          .setDescription(
            `${task.label ? `**${task.label}**\n` : ""}\`${truncate(task.prompt, 300)}\`` +
              `\n*every ${formatInterval(intervalSeconds)} · run #${task.runCount + 1}*`
          )
          .setColor(0x9b59b6),
      ],
    });

    await this.sessionManager.runAgent(
      task.threadId,
      task.channelId,
      thread,
      task.agent,
      task.workDir,
      task.prompt,
      discordContext
    );
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function formatInterval(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

// Parse a human interval string ("10m", "2h", "90s", "1d", or a bare number of
// seconds) into seconds. Returns null if unparseable.
export function parseInterval(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.floor(value) : null;
  const m = String(value).trim().match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  switch ((m[2] || "s").toLowerCase()) {
    case "s": return n;
    case "m": return n * 60;
    case "h": return n * 3600;
    case "d": return n * 86400;
    default: return null;
  }
}
