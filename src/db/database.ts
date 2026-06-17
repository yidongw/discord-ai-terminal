import { Database } from "bun:sqlite";
import * as path from "path";
import {
  type CcModel,
  type CodexModel,
  type CsModel,
  DEFAULT_CC_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CS_MODEL,
  normalizeCcModel,
  normalizeCodexModel,
  normalizeCsModel,
} from "../utils/models.js";

export type PermissionMode = "auto" | "plan" | "approve";
export type { CcModel, CodexModel, CsModel };
// Back-compat alias used by agent opts
export type ClaudeModel = CcModel;

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
  // Discord message ID of the last user message we handled. Used on restart to
  // fetch and replay any messages that arrived during downtime.
  lastSeenMessageId?: string;
  // Model override set via @mention suffix (e.g. @cx5.5). Persisted so all
  // follow-up messages in the thread use the same model, not the channel default.
  modelOverride?: string;
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

// A long-running shell command the user asked cc to run "in the background".
// The command runs detached (surviving bot restarts); when it finishes the bot
// re-invokes cc with its output. status goes running → finished; the row is
// deleted once cc has been woken with the result.
export interface BackgroundJob {
  jobId: string;
  threadId: string;
  channelId: string;
  workDir: string;
  command: string;
  label?: string;
  pid: number;
  logPath: string;
  status: "running" | "finished";
  exitCode?: number | null;
  startedAt: number;
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
  // When set, active_run mutations are mirrored here so a separate bot process
  // (e.g. the main bot after a restart) can re-attach to runs started by a
  // worker that used an isolated DB.
  private mirrorDb?: DatabaseManager;

  constructor(dbPath?: string) {
    const finalPath = dbPath || path.join(process.cwd(), "sessions.db");
    this.db = new Database(finalPath);
    this.initializeTables();
    this.migrate();
  }

  setMirrorDb(db: DatabaseManager): void {
    this.mirrorDb = db;
  }

  private initializeTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_sessions (
        thread_id             TEXT PRIMARY KEY,
        channel_id            TEXT NOT NULL,
        agent                 TEXT NOT NULL,
        session_id            TEXT,
        work_dir              TEXT NOT NULL,
        branch                TEXT,
        is_worktree           INTEGER NOT NULL DEFAULT 0,
        created_at            INTEGER NOT NULL,
        last_seen_message_id  TEXT,
        model_override        TEXT
      );

      CREATE TABLE IF NOT EXISTS channel_modes (
        channel_id  TEXT PRIMARY KEY,
        mode        TEXT NOT NULL DEFAULT 'auto'
      );

      CREATE TABLE IF NOT EXISTS channel_models (
        channel_id  TEXT PRIMARY KEY,
        model       TEXT NOT NULL DEFAULT 'claude-sonnet-4-6'
      );

      CREATE TABLE IF NOT EXISTS channel_codex_models (
        channel_id  TEXT PRIMARY KEY,
        model       TEXT NOT NULL DEFAULT 'gpt-5.4-mini'
      );

