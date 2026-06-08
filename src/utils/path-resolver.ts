import * as path from "path";
import * as fs from "fs";
import { spawnSync } from "child_process";

const WORKTREE_SEPARATOR = "🌲";

// The bot's source repo root (src/utils/ -> repo root). When a channel would
// resolve here, we redirect into a worktree instead — see resolveWorkDir.
const BOT_REPO_ROOT = path.resolve(__dirname, "..", "..");
// Branch/dir name for the bot's own-repo sandbox worktree.
const BOT_WORKTREE_NAME = "bot-sandbox";

export interface ResolvedPath {
  workDir: string;
  repo: string;
  worktree?: string;
}

// Resolve (creating if needed) a worktree of `repoPath` at `wtPath`, on branch
// `branch`. Returns true on success.
function ensureWorktree(repoPath: string, wtPath: string, branch: string): boolean {
  if (fs.existsSync(wtPath)) return true;
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const result = spawnSync("git", ["-C", repoPath, "worktree", "add", "-b", branch, wtPath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    // Branch may already exist — try checking it out into the worktree instead.
    const result2 = spawnSync("git", ["-C", repoPath, "worktree", "add", wtPath, branch], {
      encoding: "utf8",
    });
    if (result2.status !== 0) {
      console.error(`Failed to create worktree at ${wtPath}: ${result2.stderr}`);
      return false;
    }
  }
  return fs.existsSync(wtPath);
}

// True when `dir` is the bot's own running source checkout. Compared via
// realpath so a symlinked BASE_FOLDER still matches.
function isBotOwnRepo(dir: string): boolean {
  try {
    return fs.realpathSync(dir) === fs.realpathSync(BOT_REPO_ROOT);
  } catch {
    return false;
  }
}

export function resolveWorkDir(channelName: string, baseFolder: string): ResolvedPath | null {
  const separatorIndex = channelName.indexOf(WORKTREE_SEPARATOR);

  if (separatorIndex === -1) {
    // Plain repo channel
    const workDir = path.join(baseFolder, channelName);
    if (!fs.existsSync(workDir)) return null;

    // Never let the bot operate directly in its own live checkout — that's the
    // directory the service runs from and a maintainer edits, so a bot session
    // there races their git state. Redirect into an isolated worktree instead.
    if (isBotOwnRepo(workDir)) {
      const wtPath = path.join(baseFolder, "worktrees", channelName, BOT_WORKTREE_NAME);
      if (!ensureWorktree(workDir, wtPath, BOT_WORKTREE_NAME)) return null;
      console.log(`[path-resolver] '${channelName}' is the bot's own repo; using worktree ${wtPath}`);
      return { workDir: wtPath, repo: channelName, worktree: BOT_WORKTREE_NAME };
    }

    return { workDir, repo: channelName };
  }

  const repo = channelName.slice(0, separatorIndex);
  const worktree = channelName.slice(separatorIndex + WORKTREE_SEPARATOR.length);

  if (!repo || !worktree) return null;

  const repoPath = path.join(baseFolder, repo);
  if (!fs.existsSync(repoPath)) return null;

  const wtPath = path.join(baseFolder, "worktrees", repo, worktree);

  if (!ensureWorktree(repoPath, wtPath, worktree)) return null;

  return { workDir: wtPath, repo, worktree };
}

export function listWorktrees(channelName: string, baseFolder: string): string[] {
  const separatorIndex = channelName.indexOf(WORKTREE_SEPARATOR);
  const repo = separatorIndex === -1 ? channelName : channelName.slice(0, separatorIndex);
  const repoPath = path.join(baseFolder, repo);

  if (!fs.existsSync(repoPath)) return [];

  const result = spawnSync("git", ["-C", repoPath, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return [];

  return result.stdout
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const worktreeLine = block.split("\n").find((l) => l.startsWith("worktree "));
      return worktreeLine ? worktreeLine.replace("worktree ", "") : "";
    })
    .filter(Boolean);
}

export function pruneWorktrees(channelName: string, baseFolder: string): string {
  const separatorIndex = channelName.indexOf(WORKTREE_SEPARATOR);
  const repo = separatorIndex === -1 ? channelName : channelName.slice(0, separatorIndex);
  const repoPath = path.join(baseFolder, repo);

  if (!fs.existsSync(repoPath)) return "Repository not found.";

  const result = spawnSync("git", ["-C", repoPath, "worktree", "prune"], { encoding: "utf8" });
  return result.status === 0 ? "Stale worktrees pruned." : `Error: ${result.stderr}`;
}
