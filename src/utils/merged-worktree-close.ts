import { spawnSync } from "child_process";
import fs from "fs";
import {
  mainRepoOf,
  worktreeCloseBlockReason,
  worktreePassesCloseCheck,
} from "./path-resolver.js";

const GIT_TIMEOUT_MS = 5000;
const GH_TIMEOUT_MS = 10000;

function git(workDir: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", ["-C", workDir, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

function gh(args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

export function parseGithubRepoFromRemote(remoteUrl: string): string | null {
  const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

/** True when `origin` is configured and points at a GitHub repo we can query. */
export function hasOriginRemote(workDir: string): boolean {
  const { ok, out } = git(workDir, ["remote", "get-url", "origin"]);
  if (!ok || !out) return false;
  return parseGithubRepoFromRemote(out) !== null;
}

/** True when HEAD is on `branch` and matches `origin/<branch>`. */
export function branchMatchesOrigin(workDir: string, branch: string): boolean {
  const headRef = git(workDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!headRef.ok || headRef.out !== branch) return false;

  spawnSync("git", ["-C", workDir, "fetch", "origin", branch], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });

  const local = git(workDir, ["rev-parse", "HEAD"]);
  const remote = git(workDir, ["rev-parse", `origin/${branch}`]);
  if (!local.ok || !remote.ok || !local.out || !remote.out) return false;
  return local.out === remote.out;
}

/** True when a merged PR exists for `branch` on the GitHub repo behind `origin`. */
export function isBranchPrMerged(workDir: string, branch: string, repo: string): boolean {
  const { ok, out } = gh([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "merged",
    "--json",
    "number",
    "--repo",
    repo,
  ]);
  if (!ok || !out) return false;

  try {
    const prs = JSON.parse(out) as Array<{ number: number }>;
    return prs.length > 0;
  } catch {
    return false;
  }
}

export type ThreadWorktreeCloseDecision =
  | { action: "forceRemove" }
  | { action: "block"; reason: string };

export const THREAD_WORKTREE_CLOSE_REASONS = {
  noOrigin: "no GitHub origin remote",
  branchMismatch: "branch does not match origin",
  prNotMerged: "PR is not merged",
} as const;

/**
 * Single guard for thread close/delete. Runs three checks in order:
 * 1. uncommitted changes
 * 2. branch matches origin
 * 3. PR merged
 *
 * Any failed check blocks with a reason; all pass → silent force remove.
 */
export function evaluateThreadWorktreeClose(
  workDir: string,
  branch: string | undefined
): ThreadWorktreeCloseDecision {
  if (!branch) {
    return { action: "block", reason: "no branch configured" };
  }

  // Worktree directory already gone (removed/pruned out of band). Nothing left to
  // protect — let close proceed so removeWorktree can clear the stale session.
  if (!fs.existsSync(workDir)) {
    return { action: "forceRemove" };
  }

  const repoPath = mainRepoOf(workDir);
  if (!repoPath) {
    return { action: "block", reason: "could not locate the parent repo" };
  }

  const { ok, out: remoteUrl } = git(workDir, ["remote", "get-url", "origin"]);
  const repo = ok && remoteUrl ? parseGithubRepoFromRemote(remoteUrl) : null;
  const prMerged = repo ? isBranchPrMerged(workDir, branch, repo) : false;

  // Check 1: uncommitted changes
  const blockReason = worktreeCloseBlockReason(repoPath, workDir);
  if (blockReason) return { action: "block", reason: blockReason };

  // Check 2: branch matches origin
  if (!repo) {
    return { action: "block", reason: THREAD_WORKTREE_CLOSE_REASONS.noOrigin };
  }
  if (!branchMatchesOrigin(workDir, branch)) {
    return { action: "block", reason: THREAD_WORKTREE_CLOSE_REASONS.branchMismatch };
  }

  // Check 3: PR merged
  if (!prMerged) {
    return { action: "block", reason: THREAD_WORKTREE_CLOSE_REASONS.prNotMerged };
  }

  return { action: "forceRemove" };
}

// Re-export for tests that exercise the shared dirty guard directly.
export { worktreePassesCloseCheck };
