import { describe, it, expect, vi, beforeEach } from "vitest";

const { spawnSync, existsSync, mkdirSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawnSync,
}));

vi.mock("fs", () => ({
  default: { existsSync, mkdirSync },
  existsSync,
  mkdirSync,
}));

import { ensureThreadWorkDir } from "../../src/utils/path-resolver.js";

function gitResult(stdout = "", status = 0, stderr = "") {
  return { status, stdout, stderr };
}

describe("ensureThreadWorkDir", () => {
  const baseFolder = "/base";
  const channelName = "foxhole-bot";
  const threadId = "1544534832120463441"; // shortId = 463441
  const repoPath = `${baseFolder}/${channelName}`;

  beforeEach(() => {
    spawnSync.mockReset();
    existsSync.mockReset();
    mkdirSync.mockReset();
    // Default: channel folder is a git repo.
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args.includes("--is-inside-work-tree")) {
        return gitResult("true\n");
      }
      return gitResult();
    });
  });

  it("returns the existing workDir unchanged when present", () => {
    const workDir = `${baseFolder}/worktrees/${channelName}/where-are-you-463441`;
    existsSync.mockImplementation((p: string) => p === workDir || p === repoPath);

    const resolved = ensureThreadWorkDir({
      channelName,
      threadId,
      workDir,
      branch: "discord/where-are-you-463441",
      baseFolder,
    });

    expect(resolved).toEqual({
      workDir,
      repo: channelName,
      worktree: true,
      branch: "discord/where-are-you-463441",
    });
    expect(spawnSync).not.toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["worktree", "add"]),
      expect.anything()
    );
  });

  it("reuses an existing checkout of the stored branch when workDir is gone", () => {
    const stale = `${baseFolder}/worktrees/${channelName}/schedule-30-minute-cc-wake-checks-324866`;
    const branchPath = `${baseFolder}/worktrees/${channelName}/where-are-you-463441`;
    const branch = "discord/where-are-you-463441";

    existsSync.mockImplementation((p: string) => {
      if (p === stale) return false;
      if (p === branchPath) return true;
      if (p === repoPath) return true;
      return false;
    });

    const resolved = ensureThreadWorkDir({
      channelName,
      threadId,
      workDir: stale,
      branch,
      baseFolder,
    });

    expect(resolved).toEqual({
      workDir: branchPath,
      repo: channelName,
      worktree: true,
      branch,
    });
  });

  it("recreates the worktree at the original path on the stored branch", () => {
    const workDir = `${baseFolder}/worktrees/${channelName}/where-are-you-463441`;
    const branch = "discord/where-are-you-463441";

    existsSync.mockImplementation((p: string) => p === repoPath);

    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args.includes("--is-inside-work-tree")) {
        return gitResult("true\n");
      }
      if (cmd === "git" && args.includes("worktree") && args.includes("add")) {
        return gitResult("", 0);
      }
      return gitResult();
    });

    const resolved = ensureThreadWorkDir({
      channelName,
      threadId,
      workDir,
      branch,
      baseFolder,
    });

    expect(resolved?.workDir).toBe(workDir);
    expect(resolved?.branch).toBe(branch);
    expect(spawnSync).toHaveBeenCalledWith(
      "git",
      ["-C", repoPath, "worktree", "add", workDir, branch],
      expect.anything()
    );
  });
});
