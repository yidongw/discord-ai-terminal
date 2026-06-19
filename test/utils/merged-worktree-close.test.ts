import { describe, it, expect, vi, beforeEach } from "vitest";

const { spawnSync } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawnSync,
}));

import {
  branchMatchesOrigin,
  evaluateThreadWorktreeClose,
  hasOriginRemote,
  isBranchPrMerged,
  parseGithubRepoFromRemote,
  worktreePassesCloseCheck,
} from "../../src/utils/merged-worktree-close.js";

function gitResult(stdout: string, status = 0) {
  return { status, stdout, stderr: "" };
}

describe("parseGithubRepoFromRemote", () => {
  it("parses HTTPS and SSH GitHub remotes", () => {
    expect(parseGithubRepoFromRemote("https://github.com/org/repo.git")).toBe("org/repo");
    expect(parseGithubRepoFromRemote("git@github.com:org/repo")).toBe("org/repo");
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGithubRepoFromRemote("git@gitlab.com:org/repo.git")).toBeNull();
  });
});

describe("hasOriginRemote", () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  it("returns false when origin is missing", () => {
    spawnSync.mockReturnValue(gitResult("", 1));
    expect(hasOriginRemote("/wt")).toBe(false);
  });

  it("returns true for a GitHub origin", () => {
    spawnSync.mockReturnValue(gitResult("git@github.com:org/repo.git"));
    expect(hasOriginRemote("/wt")).toBe(true);
  });
});

describe("branchMatchesOrigin", () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  it("returns false when HEAD is not on the expected branch", () => {
    spawnSync.mockImplementation((_cmd, args: string[]) => {
      if (args.includes("--abbrev-ref")) return gitResult("other-branch");
      return gitResult("");
    });
    expect(branchMatchesOrigin("/wt", "feat/foo")).toBe(false);
  });

  it("returns true when HEAD matches origin/branch", () => {
    spawnSync.mockImplementation((_cmd, args: string[]) => {
      if (args.includes("--abbrev-ref")) return gitResult("feat/foo");
      if (args.includes("fetch")) return gitResult("");
      if (args[args.length - 1] === "HEAD") return gitResult("abc123");
      if (args[args.length - 1] === "origin/feat/foo") return gitResult("abc123");
      return gitResult("");
    });
    expect(branchMatchesOrigin("/wt", "feat/foo")).toBe(true);
  });
});

describe("isBranchPrMerged", () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  it("returns true when gh finds a merged PR for the branch", () => {
    spawnSync.mockReturnValue(gitResult('[{"number":42}]'));
    expect(isBranchPrMerged("/wt", "feat/foo", "org/repo")).toBe(true);
  });

  it("returns false when no merged PR exists", () => {
    spawnSync.mockReturnValue(gitResult("[]"));
    expect(isBranchPrMerged("/wt", "feat/foo", "org/repo")).toBe(false);
  });
});

describe("worktreePassesCloseCheck", () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  it("returns false when the worktree has uncommitted changes", () => {
    spawnSync.mockImplementation((_cmd, args: string[]) => {
      if (args.includes("status")) return gitResult(" M file.ts");
      return gitResult("");
    });
    expect(worktreePassesCloseCheck("/repo", "/wt")).toBe(false);
  });

  it("returns true when the worktree is clean", () => {
    spawnSync.mockImplementation((_cmd, args: string[]) => {
      if (args.includes("status")) return gitResult("");
      return gitResult("");
    });
    expect(worktreePassesCloseCheck("/repo", "/wt")).toBe(true);
  });
});

describe("evaluateThreadWorktreeClose", () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  function mockCleanMergedWorktree() {
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git") {
        if (args.includes("remote")) return gitResult("git@github.com:org/repo.git");
        if (args.includes("--abbrev-ref")) return gitResult("discord/foo");
        if (args.includes("fetch")) return gitResult("");
        if (args.includes("--git-common-dir")) return gitResult("/repo/.git");
        if (args.includes("status")) return gitResult("");
        if (args.includes("log")) return gitResult("");
        if (args.includes("symbolic-ref")) return gitResult("origin/main");
        if (args[args.length - 1] === "HEAD") return gitResult("deadbeef");
        if (args[args.length - 1] === "origin/discord/foo") return gitResult("deadbeef");
      }
      if (cmd === "gh") return gitResult('[{"number":7}]');
      return gitResult("");
    });
  }

  it("blocks without a branch name", () => {
    expect(evaluateThreadWorktreeClose("/wt", undefined)).toEqual({
      action: "block",
      reason: "no branch configured",
    });
  });

  it("force-removes when all three checks pass", () => {
    mockCleanMergedWorktree();
    expect(evaluateThreadWorktreeClose("/wt", "discord/foo")).toEqual({ action: "forceRemove" });
  });

  it("blocks when branch does not match origin", () => {
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git") {
        if (args.includes("remote")) return gitResult("git@github.com:org/repo.git");
        if (args.includes("--abbrev-ref")) return gitResult("discord/foo");
        if (args.includes("fetch")) return gitResult("");
        if (args.includes("--git-common-dir")) return gitResult("/repo/.git");
        if (args.includes("status")) return gitResult("");
        if (args.includes("log")) return gitResult("");
        if (args.includes("symbolic-ref")) return gitResult("origin/main");
        if (args[args.length - 1] === "HEAD") return gitResult("local-only");
        if (args[args.length - 1] === "origin/discord/foo") return gitResult("on-origin");
      }
      if (cmd === "gh") return gitResult('[{"number":7}]');
      return gitResult("");
    });

    expect(evaluateThreadWorktreeClose("/wt", "discord/foo")).toEqual({
      action: "block",
      reason: "branch does not match origin",
    });
  });

  it("blocks when PR is not merged", () => {
    mockCleanMergedWorktree();
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git") {
        if (args.includes("remote")) return gitResult("git@github.com:org/repo.git");
        if (args.includes("--abbrev-ref")) return gitResult("discord/foo");
        if (args.includes("fetch")) return gitResult("");
        if (args.includes("--git-common-dir")) return gitResult("/repo/.git");
        if (args.includes("status")) return gitResult("");
        if (args.includes("log")) return gitResult("");
        if (args.includes("symbolic-ref")) return gitResult("origin/main");
        if (args[args.length - 1] === "HEAD") return gitResult("deadbeef");
        if (args[args.length - 1] === "origin/discord/foo") return gitResult("deadbeef");
      }
      if (cmd === "gh") return gitResult("[]");
      return gitResult("");
    });

    expect(evaluateThreadWorktreeClose("/wt", "discord/foo")).toEqual({
      action: "block",
      reason: "PR is not merged",
    });
  });

  it("blocks when the worktree has uncommitted changes", () => {
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git") {
        if (args.includes("status")) return gitResult(" M dirty.ts");
        if (args.includes("remote")) return gitResult("git@github.com:org/repo.git");
        if (args.includes("--abbrev-ref")) return gitResult("discord/foo");
        if (args.includes("fetch")) return gitResult("");
        if (args.includes("--git-common-dir")) return gitResult("/repo/.git");
        if (args.includes("log")) return gitResult("");
        if (args.includes("symbolic-ref")) return gitResult("origin/main");
        if (args[args.length - 1] === "HEAD") return gitResult("deadbeef");
        if (args[args.length - 1] === "origin/discord/foo") return gitResult("deadbeef");
      }
      if (cmd === "gh") return gitResult('[{"number":7}]');
      return gitResult("");
    });

    expect(evaluateThreadWorktreeClose("/wt", "discord/foo")).toEqual({
      action: "block",
      reason: "uncommitted changes",
    });
  });
});
