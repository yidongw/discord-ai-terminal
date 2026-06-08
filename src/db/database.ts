import { Database } from "bun:sqlite";
import * as path from "path";

export type PermissionMode = "auto" | "plan" | "approve";
export type ClaudeModel = "opus" | "sonnet" | "haiku";

// The common built-in tools, shown in `/tools list` so the user sees the full
// picture. Not exhaustive (MCP tools are dynamic) — any tool a channel has an
// override for is listed too.
export const KNOWN_TOOLS = [
  "Bash", "Read", "Edit", "Write", "Glob", "Grep",
  "Task", "TodoWrite", "WebFetch", "WebSearch", "NotebookEdit",
];

// Tool-call messages hidden in every channel unless a per-channel override says
// otherwise. Other tools are shown by default. Toggle with the /tools command.
export const DEFAULT_HIDDEN_TOOLS = ["Bash", "Read", "Edit"];

// Resolve whether a tool's messages are hidden, given a channel's overrides.
// An explicit override wins; otherwise fall back to the default-hidden list.
export function toolIsHidden(toolName: string, overrides: Record<string, boolean>): boolean {
  if (toolName in overrides) return overrides[toolName]!;
  return DEFAULT_HIDDEN_TOOLS.includes(toolName);
}

export interface ThreadSession {
  threadId: string;
  channelId: string;
  agent: string;
  sessionId?: string;
  workDir: string;
  // The git branch backing this thread's worktree (per-thread isolation).
  branch?: string;
  // True when workDir is a bot-managed worktree we may remove on cleanup.
  isWorktree: boolean;
  createdAt: number;
}

