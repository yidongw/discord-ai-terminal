import type { DatabaseManager } from "../db/database.js";

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
 * Resolve maker thread for PR linking on open/sync:
 * 1) exact branch match when available
 * 2) fallback to repo's latest maker thread
 * This allows linking for all branch prefixes.
 */
export function resolveDefinitiveMakerThreadForLink(
  db: DatabaseManager,
  headRef: string,
  repoName: string
): string | null {
  if (headRef) {
    const byBranch = db.findThreadByBranch(headRef);
    if (byBranch) return byBranch;
  }
  return db.findMakerThreadForRepo(repoName);
}
