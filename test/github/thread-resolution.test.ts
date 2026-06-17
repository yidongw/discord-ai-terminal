import { describe, it, expect, vi } from "vitest";
import {
  isDiscordBranch,
  makerThreadMatchesBranch,
  resolveDefinitiveMakerThread,
  resolveDefinitiveMakerThreadForLink,
  resolveKnownMakerThreadForLink,
} from "../../src/github/thread-resolution.js";
import type { DatabaseManager } from "../../src/db/database.js";

function mockDb(overrides: Partial<{
  getThreadSession: DatabaseManager["getThreadSession"];
  findThreadByBranch: DatabaseManager["findThreadByBranch"];
  getPrThreads: DatabaseManager["getPrThreads"];
}> = {}): DatabaseManager {
  return {
    getThreadSession: vi.fn(() => null),
    findThreadByBranch: vi.fn(() => null),
    getPrThreads: vi.fn(() => null),
    ...overrides,
  } as unknown as DatabaseManager;
}

describe("thread-resolution", () => {
  describe("isDiscordBranch", () => {
    it("accepts only discord/* branches", () => {
      expect(isDiscordBranch("discord/feature-123456")).toBe(true);
      expect(isDiscordBranch("feat/feature-123456")).toBe(false);
      expect(isDiscordBranch("")).toBe(false);
    });
  });

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
    it("links only discord/* branches with a matching thread", () => {
      const db = mockDb({
        findThreadByBranch: vi.fn((branch) =>
          branch === "discord/my-feature-123456" ? "thread-123456" : null
        ),
      });
      expect(resolveDefinitiveMakerThreadForLink(db, "discord/my-feature-123456")).toBe(
        "thread-123456"
      );
      expect(resolveDefinitiveMakerThreadForLink(db, "feat/external-pr")).toBeNull();
    });
  });

  describe("resolveKnownMakerThreadForLink", () => {
    it("allows known thread links only for discord/* session branches", () => {
      const db = mockDb({
        getThreadSession: vi.fn((threadId) => {
          if (threadId === "discord-thread") {
            return {
              threadId,
              channelId: "c1",
              agent: "cc",
              sessionId: "s1",
              workDir: "/carbon/wt",
              branch: "discord/my-feature-123456",
              isWorktree: true,
              createdAt: 0,
            };
          }
          if (threadId === "feature-thread") {
            return {
              threadId,
              channelId: "c1",
              agent: "cc",
              sessionId: "s2",
              workDir: "/carbon/wt",
              branch: "feat/external-pr",
              isWorktree: true,
              createdAt: 0,
            };
          }
          return null;
        }),
      });

      expect(resolveKnownMakerThreadForLink(db, "discord-thread")).toBe("discord-thread");
      expect(resolveKnownMakerThreadForLink(db, "feature-thread")).toBeNull();
      expect(resolveKnownMakerThreadForLink(db, "missing-thread")).toBeNull();
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
