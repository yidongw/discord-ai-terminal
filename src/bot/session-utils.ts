import * as path from "path";
import type { ThreadChannel, TextChannel } from "discord.js";
import type { DatabaseManager } from "../db/database.js";
import { parseAgentFromThreadName, titleFromThreadName } from "./parser.js";

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

  const titleLabel = titleFromThreadName(thread.name) ?? "thread";
  const workDir = path.join(baseFolder, parent.name);

  db.createThreadSession({
    threadId: thread.id,
    channelId: parent.id,
    agent: agentKey,
    workDir,
    isWorktree: false,
    createdAt: Date.now(),
  });

  console.log(`[session] created session for orphaned thread ${thread.id} (agent=${agentKey})`);
  return true;
}
