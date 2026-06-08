import { Database } from "bun:sqlite";
import * as path from "path";

export type PermissionMode = "auto" | "plan" | "approve";
export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface ThreadSession {
  threadId: string;
  channelId: string;
  agent: string;
  sessionId?: string;
  workDir: string;
  createdAt: number;
}

export interface ScheduledTask {
  id: string;
  threadId: string;
  channelId: string;
  agent: string;
  workDir: string;
  userId: string;
  prompt: string;
  label?: string;
  intervalSeconds: number;
  nextRunAt: number;
  enabled: boolean;
  lastRunAt?: number;
  runCount: number;
  maxRuns?: number;
  createdAt: number;
}

export class DatabaseManager {
  private db: Database;

  constructor(dbPath?: string) {
    const finalPath = dbPath || path.join(process.cwd(), "sessions.db");
    this.db = new Database(finalPath);
    this.initializeTables();
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_sessions (
        thread_id   TEXT PRIMARY KEY,
        channel_id  TEXT NOT NULL,
        agent       TEXT NOT NULL,
        session_id  TEXT,
        work_dir    TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_modes (
        channel_id  TEXT PRIMARY KEY,
        mode        TEXT NOT NULL DEFAULT 'auto'
      );

      CREATE TABLE IF NOT EXISTS channel_models (
        channel_id  TEXT PRIMARY KEY,
        model       TEXT NOT NULL DEFAULT 'sonnet'
      );

      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id               TEXT PRIMARY KEY,
        thread_id        TEXT NOT NULL,
        channel_id       TEXT NOT NULL,
        agent            TEXT NOT NULL,
        work_dir         TEXT NOT NULL,
        user_id          TEXT NOT NULL,
        prompt           TEXT NOT NULL,
        label            TEXT,
        interval_seconds INTEGER NOT NULL,
        next_run_at      INTEGER NOT NULL,
        enabled          INTEGER NOT NULL DEFAULT 1,
        last_run_at      INTEGER,
        run_count        INTEGER NOT NULL DEFAULT 0,
        max_runs         INTEGER,
        created_at       INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
        ON scheduled_tasks (enabled, next_run_at);
    `);
  }

  // ── Thread sessions ──────────────────────────────────────────────────────

  createThreadSession(ts: ThreadSession): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO thread_sessions
         (thread_id, channel_id, agent, session_id, work_dir, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(ts.threadId, ts.channelId, ts.agent, ts.sessionId ?? null, ts.workDir, ts.createdAt);
  }

  getThreadSession(threadId: string): ThreadSession | null {
    const row = this.db
      .prepare(`SELECT * FROM thread_sessions WHERE thread_id = ?`)
      .get(threadId) as any;
    if (!row) return null;
    return {
      threadId: row.thread_id,
      channelId: row.channel_id,
      agent: row.agent,
      sessionId: row.session_id ?? undefined,
      workDir: row.work_dir,
      createdAt: row.created_at,
    };
  }

  updateSessionId(threadId: string, sessionId: string): void {
    this.db
      .prepare(`UPDATE thread_sessions SET session_id = ? WHERE thread_id = ?`)
      .run(sessionId, threadId);
  }

  deleteThreadSession(threadId: string): void {
    this.db.prepare(`DELETE FROM thread_sessions WHERE thread_id = ?`).run(threadId);
  }

  cleanupOldThreadSessions(olderThanMs = 7 * 24 * 60 * 60 * 1000): void {
    const cutoff = Date.now() - olderThanMs;
    this.db.prepare(`DELETE FROM thread_sessions WHERE created_at < ?`).run(cutoff);
  }

  // ── Channel settings ─────────────────────────────────────────────────────

  getMode(channelId: string): PermissionMode {
    const row = this.db
      .prepare(`SELECT mode FROM channel_modes WHERE channel_id = ?`)
      .get(channelId) as any;
    return (row?.mode as PermissionMode) ?? "auto";
  }

  setMode(channelId: string, mode: PermissionMode): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_modes (channel_id, mode) VALUES (?, ?)`)
      .run(channelId, mode);
  }

