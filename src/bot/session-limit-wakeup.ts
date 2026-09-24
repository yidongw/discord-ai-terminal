import type { DatabaseManager, ScheduledTask } from "../db/database.js";

export const SESSION_LIMIT_CONTINUATION_PROMPT =
  "Your previous run hit the session limit before finishing.\n\n" +
  "Continue exactly where you left off and complete any remaining work from the original task. " +
  "Do not restart from scratch or repeat work you already finished.";

export function sessionLimitTaskId(threadId: string): string {
  return `session-limit-${threadId}`;
}

export function buildSessionLimitWakeupTask(args: {
  threadId: string;
  channelId: string;
  workDir: string;
  userId: string;
  resetAt: number;
  now?: number;
}): ScheduledTask {
  const now = args.now ?? Date.now();
  return {
    id: sessionLimitTaskId(args.threadId),
    threadId: args.threadId,
    channelId: args.channelId,
    agent: "cc",
    workDir: args.workDir,
    userId: args.userId,
    prompt: SESSION_LIMIT_CONTINUATION_PROMPT,
    label: "Session limit resume",
    intervalSeconds: 60,
    nextRunAt: args.resetAt,
    enabled: true,
    runCount: 0,
    maxRuns: 1,
    createdAt: now,
  };
}

/** Persist a one-shot scheduler row that re-invokes cc when the usage window resets. */
export function registerSessionLimitWakeup(
  db: Pick<DatabaseManager, "getScheduledTask" | "deleteScheduledTask" | "createScheduledTask">,
  args: {
    threadId: string;
    channelId: string;
    workDir: string;
    userId: string;
    resetAt: number;
    now?: number;
  }
): ScheduledTask {
  const task = buildSessionLimitWakeupTask(args);
  const existing = db.getScheduledTask(task.id);
  if (existing) db.deleteScheduledTask(task.id);
  db.createScheduledTask(task);
  return task;
}

/** Drop a still-future session-limit wakeup for a thread whose run just completed
 *  normally: the limit evidently no longer blocks it, and a leftover row keeps
 *  queueing every bot message to the thread until the old reset time. Returns
 *  whether a row was removed. */
export function clearStaleSessionLimitWakeup(
  db: Pick<DatabaseManager, "getScheduledTask" | "deleteScheduledTask">,
  threadId: string,
  now: number = Date.now()
): boolean {
  const id = sessionLimitTaskId(threadId);
  const task = db.getScheduledTask(id);
  if (!task || task.nextRunAt <= now) return false;
  db.deleteScheduledTask(id);
  return true;
}
