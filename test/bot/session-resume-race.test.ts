/**
 * Verifies that runAgent waits for the dying process to exit before spawning
 * a --resume. The race condition: killProcess sends SIGTERM but the old
 * process may still be writing its session state; if --resume fires before it
 * exits, the session file can be corrupt and resume fails immediately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn } from "child_process";

// ── mocks ────────────────────────────────────────────────────────────────────

const { isPidAliveMock } = vi.hoisted(() => ({
  isPidAliveMock: vi.fn(() => true),
}));

vi.mock("../../src/bot/run-tailer.js", () => ({
  RunTailer: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
  isPidAlive: isPidAliveMock,
  LOG_STALL_TIMEOUT_MS: 5 * 60 * 1000,
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({
    pid: 99999,
    on: vi.fn(),
    unref: vi.fn(),
  })),
}));

vi.mock("../../src/db/database.js", () => {
  class DatabaseManager {
    cleanupOldThreadSessions = vi.fn();
    listActiveRuns = vi.fn(() => []);
    getThreadSession = vi.fn(() => null);
    getMode = vi.fn(() => "default");
    getModel = vi.fn(() => "claude-sonnet-4-6");
    getCodexModel = vi.fn(() => "gpt-5.4-mini");
    getCsModel = vi.fn(() => "auto");
    getToolOverrides = vi.fn(() => ({}));
    updateModelOverride = vi.fn();
    deleteActiveRunsForThread = vi.fn();
    createActiveRun = vi.fn();
    createThreadSession = vi.fn();
    deleteActiveRun = vi.fn();
    updateSessionId = vi.fn();
    updateActiveRunOffset = vi.fn();
    deleteScheduledTasksForThread = vi.fn();
    deleteThreadSession = vi.fn();
    hasActiveRun = vi.fn(() => false);
  }
  return { DatabaseManager, toolIsHidden: vi.fn(() => false) };
});

// ─────────────────────────────────────────────────────────────────────────────

import { SessionManager } from "../../src/bot/session-manager.js";

const makeThread = () => ({
  name: "cc • test",
  setName: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue({ edit: vi.fn() }),
});

const makeDiscordCtx = () => ({
  channelId: "ch1",
  channelName: "test-channel",
  userId: "user1",
  messageId: "msg1",
});

describe("resume race condition fix", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    isPidAliveMock.mockReset();
    isPidAliveMock.mockReturnValue(true);
    vi.mocked(spawn).mockReturnValue({ pid: 99999, on: vi.fn(), unref: vi.fn() } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls isPidAlive before spawning --resume when previous session is alive", async () => {
    const manager = new SessionManager();

    // First call: establish a session.
    const thread = makeThread();
    await manager.runAgent("t1", "ch1", thread, "cc", "/work", "first prompt", makeDiscordCtx());

    const spawnMock = vi.mocked(spawn);
    const spawnCountAfterFirst = spawnMock.mock.calls.length;

    // Inject an existing session so wouldResume = true.
    const db = (manager as any).db;
    db.getThreadSession.mockReturnValue({
      threadId: "t1",
      channelId: "ch1",
      agent: "cc",
      sessionId: "old-session-abc",
      workDir: "/work",
      branch: null,
      isWorktree: false,
      modelOverride: "claude-sonnet-4-6",
      createdAt: Date.now(),
    });

    // isPidAlive: alive for the first 3 polls, dead on the 4th.
    let pollCount = 0;
    isPidAliveMock.mockImplementation(() => {
      pollCount++;
      return pollCount < 4;
    });

    // Second call — should block inside waitForPidDeath.
    const runPromise = manager.runAgent("t1", "ch1", thread, "cc", "/work", "second prompt", makeDiscordCtx());

    // No new spawn yet — still waiting for the dying process.
    expect(spawnMock.mock.calls.length).toBe(spawnCountAfterFirst);

    // Advance through 4 × 100 ms polling intervals (3 alive + 1 dead).
    await vi.advanceTimersByTimeAsync(400);

    await runPromise;

    // Spawn fired after the pid died.
    expect(spawnMock.mock.calls.length).toBeGreaterThan(spawnCountAfterFirst);
    // We polled at least 4 times before the spawn.
    expect(pollCount).toBeGreaterThanOrEqual(4);
    // The spawned command includes --resume with the old session ID.
    const lastCmd: string = spawnMock.mock.calls.at(-1)![1][1];
    expect(lastCmd).toContain("--resume old-session-abc");
  });

  it("skips the wait when freshSession is true (no resume needed)", async () => {
    const manager = new SessionManager();
    const thread = makeThread();
    await manager.runAgent("t2", "ch2", thread, "cc", "/work", "first", undefined);

    const db = (manager as any).db;
    db.getThreadSession.mockReturnValue({
      threadId: "t2",
      channelId: "ch2",
      agent: "cc",
      sessionId: "old-session-xyz",
      workDir: "/work",
      branch: null,
      isWorktree: false,
      modelOverride: "claude-sonnet-4-6",
      createdAt: Date.now(),
    });

    isPidAliveMock.mockReturnValue(true); // would block if wait runs
    let pollCount = 0;
    isPidAliveMock.mockImplementation(() => { pollCount++; return true; });

    const spawnMock = vi.mocked(spawn);
    const countBefore = spawnMock.mock.calls.length;

    // freshSession: true → wouldResume = false → no wait.
    const runPromise = manager.runAgent("t2", "ch2", thread, "cc", "/work", "second", undefined, { freshSession: true });

    // Advance only a tiny amount; if wait ran it would need 400 ms.
    await vi.advanceTimersByTimeAsync(10);
    await runPromise;

    // Spawned without waiting.
    expect(spawnMock.mock.calls.length).toBeGreaterThan(countBefore);
    // No polling happened.
    expect(pollCount).toBe(0);
  });

  it("falls back to a fresh session when resume hits a malformed database", async () => {
    const manager = new SessionManager();
    const thread = makeThread();

    await manager.runAgent("t3", "ch3", thread, "cc", "/work", "first prompt", makeDiscordCtx());

    const db = (manager as any).db;
    db.getThreadSession.mockReturnValue({
      threadId: "t3",
      channelId: "ch3",
      agent: "cc",
      sessionId: "broken-session-123",
      workDir: "/work",
      branch: null,
      isWorktree: false,
      modelOverride: "claude-sonnet-4-6",
      createdAt: Date.now(),
    });

    isPidAliveMock.mockReturnValue(false);

    await manager.runAgent("t3", "ch3", thread, "cc", "/work", "retry this prompt", makeDiscordCtx());

    const spawnMock = vi.mocked(spawn);
    const resumeCmd: string = spawnMock.mock.calls.at(-1)![1][1];
    expect(resumeCmd).toContain("--resume broken-session-123");

    const session = (manager as any).active.get("t3");
    (manager as any).handleEvent(
      "t3",
      {
        kind: "error",
        subtype: "error_during_execution",
        message: "database disk image is malformed",
      },
      session
    );

    expect(session.pendingFreshSessionRetry).toBe(true);

    await (manager as any).finalizeRun("t3", session);

    const freshCmd: string = spawnMock.mock.calls.at(-1)![1][1];
    expect(freshCmd).not.toContain("--resume");
    expect(freshCmd).toContain("retry this prompt");
  });
});
