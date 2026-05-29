import * as path from "path";
import * as fs from "fs";
import { spawnSync } from "child_process";

const WORKTREE_SEPARATOR = "🌲";

export interface ResolvedPath {
  workDir: string;
  repo: string;
  worktree?: string;
}

export function resolveWorkDir(channelName: string, baseFolder: string): ResolvedPath | null {
  const separatorIndex = channelName.indexOf(WORKTREE_SEPARATOR);

  if (separatorIndex === -1) {
    // Plain repo channel
    const workDir = path.join(baseFolder, channelName);
    if (!fs.existsSync(workDir)) return null;
    return { workDir, repo: channelName };
  }

  const repo = channelName.slice(0, separatorIndex);
  const worktree = channelName.slice(separatorIndex + WORKTREE_SEPARATOR.length);

  if (!repo || !worktree) return null;

  const repoPath = path.join(baseFolder, repo);
  if (!fs.existsSync(repoPath)) return null;

  const wtPath = path.join(repoPath, "worktrees", worktree);

  if (!fs.existsSync(wtPath)) {
    const result = spawnSync("git", ["-C", repoPath, "worktree", "add", "-b", worktree, wtPath], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      // Branch may already exist — try without -b
      const result2 = spawnSync("git", ["-C", repoPath, "worktree", "add", wtPath, worktree], {
        encoding: "utf8",
      });
      if (result2.status !== 0) {
        console.error(`Failed to create worktree: ${result2.stderr}`);
        return null;
      }
    }
  }

  if (!fs.existsSync(wtPath)) return null;
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
