import * as path from "path";
import * as fs from "fs";
import { spawnSync } from "child_process";

export interface ResolvedPath {
  workDir: string;
  repo: string;
  // Set when workDir is a bot-managed per-thread worktree (i.e. safe to remove
  // on cleanup). Absent for plain non-git folders that we run in directly.
  worktree?: boolean;
  branch?: string;
}

export interface WorktreeStatus {
  // Tracked uncommitted changes (staged, modified, deleted). Untracked files are
  // ignored — local artifacts like .env should not block thread close.
  dirty: boolean;
}

// Resolve the source repo directory for a channel. Returns null if the folder
// doesn't exist.
export function repoPathFor(channelName: string, baseFolder: string): string | null {
  const repoPath = path.join(baseFolder, channelName);
  return fs.existsSync(repoPath) ? repoPath : null;
}

function isGitRepo(repoPath: string): boolean {
  const result = spawnSync("git", ["-C", repoPath, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

// Isolated worktree checked out to an existing branch (e.g. a PR head branch for
// CI auto-fix). Reuses the same path for a given thread id.
export function resolveBranchWorkDir(
  repoName: string,
  baseFolder: string,
  threadId: string,
  branch: string
): string | null {
  const repoPath = repoPathFor(repoName, baseFolder);
  if (!repoPath) return null;
  if (!isGitRepo(repoPath)) return repoPath;

  const shortId = threadId.slice(-6);
  const wtPath = path.join(baseFolder, "worktrees", repoName, `ci-fix-${shortId}`);
  if (fs.existsSync(wtPath)) return wtPath;

  spawnSync("git", ["-C", repoPath, "fetch", "origin", branch], { encoding: "utf8" });

  let result = spawnSync(
    "git",
    ["-C", repoPath, "worktree", "add", "--detach", wtPath, `origin/${branch}`],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    result = spawnSync(
      "git",
      ["-C", repoPath, "worktree", "add", "--detach", wtPath, branch],
      { encoding: "utf8" }
    );
  }
  if (result.status !== 0) {
    console.error(
      `[path-resolver] CI fix worktree failed for ${branch} at ${wtPath}: ${result.stderr}`
    );
    return null;
  }

  console.log(`[path-resolver] CI fix thread ${threadId} → worktree ${wtPath} (branch ${branch})`);
  return wtPath;
}

// The repo's default branch. Prefer origin/HEAD (e.g. "dev" for carbon), fall
// back to the currently checked-out branch, then "main".
export function defaultBranch(repoPath: string): string {
  const head = spawnSync("git", ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
    encoding: "utf8",
  });
  if (head.status === 0) {
    const ref = head.stdout.trim().replace(/^origin\//, "");
    if (ref) return ref;
  }
  const current = spawnSync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  });
  if (current.status === 0) {
    const ref = current.stdout.trim();
    if (ref && ref !== "HEAD") return ref;
  }
  return "main";
}

// Turn a thread name into a filesystem/branch-safe slug.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "") || "thread";
}

