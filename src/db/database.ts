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
}
