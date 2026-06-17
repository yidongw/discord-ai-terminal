import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db/database.js", () => {
  class DatabaseManager {
    cleanupOldThreadSessions = vi.fn();
    listActiveRuns = vi.fn(() => []);
    getThreadSession = vi.fn(() => null);
    getMode = vi.fn(() => "default");
    getModel = vi.fn(() => "gpt-5");
    getCodexModel = vi.fn(() => "gpt-5-codex");
    getCsModel = vi.fn(() => "cs-1");
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

  return {
    DatabaseManager,
    toolIsHidden: vi.fn(() => false),
  };
});

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    on: vi.fn(),
    unref: vi.fn(),
  })),
}));

vi.mock("../../src/bot/run-tailer.js", () => ({
  RunTailer: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  isPidAlive: vi.fn(() => true),
}));

import { SessionManager } from "../../src/bot/session-manager.js";

describe("SessionManager run timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not schedule a 30 minute timeout for cc runs", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const manager = new SessionManager();
    const thread = {
      name: "cc • fix the bug",
      setName: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    await manager.runAgent(
      "thread-1",
      "channel-1",
      thread,
      "cc",
      "/tmp/work",
      "fix the bug",
      undefined
    );

    expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 30 * 60 * 1000)).toBe(false);
  });

  it("abandonThread stops typing and drops the in-memory session immediately", async () => {
    const manager = new SessionManager();
    const thread = {
      name: "cs • debug",
      setName: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
    };

    await manager.runAgent(
      "thread-1",
      "channel-1",
      thread,
      "cs",
      "/tmp/work",
      "hello",
      undefined
    );

    expect(manager.hasActiveProcess("thread-1")).toBe(true);
    manager.abandonThread("thread-1");
    expect(manager.hasActiveProcess("thread-1")).toBe(false);
    expect(thread.sendTyping).toHaveBeenCalled();

    vi.advanceTimersByTime(8000 * 3);
    const typingCalls = (thread.sendTyping as ReturnType<typeof vi.fn>).mock.calls.length;
    manager.abandonThread("thread-1");
    vi.advanceTimersByTime(8000 * 3);
    expect((thread.sendTyping as ReturnType<typeof vi.fn>).mock.calls.length).toBe(typingCalls);
  });
});