// A run whose agent process is detached and surviving across bot restarts. The
// bot tails `logPath` from `stdoutOffset` to stream the agent's output; on
// startup it re-attaches to every row here. Deleted once the run finalizes.
export interface ActiveRun {
  runId: string;
  threadId: string;
  channelId: string;
  agent: string;
  workDir: string;
  pid: number;
  logPath: string;
  // Byte offset of fully-consumed (complete-line) output already handed to the
  // outbox. Resume point after a restart.
  stdoutOffset: number;
  startedAt: number;
  // Optional JSON-encoded action to run when the run finishes (e.g. post a PR
  // summary). Persisted so it survives a restart — see SessionManager's
  // CompletionAction. Opaque to the DB layer.
  completionJson?: string;
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
    this.migrate();
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_sessions (
        thread_id   TEXT PRIMARY KEY,
        channel_id  TEXT NOT NULL,
        agent       TEXT NOT NULL,
        session_id  TEXT,
        work_dir    TEXT NOT NULL,
        branch      TEXT,
        is_worktree INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS channel_hidden_tools (
        channel_id  TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        hidden      INTEGER NOT NULL,
        PRIMARY KEY (channel_id, tool_name)
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

      CREATE TABLE IF NOT EXISTS active_runs (
        run_id          TEXT PRIMARY KEY,
        thread_id       TEXT NOT NULL,
        channel_id      TEXT NOT NULL,
        agent           TEXT NOT NULL,
        work_dir        TEXT NOT NULL,
        pid             INTEGER NOT NULL,
        log_path        TEXT NOT NULL,
        stdout_offset   INTEGER NOT NULL DEFAULT 0,
        started_at      INTEGER NOT NULL,
        completion_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_active_runs_thread
        ON active_runs (thread_id);

      CREATE TABLE IF NOT EXISTS pr_threads (
        pr_number       TEXT NOT NULL,
        repo            TEXT NOT NULL,
        maker_thread_id TEXT,
        test_thread_id  TEXT,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (pr_number, repo)
      );
    `);
  }

  // Add columns to tables that predate them. ALTER TABLE ADD COLUMN is a no-op
  // error if the column already exists, so we guard on the table's column list.
  private migrate(): void {
    const cols = (this.db.prepare(`PRAGMA table_info(thread_sessions)`).all() as any[]).map(
      (c) => c.name as string
    );
    if (!cols.includes("branch")) {
      this.db.exec(`ALTER TABLE thread_sessions ADD COLUMN branch TEXT`);
    }
    if (!cols.includes("is_worktree")) {
      this.db.exec(`ALTER TABLE thread_sessions ADD COLUMN is_worktree INTEGER NOT NULL DEFAULT 0`);
    }
    // active_runs shipped before completion_json existed, so a DB created by that
    // build has the table but not the column. initializeTables() runs first, so
    // the table always exists here — just add the column when it's missing.
    const runCols = (this.db.prepare(`PRAGMA table_info(active_runs)`).all() as any[]).map(
      (c) => c.name as string
    );
    if (!runCols.includes("completion_json")) {
      this.db.exec(`ALTER TABLE active_runs ADD COLUMN completion_json TEXT`);
    }
    // Drop the obsolete all-or-nothing tool-visibility table (replaced by the
    // per-tool channel_hidden_tools table).
    this.db.exec(`DROP TABLE IF EXISTS channel_tool_visibility`);
  }

  // ── Thread sessions ──────────────────────────────────────────────────────

  createThreadSession(ts: ThreadSession): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO thread_sessions
         (thread_id, channel_id, agent, session_id, work_dir, branch, is_worktree, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ts.threadId,
        ts.channelId,
        ts.agent,
        ts.sessionId ?? null,
        ts.workDir,
        ts.branch ?? null,
        ts.isWorktree ? 1 : 0,
        ts.createdAt
      );
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
      branch: row.branch ?? undefined,
      isWorktree: !!row.is_worktree,
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

  // ── Tool-message visibility ──────────────────────────────────────────────

  // Per-channel overrides: { toolName: hidden }. Combine with DEFAULT_HIDDEN_TOOLS
  // via toolIsHidden() to get the effective visibility for a tool.
  getToolOverrides(channelId: string): Record<string, boolean> {
    const rows = this.db
      .prepare(`SELECT tool_name, hidden FROM channel_hidden_tools WHERE channel_id = ?`)
      .all(channelId) as any[];
    const out: Record<string, boolean> = {};
    for (const r of rows) out[r.tool_name] = !!r.hidden;
    return out;
  }

  setToolHidden(channelId: string, toolName: string, hidden: boolean): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO channel_hidden_tools (channel_id, tool_name, hidden) VALUES (?, ?, ?)`
      )
      .run(channelId, toolName, hidden ? 1 : 0);
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

  // ── Active runs ──────────────────────────────────────────────────────────

  private rowToActiveRun(row: any): ActiveRun {
    return {
      runId: row.run_id,
      threadId: row.thread_id,
      channelId: row.channel_id,
      agent: row.agent,
      workDir: row.work_dir,
      pid: row.pid,
      logPath: row.log_path,
      stdoutOffset: row.stdout_offset,
      startedAt: row.started_at,
      completionJson: row.completion_json ?? undefined,
    };
  }

  createActiveRun(run: ActiveRun): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO active_runs
         (run_id, thread_id, channel_id, agent, work_dir, pid, log_path, stdout_offset, started_at, completion_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.runId,
        run.threadId,
        run.channelId,
        run.agent,
        run.workDir,
        run.pid,
        run.logPath,
        run.stdoutOffset,
        run.startedAt,
        run.completionJson ?? null
      );
  }

  // Synchronous offset checkpoint — called at the end of each tail tick so a
  // restart resumes from the last fully-consumed line boundary.
  updateActiveRunOffset(runId: string, offset: number): void {
    this.db.prepare(`UPDATE active_runs SET stdout_offset = ? WHERE run_id = ?`).run(offset, runId);
  }

  deleteActiveRun(runId: string): void {
    this.db.prepare(`DELETE FROM active_runs WHERE run_id = ?`).run(runId);
  }

  // Forget every run for a thread (e.g. a new run is replacing it, or the
  // thread/worktree is being torn down).
  deleteActiveRunsForThread(threadId: string): void {
    this.db.prepare(`DELETE FROM active_runs WHERE thread_id = ?`).run(threadId);
  }

  listActiveRuns(): ActiveRun[] {
    const rows = this.db.prepare(`SELECT * FROM active_runs ORDER BY started_at ASC`).all() as any[];
    return rows.map((r) => this.rowToActiveRun(r));
  }

  hasActiveRun(threadId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM active_runs WHERE thread_id = ? LIMIT 1`).get(threadId);
    return !!row;
  }

  // ── PR threads ───────────────────────────────────────────────────────────

  getPrThreads(prNumber: string, repo: string): { makerThreadId?: string; testThreadId?: string } | null {
    const row = this.db
      .prepare(`SELECT * FROM pr_threads WHERE pr_number = ? AND repo = ?`)
      .get(prNumber, repo) as any;
    if (!row) return null;
    return {
      makerThreadId: row.maker_thread_id ?? undefined,
      testThreadId: row.test_thread_id ?? undefined,
    };
  }

  setPrMakerThread(prNumber: string, repo: string, makerThreadId: string): void {
    this.db
      .prepare(
        `INSERT INTO pr_threads (pr_number, repo, maker_thread_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (pr_number, repo) DO UPDATE SET maker_thread_id = excluded.maker_thread_id`
      )
      .run(prNumber, repo, makerThreadId, Date.now());
  }

  setPrTestThread(prNumber: string, repo: string, testThreadId: string): void {
    this.db
      .prepare(
        `INSERT INTO pr_threads (pr_number, repo, test_thread_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (pr_number, repo) DO UPDATE SET test_thread_id = excluded.test_thread_id`
      )
      .run(prNumber, repo, testThreadId, Date.now());
  }

  // Find the most recent CC session whose work_dir matches a repo name.
  // Used to link a newly opened PR back to the Discord thread that created it.
  findMakerThreadForRepo(repoName: string): string | null {
    const row = this.db
      .prepare(
        `SELECT thread_id FROM thread_sessions
         WHERE work_dir LIKE ? AND agent = 'cc'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(`%/${repoName}%`) as any;
    return row?.thread_id ?? null;
  }
}
