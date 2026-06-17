import { describe, it, expect, vi } from "vitest";
import {
  makerThreadMatchesBranch,
  resolveDefinitiveMakerThread,
  resolveDefinitiveMakerThreadForLink,
} from "../../src/github/thread-resolution.js";
import type { DatabaseManager } from "../../src/db/database.js";

function mockDb(overrides: Partial<{
  getThreadSession: DatabaseManager["getThreadSession"];
  findThreadByBranch: DatabaseManager["findThreadByBranch"];
  findMakerThreadForRepo: DatabaseManager["findMakerThreadForRepo"];
  getPrThreads: DatabaseManager["getPrThreads"];
}> = {}): DatabaseManager {
  return {
    getThreadSession: vi.fn(() => null),
    findThreadByBranch: vi.fn(() => null),
    findMakerThreadForRepo: vi.fn(() => null),
    getPrThreads: vi.fn(() => null),
    ...overrides,
  } as unknown as DatabaseManager;
}

describe("thread-resolution", () => {
  describe("makerThreadMatchesBranch", () => {
    it("returns true when session branch matches head branch", () => {
      const db = mockDb({
        getThreadSession: vi.fn(() => ({
          threadId: "t1",
          channelId: "c1",
          agent: "cc",
          sessionId: "s1",
          workDir: "/carbon/wt",
          branch: "discord/foo-123456",
          isWorktree: true,
          createdAt: 0,
        })),
      });
      expect(makerThreadMatchesBranch(db, "t1", "discord/foo-123456")).toBe(true);
    });

    it("returns false when branches differ", () => {
      const db = mockDb({
        getThreadSession: vi.fn(() => ({
          threadId: "t1",
          channelId: "c1",
          agent: "cc",
          sessionId: "s1",
          workDir: "/carbon/wt",
          branch: "discord/foo-123456",
          isWorktree: true,
          createdAt: 0,
        })),
      });
      expect(makerThreadMatchesBranch(db, "t1", "feat/other-branch")).toBe(false);
    });
  });

  describe("resolveDefinitiveMakerThreadForLink", () => {
    it("prefers exact branch thread match for any prefix", () => {
      const db = mockDb({
        findThreadByBranch: vi.fn((branch) =>
          branch === "feat/my-feature" ? "thread-branch" : null
        ),
        findMakerThreadForRepo: vi.fn(() => "thread-repo-fallback"),
      });

      expect(resolveDefinitiveMakerThreadForLink(db, "feat/my-feature", "discord-ai-terminal")).toBe(
        "thread-branch"
      );
    });

    it("falls back to repo maker thread when branch has no direct match", () => {
      const db = mockDb({
        findThreadByBranch: vi.fn(() => null),
        findMakerThreadForRepo: vi.fn((repoName) =>
          repoName === "discord-ai-terminal" ? "thread-repo-fallback" : null
        ),
      });

      expect(resolveDefinitiveMakerThreadForLink(db, "feature/external-pr", "discord-ai-terminal")).toBe(
        "thread-repo-fallback"
      );
    });
  });

  describe("resolveDefinitiveMakerThread", () => {
    it("prefers findThreadByBranch over stored pr_threads", () => {
      const db = mockDb({
        findThreadByBranch: vi.fn(() => "branch-thread"),
        getPrThreads: vi.fn(() => ({ makerThreadId: "stale-thread" })),
      });
      expect(
        resolveDefinitiveMakerThread(db, "org/repo", "repo", 80, "discord/foo-123456")
      ).toBe("branch-thread");
    });

    it("rejects stale pr_threads links when branch does not match", () => {
      const db = mockDb({
        findThreadByBranch: vi.fn(() => null),
        getPrThreads: vi.fn(() => ({ makerThreadId: "wrong-thread" })),
        getThreadSession: vi.fn(() => ({
          threadId: "wrong-thread",
          channelId: "c1",
          agent: "cc",
          sessionId: "s1",
          workDir: "/carbon/wt",
          branch: "discord/other-111111",
          isWorktree: true,
          createdAt: 0,
        })),
      });
      expect(
        resolveDefinitiveMakerThread(db, "yidongw/carbon", "carbon", 80, "feat/universal-soft-delete")
      ).toBeNull();
    });

    it("accepts pr_threads link when session branch matches head branch", () => {
      const db = mockDb({
        findThreadByBranch: vi.fn(() => null),
        getPrThreads: vi.fn(() => ({ makerThreadId: "good-thread" })),
        getThreadSession: vi.fn(() => ({
          threadId: "good-thread",
          channelId: "c1",
          agent: "cc",
          sessionId: "s1",
          workDir: "/carbon/wt",
          branch: "discord/foo-123456",
          isWorktree: true,
          createdAt: 0,
        })),
      });
      expect(
        resolveDefinitiveMakerThread(db, "org/repo", "repo", 5, "discord/foo-123456")
      ).toBe("good-thread");
    });
  });
});
