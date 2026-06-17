import type { DatabaseManager } from "../db/database.js";

export function isDiscordBranch(branch: string): boolean {
  return branch.startsWith("discord/");
}

/** True when a thread session's branch matches the PR head branch. */
export function makerThreadMatchesBranch(
  db: DatabaseManager,
  threadId: string,
  headBranch: string
): boolean {
  if (!headBranch) return false;
  const session = db.getThreadSession(threadId);
  if (!session?.branch) return false;
  return session.branch === headBranch;
}

/**
 * Resolve a maker thread only when the link is definitive: an exact branch match
 * via findThreadByBranch, or a stored pr_threads link whose session branch
 * matches headBranch. Never guesses from repo-wide "latest thread".
 */
export function resolveDefinitiveMakerThread(
  db: DatabaseManager,
  repo: string,
  repoName: string,
  prNumber: number | null,
  headBranch: string
): string | null {
  if (headBranch) {
    const byBranch = db.findThreadByBranch(headBranch);
    if (byBranch) return byBranch;
  }

  if (!prNumber) return null;

  const makerThreadId =
    db.getPrThreads(String(prNumber), repo)?.makerThreadId ??
    db.getPrThreads(String(prNumber), repoName)?.makerThreadId;

  if (!makerThreadId) return null;
  if (!headBranch) return makerThreadId;
  return makerThreadMatchesBranch(db, makerThreadId, headBranch) ? makerThreadId : null;
}

/**
 * For PR linking on open: only discord/* branches created by the bot can be
 * linked to a maker thread. External branches get channel-only notifications.
 */
export function resolveDefinitiveMakerThreadForLink(
  db: DatabaseManager,
  headRef: string
): string | null {
  if (!isDiscordBranch(headRef)) return null;
  return db.findThreadByBranch(headRef);
}

/**
 * For gh-wrapper links where we only know the thread ID, allow linking only
 * when that thread session is currently on a discord/* branch.
 */
export function resolveKnownMakerThreadForLink(
  db: DatabaseManager,
  threadId: string
): string | null {
  const branch = db.getThreadSession(threadId)?.branch ?? "";
  return isDiscordBranch(branch) ? threadId : null;
}