      CREATE TABLE IF NOT EXISTS channel_cs_models (
        channel_id  TEXT PRIMARY KEY,
        model       TEXT NOT NULL DEFAULT 'auto'
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

      CREATE TABLE IF NOT EXISTS background_jobs (
        job_id      TEXT PRIMARY KEY,
        thread_id   TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        work_dir    TEXT NOT NULL,
        command     TEXT NOT NULL,
        label       TEXT,
        pid         INTEGER NOT NULL,
        log_path    TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'running',
        exit_code   INTEGER,
        started_at  INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_background_jobs_thread
        ON background_jobs (thread_id);

      CREATE TABLE IF NOT EXISTS pr_threads (
        pr_number       TEXT NOT NULL,
        repo            TEXT NOT NULL,
        maker_thread_id TEXT,
        test_thread_id  TEXT,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (pr_number, repo)
      );

      CREATE TABLE IF NOT EXISTS restart_notification (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL
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
    if (!cols.includes("last_seen_message_id")) {
      this.db.exec(`ALTER TABLE thread_sessions ADD COLUMN last_seen_message_id TEXT`);
    }
    if (!cols.includes("model_override")) {
      this.db.exec(`ALTER TABLE thread_sessions ADD COLUMN model_override TEXT`);
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

    const prCols = (this.db.prepare(`PRAGMA table_info(pr_threads)`).all() as any[]).map(
      (c) => c.name as string
    );
    if (!prCols.includes("failed_tests")) {
      this.db.exec(`ALTER TABLE pr_threads ADD COLUMN failed_tests TEXT`);
    }
    if (!prCols.includes("tests_skipped")) {
      this.db.exec(`ALTER TABLE pr_threads ADD COLUMN tests_skipped INTEGER NOT NULL DEFAULT 0`);
    }
    if (!prCols.includes("closed_notified")) {
      this.db.exec(`ALTER TABLE pr_threads ADD COLUMN closed_notified INTEGER NOT NULL DEFAULT 0`);
    }
  }

  // ── Thread sessions ──────────────────────────────────────────────────────

  createThreadSession(ts: ThreadSession): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO thread_sessions
         (thread_id, channel_id, agent, session_id, work_dir, branch, is_worktree, created_at, last_seen_message_id, model_override)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ts.threadId,
        ts.channelId,
        ts.agent,
        ts.sessionId ?? null,
        ts.workDir,
        ts.branch ?? null,
        ts.isWorktree ? 1 : 0,
        ts.createdAt,
        ts.lastSeenMessageId ?? null,
        ts.modelOverride ?? null
      );
  }

  updateModelOverride(threadId: string, modelOverride: string | null): void {
    this.db
      .prepare(`UPDATE thread_sessions SET model_override = ? WHERE thread_id = ?`)
      .run(modelOverride, threadId);
  }

  getThreadSession(threadId: string): ThreadSession | null {
    const row = this.db
      .prepare(`SELECT * FROM thread_sessions WHERE thread_id = ?`)
      .get(threadId) as any;
    if (!row) return null;
    return this.rowToThreadSession(row);
  }

  private rowToThreadSession(row: any): ThreadSession {
    return {
      threadId: row.thread_id,
      channelId: row.channel_id,
      agent: row.agent,
      sessionId: row.session_id ?? undefined,
      workDir: row.work_dir,
      branch: row.branch ?? undefined,
      isWorktree: !!row.is_worktree,
      createdAt: row.created_at,
      lastSeenMessageId: row.last_seen_message_id ?? undefined,
      modelOverride: row.model_override ?? undefined,
    };
  }

  getAllThreadSessions(): ThreadSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM thread_sessions ORDER BY created_at DESC`)
      .all() as any[];
    return rows.map((r) => this.rowToThreadSession(r));
  }

  updateLastSeenMessageId(threadId: string, messageId: string): void {
    this.db
      .prepare(`UPDATE thread_sessions SET last_seen_message_id = ? WHERE thread_id = ?`)
      .run(messageId, threadId);
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

  getModel(channelId: string): CcModel {
    const row = this.db
      .prepare(`SELECT model FROM channel_models WHERE channel_id = ?`)
      .get(channelId) as any;
    return normalizeCcModel(row?.model);
  }

  setModel(channelId: string, model: CcModel): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_models (channel_id, model) VALUES (?, ?)`)
      .run(channelId, model);
  }

  getCodexModel(channelId: string): CodexModel {
    const row = this.db
      .prepare(`SELECT model FROM channel_codex_models WHERE channel_id = ?`)
      .get(channelId) as any;
    return normalizeCodexModel(row?.model);
  }

  setCodexModel(channelId: string, model: CodexModel): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_codex_models (channel_id, model) VALUES (?, ?)`)
      .run(channelId, model);
  }

  getCsModel(channelId: string): CsModel {
    const row = this.db
      .prepare(`SELECT model FROM channel_cs_models WHERE channel_id = ?`)
      .get(channelId) as any;
    return normalizeCsModel(row?.model);
  }

  setCsModel(channelId: string, model: CsModel): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO channel_cs_models (channel_id, model) VALUES (?, ?)`)
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

  updateScheduledTaskPrompt(id: string, prompt: string): void {
    this.db.prepare(`UPDATE scheduled_tasks SET prompt = ? WHERE id = ?`).run(prompt, id);
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
    this.mirrorDb?.createActiveRun(run);
  }

  // Synchronous offset checkpoint — called at the end of each tail tick so a
  // restart resumes from the last fully-consumed line boundary.
  updateActiveRunOffset(runId: string, offset: number): void {
    this.db.prepare(`UPDATE active_runs SET stdout_offset = ? WHERE run_id = ?`).run(offset, runId);
    this.mirrorDb?.updateActiveRunOffset(runId, offset);
  }

  deleteActiveRun(runId: string): void {
    this.db.prepare(`DELETE FROM active_runs WHERE run_id = ?`).run(runId);
    this.mirrorDb?.deleteActiveRun(runId);
  }

  // Forget every run for a thread (e.g. a new run is replacing it, or the
  // thread/worktree is being torn down).
  deleteActiveRunsForThread(threadId: string): void {
    this.db.prepare(`DELETE FROM active_runs WHERE thread_id = ?`).run(threadId);
    this.mirrorDb?.deleteActiveRunsForThread(threadId);
  }

  listActiveRuns(): ActiveRun[] {
    const rows = this.db.prepare(`SELECT * FROM active_runs ORDER BY started_at ASC`).all() as any[];
    return rows.map((r) => this.rowToActiveRun(r));
  }

  hasActiveRun(threadId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM active_runs WHERE thread_id = ? LIMIT 1`).get(threadId);
    return !!row;
  }

  // ── Background jobs ──────────────────────────────────────────────────────

  private rowToBackgroundJob(row: any): BackgroundJob {
    return {
      jobId: row.job_id,
      threadId: row.thread_id,
      channelId: row.channel_id,
      workDir: row.work_dir,
      command: row.command,
      label: row.label ?? undefined,
      pid: row.pid,
      logPath: row.log_path,
      status: row.status,
      exitCode: row.exit_code ?? null,
      startedAt: row.started_at,
    };
  }

  createBackgroundJob(job: BackgroundJob): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO background_jobs
         (job_id, thread_id, channel_id, work_dir, command, label, pid, log_path, status, exit_code, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        job.jobId,
        job.threadId,
        job.channelId,
        job.workDir,
        job.command,
        job.label ?? null,
        job.pid,
        job.logPath,
        job.status,
        job.exitCode ?? null,
        job.startedAt
      );
  }

  listBackgroundJobs(threadId?: string): BackgroundJob[] {
    const rows = threadId
      ? (this.db
          .prepare(`SELECT * FROM background_jobs WHERE thread_id = ? ORDER BY started_at ASC`)
          .all(threadId) as any[])
      : (this.db
          .prepare(`SELECT * FROM background_jobs ORDER BY started_at ASC`)
          .all() as any[]);
    return rows.map((r) => this.rowToBackgroundJob(r));
  }

  getBackgroundJob(jobId: string): BackgroundJob | null {
    const row = this.db.prepare(`SELECT * FROM background_jobs WHERE job_id = ?`).get(jobId) as any;
    return row ? this.rowToBackgroundJob(row) : null;
  }

  // Mark a job finished and record its exit code (null = died without a code).
  markBackgroundJobFinished(jobId: string, exitCode: number | null): void {
    this.db
      .prepare(`UPDATE background_jobs SET status = 'finished', exit_code = ? WHERE job_id = ?`)
      .run(exitCode, jobId);
  }

  deleteBackgroundJob(jobId: string): void {
    this.db.prepare(`DELETE FROM background_jobs WHERE job_id = ?`).run(jobId);
  }

  deleteBackgroundJobsForThread(threadId: string): void {
    this.db.prepare(`DELETE FROM background_jobs WHERE thread_id = ?`).run(threadId);
  }

  // ── PR threads ───────────────────────────────────────────────────────────

  getPrThreads(prNumber: string, repo: string): { makerThreadId?: string; testThreadId?: string; testsSkipped?: boolean } | null {
    const row = this.db
      .prepare(`SELECT * FROM pr_threads WHERE pr_number = ? AND repo = ?`)
      .get(prNumber, repo) as any;
    if (!row) return null;
    return {
      makerThreadId: row.maker_thread_id ?? undefined,
      testThreadId: row.test_thread_id ?? undefined,
      testsSkipped: row.tests_skipped === 1,
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

  setPrTestsSkipped(prNumber: string, repo: string, skipped: boolean): void {
    this.db
      .prepare(
        `INSERT INTO pr_threads (pr_number, repo, tests_skipped, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (pr_number, repo) DO UPDATE SET tests_skipped = excluded.tests_skipped`
      )
      .run(prNumber, repo, skipped ? 1 : 0, Date.now());
  }

  isClosedNotified(prNumber: string, repo: string): boolean {
    const row = this.db
      .prepare(`SELECT closed_notified FROM pr_threads WHERE pr_number = ? AND repo = ?`)
      .get(prNumber, repo) as any;
    return row?.closed_notified === 1;
  }

  setClosedNotified(prNumber: string, repo: string): void {
    this.db
      .prepare(
        `INSERT INTO pr_threads (pr_number, repo, closed_notified, created_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT (pr_number, repo) DO UPDATE SET closed_notified = 1`
      )
      .run(prNumber, repo, Date.now());
  }

  clearClosedNotified(prNumber: string, repo: string): void {
    this.db
      .prepare(`UPDATE pr_threads SET closed_notified = 0 WHERE pr_number = ? AND repo = ?`)
      .run(prNumber, repo);
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

  findThreadByBranch(branch: string): string | null {
    const row = this.db
      .prepare(`SELECT thread_id FROM thread_sessions WHERE branch = ? LIMIT 1`)
      .get(branch) as any;
    if (row?.thread_id) return row.thread_id;

    // Fuzzy fallback: branch names embed the thread's shortId (last 6 digits of
    // thread_id) as `discord/<slug>-<shortId>`. When the branch has extra segments
    // after the shortId (e.g. `-nav-id`), the exact match above fails. Extract all
    // 6-digit sequences and try each as a thread_id suffix.
    const segments = branch.match(/\d{6}/g) ?? [];
    for (const seg of segments) {
      const fuzzy = this.db
        .prepare(`SELECT thread_id FROM thread_sessions WHERE thread_id LIKE ? ORDER BY created_at DESC LIMIT 1`)
        .get(`%${seg}`) as any;
      if (fuzzy?.thread_id) return fuzzy.thread_id;
    }

    return null;
  }

  findPrForMakerThread(threadId: string): { prNumber: string; repo: string } | null {
    const row = this.db
      .prepare(`SELECT pr_number, repo FROM pr_threads WHERE maker_thread_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(threadId) as any;
    return row ? { prNumber: row.pr_number, repo: row.repo } : null;
  }

  // ── Restart notification ─────────────────────────────────────────────────

  setRestartNotification(channelId: string, messageId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO restart_notification (id, channel_id, message_id) VALUES (1, ?, ?)`
      )
      .run(channelId, messageId);
  }

  getRestartNotification(): { channelId: string; messageId: string } | null {
    const row = this.db
      .prepare(`SELECT channel_id, message_id FROM restart_notification WHERE id = 1`)
      .get() as any;
    if (!row) return null;
    return { channelId: row.channel_id, messageId: row.message_id };
  }

  clearRestartNotification(): void {
    this.db.prepare(`DELETE FROM restart_notification WHERE id = 1`).run();
  }
}