  getModel(channelId: string): ClaudeModel {
    const row = this.db
      .prepare(`SELECT model FROM channel_models WHERE channel_id = ?`)
      .get(channelId) as any;
    return (row?.model as ClaudeModel) ?? "sonnet";
  }

  setModel(channelId: string, model: ClaudeModel): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_models (channel_id, model) VALUES (?, ?)`)
      .run(channelId, model);
  }

  // ── Scheduled tasks ──────────────────────────────────────────────────────

  private rowToScheduledTask(row: any): ScheduledTask {
    return {
      id: row.id,
      threadId: row.thread_id,
      channelId: row.channel_id,
      agent: row.agent,
      workDir: row.work_dir,
      userId: row.user_id,
      prompt: row.prompt,
      label: row.label ?? undefined,
      intervalSeconds: row.interval_seconds,
      nextRunAt: row.next_run_at,
      enabled: !!row.enabled,
      lastRunAt: row.last_run_at ?? undefined,
      runCount: row.run_count,
      maxRuns: row.max_runs ?? undefined,
      createdAt: row.created_at,
    };
  }

  createScheduledTask(task: ScheduledTask): void {
    this.db
      .prepare(
        `INSERT INTO scheduled_tasks
         (id, thread_id, channel_id, agent, work_dir, user_id, prompt, label,
          interval_seconds, next_run_at, enabled, last_run_at, run_count, max_runs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.threadId,
        task.channelId,
        task.agent,
        task.workDir,
        task.userId,
        task.prompt,
        task.label ?? null,
        task.intervalSeconds,
        task.nextRunAt,
        task.enabled ? 1 : 0,
        task.lastRunAt ?? null,
        task.runCount,
        task.maxRuns ?? null,
        task.createdAt
      );
  }

  getScheduledTask(id: string): ScheduledTask | null {
    const row = this.db.prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`).get(id) as any;
    return row ? this.rowToScheduledTask(row) : null;
  }

  // List tasks, optionally scoped to a single thread. Newest first.
  listScheduledTasks(threadId?: string): ScheduledTask[] {
    const rows = threadId
      ? (this.db
          .prepare(`SELECT * FROM scheduled_tasks WHERE thread_id = ? ORDER BY created_at DESC`)
          .all(threadId) as any[])
      : (this.db
          .prepare(`SELECT * FROM scheduled_tasks ORDER BY created_at DESC`)
          .all() as any[]);
    return rows.map((r) => this.rowToScheduledTask(r));
  }

  // Enabled tasks whose next_run_at has passed — the scheduler's poll query.
  getDueScheduledTasks(now: number): ScheduledTask[] {
    const rows = this.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC`)
      .all(now) as any[];
    return rows.map((r) => this.rowToScheduledTask(r));
  }

  // Record a run and arm the next one. Disables the task if it hit max_runs.
  markScheduledTaskRun(id: string, ranAt: number, nextRunAt: number): void {
    this.db
      .prepare(
        `UPDATE scheduled_tasks
         SET last_run_at = ?,
             run_count   = run_count + 1,
             next_run_at = ?,
             enabled     = CASE WHEN max_runs IS NOT NULL AND run_count + 1 >= max_runs THEN 0 ELSE enabled END
         WHERE id = ?`
      )
      .run(ranAt, nextRunAt, id);
  }

  // Push next_run_at forward without counting a run (used when a thread is busy).
  rescheduleScheduledTask(id: string, nextRunAt: number): void {
    this.db.prepare(`UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?`).run(nextRunAt, id);
  }

  setScheduledTaskEnabled(id: string, enabled: boolean): void {
    this.db.prepare(`UPDATE scheduled_tasks SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  }

  deleteScheduledTask(id: string): void {
    this.db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
  }

  deleteScheduledTasksForThread(threadId: string): void {
    this.db.prepare(`DELETE FROM scheduled_tasks WHERE thread_id = ?`).run(threadId);
  }
}
