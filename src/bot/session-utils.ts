import * as path from "path";
import type { ThreadChannel, TextChannel } from "discord.js";
import type { DatabaseManager, ThreadSession } from "../db/database.js";
import { parseAgentFromThreadName, titleFromThreadName } from "./parser.js";

/**
 * Create or update a thread session with the given parameters.
 * This is the single source of truth for session creation across the codebase.
 *
 * @param db Database manager
 * @param threadId Thread ID
 * @param channelId Parent channel ID
 * @param agentKey Agent key (cc, cx, cs)
 * @param workDir Working directory path
 * @param opts Optional parameters (branch, isWorktree, modelOverride, createdAt)
 */
export function ensureThreadSession(
  db: DatabaseManager,
  threadId: string,
  channelId: string,
  agentKey: string,
  workDir: string,
  opts?: {
    branch?: string;
    isWorktree?: boolean;
    modelOverride?: string;
    createdAt?: number;
  }
): void {
  const existing = db.getThreadSession(threadId);

  if (!existing || existing.agent !== agentKey) {
    // Create new session or replace with different agent
    db.createThreadSession({
      threadId,
      channelId,
      agent: agentKey,
      workDir,
      branch: opts?.branch ?? existing?.branch,
      isWorktree: opts?.isWorktree ?? existing?.isWorktree ?? false,
      createdAt: opts?.createdAt ?? existing?.createdAt ?? Date.now(),
      modelOverride: opts?.modelOverride,
    });
    console.log(`[session] created session for ${threadId} (agent=${agentKey})`);
  } else {
    // Update existing session if model override changed
    if (opts?.modelOverride !== undefined && opts.modelOverride !== existing.modelOverride) {
      db.updateModelOverride(threadId, opts.modelOverride);
    }
  }
}

/**
 * Create a minimal session for an orphaned thread (thread with no session).
 * Parses agent from thread name and creates session without starting a run.
 * Returns true if session was created, false if unable to create.
 */
export function createOrphanedThreadSession(
  thread: ThreadChannel,
  db: DatabaseManager,
  baseFolder: string
): boolean {
  const agentKey = parseAgentFromThreadName(thread.name);
  if (!agentKey) return false;

  const parent = thread.parent as TextChannel | null;
  if (!parent) return false;

  const workDir = path.join(baseFolder, parent.name);

  ensureThreadSession(db, thread.id, parent.id, agentKey, workDir, {
    isWorktree: false,
  });

  return true;
}
