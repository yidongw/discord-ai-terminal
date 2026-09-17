/**
 * A run re-attached after a bot restart has no exit code (we never owned the
 * child handle). If its process is already gone and never emitted a done
 * event — e.g. the service manager killed it together with the bot — the
 * thread must NOT be finalized in silence: retry with the persisted prompt, or
 * at least tell the user when there is nothing to retry with.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "child_process";

const { isPidAliveMock, tailerOpts } = vi.hoisted(() => ({
  isPidAliveMock: vi.fn(() => false),
  tailerOpts: [] as any[],
}));

vi.mock("../../src/bot/run-tailer.js", () => ({
  RunTailer: vi.fn().mockImplementation((opts: any) => {
    tailerOpts.push(opts);
    return { start: vi.fn(), stop: vi.fn() };
  }),
  isPidAlive: isPidAliveMock,
  LOG_STALL_TIMEOUT_MS: 5 * 60 * 1000,
}));

vi.mock("child_process", () => ({
  spawn: vi.fn(() => ({ pid: 99999, on: vi.fn(), unref: vi.fn() })),
}));

const { activeRuns, threadSession } = vi.hoisted(() => ({
  activeRuns: [] as any[],
  threadSession: { current: null as any },
}));

vi.mock("../../src/db/database.js", () => {
  class DatabaseManager {
    cleanupOldThreadSessions = vi.fn();
    listActiveRuns = vi.fn(() => activeRuns);
    getThreadSession = vi.fn(() => threadSession.current);
    getMode = vi.fn(() => "default");
    getModel = vi.fn(() => "claude-sonnet-4-6");
    getCodexModel = vi.fn(() => "gpt-5.6-luna");
    getCsModel = vi.fn(() => "auto");
    getChannelThinking = vi.fn(() => undefined);
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

import { SessionManager } from "../../src/bot/session-manager.js";

const makeThread = () => ({
  id: "t1",
  name: "cc • test",
  setName: vi.fn().mockResolvedValue(undefined),
  sendTyping: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue({ edit: vi.fn() }),
});

const makeRun = (prompt: string | undefined) => ({
  runId: "t1-100",
  threadId: "t1",
  channelId: "ch1",
  agent: "cc",
  workDir: "/work",
  pid: 4242,
  logPath: "/tmp/does-not-exist-t1-100.jsonl",
  stdoutOffset: 0,
  startedAt: 100,
  completionJson: undefined,
  prompt,
});

const sentTitles = (thread: ReturnType<typeof makeThread>) =>
  thread.send.mock.calls.map((c: any[]) => c[0]?.embeds?.[0]?.data?.title ?? c[0]?.embeds?.[0]?.title ?? "");

describe("re-attached run that exited without a done event", () => {
  beforeEach(() => {
    tailerOpts.length = 0;
    activeRuns.length = 0;
    vi.mocked(spawn).mockClear();
    isPidAliveMock.mockReset();
    isPidAliveMock.mockReturnValue(false);
    threadSession.current = {
      threadId: "t1",
      channelId: "ch1",
      agent: "cc",
      sessionId: "sess-abc",
      workDir: "/work",
      branch: null,
      isWorktree: false,
      modelOverride: "claude-sonnet-4-6",
      createdAt: 1,
    };
  });

  it("persists the prompt with the active_runs row at spawn", async () => {
    const manager = new SessionManager();
    const thread = makeThread();
    await manager.runAgent("t9", "ch1", thread, "cc", "/work", "hello there", undefined);
    const db = (manager as any).db;
    expect(db.createActiveRun).toHaveBeenCalledWith(expect.objectContaining({ prompt: "hello there" }));
  });

  it("retries with the persisted prompt instead of finishing silently", async () => {
    activeRuns.push(makeRun("继续"));
    const manager = new SessionManager();
    const thread = makeThread();
    const client = { channels: { fetch: vi.fn().mockResolvedValue(thread) } } as any;

    await manager.reattachRuns(client);
    expect(tailerOpts).toHaveLength(1);
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();

    // Tailer drained the (empty) log and found the pid dead → finalize.
    await tailerOpts[0].onFinalize();

    // A new run was spawned for the same thread, resuming the saved session
    // with the original prompt.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    const cmd: string = vi.mocked(spawn).mock.calls[0]![1][1];
    expect(cmd).toContain("--resume sess-abc");
    expect(cmd).toContain("继续");
    // And no scary "exited silently" notice on the first retry.
    expect(sentTitles(thread)).not.toContain("⚠️ Session exited silently");
  });

  it("tells the user when there is no prompt to retry with", async () => {
    activeRuns.push(makeRun(undefined));
    const manager = new SessionManager();
    const thread = makeThread();
    const client = { channels: { fetch: vi.fn().mockResolvedValue(thread) } } as any;

    await manager.reattachRuns(client);
    await tailerOpts[0].onFinalize();

    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(sentTitles(thread)).toContain("⚠️ Run interrupted");
  });

  it("stays quiet when the run had already emitted done", async () => {
    activeRuns.push(makeRun("继续"));
    const manager = new SessionManager();
    const thread = makeThread();
    const client = { channels: { fetch: vi.fn().mockResolvedValue(thread) } } as any;

    await manager.reattachRuns(client);
    const session = (manager as any).active.get("t1");
    session.done = true;
    await tailerOpts[0].onFinalize();

    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(sentTitles(thread)).not.toContain("⚠️ Run interrupted");
  });
});
