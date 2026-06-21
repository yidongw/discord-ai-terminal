import type { ThreadChannel, TextChannel } from "discord.js";
import { parseAgentFromThreadName, titleFromThreadName } from "./parser.js";
import { resolveThreadWorkDir } from "../utils/path-resolver.js";
import type { DatabaseManager, ThreadSession } from "../db/database.js";

/** Derive the handoff target name from the Discord bot that sent the message. */
export function handoffBotNameFromAuthor(author: { username: string }): string {
  return author.username;
}

/** Create a thread session record without starting an agent run. */
export function ensureMinimalThreadSession(
  db: DatabaseManager,
  thread: ThreadChannel,
  baseFolder: string,
  agentKey?: string
): ThreadSession | null {
  const existing = db.getThreadSession(thread.id);
  if (existing) return existing;

  const resolvedAgent = agentKey ?? parseAgentFromThreadName(thread.name);
  if (!resolvedAgent) return null;

  const parent = thread.parent as TextChannel | null;
  if (!parent) return null;

  const titleLabel = titleFromThreadName(thread.name) ?? "thread";
  const resolved = resolveThreadWorkDir(parent.name, thread.id, titleLabel, baseFolder);
  if (!resolved) return null;

  db.createThreadSession({
    threadId: thread.id,
    channelId: parent.id,
    agent: resolvedAgent,
    workDir: resolved.workDir,
    branch: resolved.branch,
    isWorktree: !!resolved.worktree,
    createdAt: Date.now(),
  });
  return db.getThreadSession(thread.id);
}

export function handoffDoneDescription(
  statsLine: string,
  summary: string,
  handoffBot: string,
  threadAgent: string
): string {
  const lines = [
    statsLine || "Complete.",
    "",
    summary,
    "",
    `@${handoffBot} — Please review the above and provide next steps or mark as complete. Use @${threadAgent} to continue.`,
  ];
  return lines.join("\n");
}

/** Truncate assistant output for the Done embed summary field. */
export function summarizeForHandoff(text: string, maxLen = 1500): string {
  const trimmed = text.trim();
  if (!trimmed) return "Work completed.";
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + "…";
}