// Resolve (creating if needed) an isolated worktree for a single Discord thread.
// Each thread gets its own branch off the repo's default branch so concurrent
// threads in the same channel never touch each other's git state.
//
// Pass `baseBranch` to branch off a specific local branch (e.g. a parent
// thread's branch) instead of the repo's default branch.
//
// Falls back to running directly in the channel folder when it isn't a git repo
// (we can't make worktrees there); that path returns no `worktree`/`branch`.
export function resolveThreadWorkDir(
  channelName: string,
  threadId: string,
  label: string,
  baseFolder: string,
  baseBranch?: string
): ResolvedPath | null {
  const repoPath = repoPathFor(channelName, baseFolder);
  if (!repoPath) return null;

  if (!isGitRepo(repoPath)) {
    return { workDir: repoPath, repo: channelName };
  }

  const shortId = threadId.slice(-6);
  const slug = slugify(label);
  const branch = `discord/${slug}-${shortId}`;
  const wtDir = `${slug}-${shortId}`;
  const wtPath = path.join(baseFolder, "worktrees", channelName, wtDir);

  if (fs.existsSync(wtPath)) {
    return { workDir: wtPath, repo: channelName, worktree: true, branch };
  }

  let worktreeBase: string;
  let base: string;
  if (baseBranch) {
    // Branch off a caller-supplied branch (e.g. a parent thread's local branch).
    // Skip the remote fetch — the branch already exists locally.
    base = baseBranch;
    worktreeBase = baseBranch;
  } else {
    // Fetch and refresh origin/HEAD before computing the base branch, so repos
    // whose remote default changed after cloning (e.g. main→dev) get the right base.
    spawnSync("git", ["-C", repoPath, "fetch", "origin"], { encoding: "utf8" });
    spawnSync("git", ["-C", repoPath, "remote", "set-head", "origin", "--auto"], { encoding: "utf8" });
    base = defaultBranch(repoPath);
    worktreeBase = `origin/${base}`;
  }

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  // Try the computed base first; fall back to local branch for repos without a
  // remote, or when a pre-supplied baseBranch is already local-only.
  let result = spawnSync(
    "git",
    ["-C", repoPath, "worktree", "add", "-b", branch, wtPath, worktreeBase],
    { encoding: "utf8" }
  );
  if (result.status !== 0 && !baseBranch) {
    result = spawnSync(
      "git",
      ["-C", repoPath, "worktree", "add", "-b", branch, wtPath, base],
      { encoding: "utf8" }
    );
  }
  if (result.status !== 0) {
    // Branch may already exist (e.g. a re-created thread reusing the name) —
    // check it out into the worktree instead of branching anew.
    const retry = spawnSync(
      "git",
      ["-C", repoPath, "worktree", "add", wtPath, branch],
      { encoding: "utf8" }
    );
    if (retry.status !== 0) {
      console.error(`Failed to create worktree at ${wtPath}: ${result.stderr || retry.stderr}`);
      return null;
    }
  }

  console.log(`[path-resolver] thread ${threadId} → worktree ${wtPath} (branch ${branch}, base ${base})`);
  return { workDir: wtPath, repo: channelName, worktree: true, branch };
}

// Given a worktree path, find the main repo checkout it belongs to (via the
// shared .git common dir). Lets cleanup work from just the stored workDir.
export function mainRepoOf(wtPath: string): string | null {
  const result = spawnSync(
    "git",
    ["-C", wtPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" }
  );
  if (result.status !== 0) return null;
  const gitDir = result.stdout.trim();
  return gitDir ? path.dirname(gitDir) : null;
}

// Inspect a worktree for tracked uncommitted changes that cleanup must not discard.
export function worktreeStatus(repoPath: string, wtPath: string): WorktreeStatus {
  const status = spawnSync(
    "git",
    ["-C", wtPath, "status", "--porcelain", "--untracked-files=no"],
    { encoding: "utf8" }
  );
  const dirty = status.status === 0 ? status.stdout.trim().length > 0 : true;
  return { dirty };
}

/** True when the worktree has no uncommitted changes. */
export function worktreePassesCloseCheck(repoPath: string, wtPath: string): boolean {
  return !worktreeStatus(repoPath, wtPath).dirty;
}

export function worktreeCloseBlockReason(repoPath: string, wtPath: string): string | null {
  if (worktreePassesCloseCheck(repoPath, wtPath)) return null;
  return "uncommitted changes";
}

export interface RemoveResult {
  removed: boolean;
  reason?: string;
}

// Remove a thread's worktree and delete its branch. Policy checks belong to the
// caller — this only runs git removal.
export function removeWorktree(
  repoPath: string,
  wtPath: string,
  branch: string | undefined,
  force: boolean
): RemoveResult {
  if (!fs.existsSync(wtPath)) {
    return { removed: true, reason: "already gone" };
  }

  const removeArgs = ["-C", repoPath, "worktree", "remove", wtPath];
  if (force) removeArgs.push("--force");
  const rm = spawnSync("git", removeArgs, { encoding: "utf8" });
  if (rm.status !== 0) {
    return { removed: false, reason: rm.stderr.trim() || "git worktree remove failed" };
  }

  if (branch) {
    spawnSync("git", ["-C", repoPath, "branch", force ? "-D" : "-d", branch], {
      encoding: "utf8",
    });
  }
  spawnSync("git", ["-C", repoPath, "worktree", "prune"], { encoding: "utf8" });

  return { removed: true };
}
