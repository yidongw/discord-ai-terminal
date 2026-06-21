import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ScheduledTask } from "../../src/db/database.js";
import { sessionLimitTaskId } from "../../src/bot/session-limit-wakeup.js";

vi.mock("../../src/db/database.js", () => {
  class DatabaseManager {
    cleanupOldThreadSessions = vi.fn();
    listActiveRuns = vi.fn(() => []);
    getThreadSession = vi.fn(() => null);
    getMode = vi.fn(() => "default");
    getModel = vi.fn(() => "sonnet");
    getCodexModel = vi.fn(() => "gpt-5-codex");
    getCsModel = vi.fn(() => "cs-1");
    getToolOverrides = vi.fn(() => ({}));
    deleteActiveRunsForThread = vi.fn();
    createActiveRun = vi.fn();
    createThreadSession = vi.fn();
    deleteActiveRun = vi.fn();
    updateSessionId = vi.fn();
    updateActiveRunOffset = vi.fn();
    deleteScheduledTasksForThread = vi.fn();
    deleteThreadSession = vi.fn();
    hasActiveRun = vi.fn(() => false);
    getScheduledTask = vi.fn(() => null);
    updateScheduledTaskPrompt = vi.fn();
    listScheduledTasks = vi.fn(() => []);
  }

  return {
    DatabaseManager,
    toolIsHidden: vi.fn(() => false),
  };
});

import { SessionManager } from "../../src/bot/session-manager.js";

function queuedMsg(
  threadId: string,
  channelId: string,
  text: string,
  threadName: string
) {
  return {
    prompt: text,
    originalText: text,
    discordContext: {
      channelId: threadId,
      channelName: threadName,
      userId: "user-1",
      messageId: "msg-1",
    },
    agentKey: "cc",
    workDir: "/tmp/work",
    channelId,
    thread: { name: threadName },
  };
}

describe("message queue helpers", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
    vi.clearAllMocks();
  });

  function mockScheduledTask(task: ScheduledTask | null) {
    (manager.getDb().getScheduledTask as ReturnType<typeof vi.fn>).mockReturnValue(task);
  }

  it("lists queued messages for a thread in FIFO order", () => {
    manager.enqueueMessage("thread-a", queuedMsg("thread-a", "channel-1", "first task", "fix login"));
    manager.enqueueMessage("thread-a", queuedMsg("thread-a", "channel-1", "second task", "fix login"));

    expect(manager.listQueuedMessages("thread-a")).toEqual([
      { position: 1, preview: "first task" },
      { position: 2, preview: "second task" },
    ]);
    expect(manager.getQueueLength("thread-a")).toBe(2);
  });

  it("groups queued messages by thread for a channel", () => {
    manager.enqueueMessage("thread-a", queuedMsg("thread-a", "channel-1", "alpha one", "alpha thread"));
    manager.enqueueMessage("thread-b", queuedMsg("thread-b", "channel-1", "beta one", "beta thread"));
    manager.enqueueMessage("thread-a", queuedMsg("thread-a", "channel-1", "alpha two", "alpha thread"));
    manager.enqueueMessage("thread-c", queuedMsg("thread-c", "channel-2", "other channel", "gamma"));

    const groups = manager.listQueuedMessagesForChannel("channel-1");
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      threadId: "thread-a",
      threadName: "alpha thread",
      messages: [
        { position: 1, preview: "alpha one" },
        { position: 2, preview: "alpha two" },
      ],
    });
    expect(groups[1]).toMatchObject({
      threadId: "thread-b",
      threadName: "beta thread",
      messages: [{ position: 1, preview: "beta one" }],
    });
  });

  it("detects an active usage-limit wait from scheduled_tasks", () => {
    const future = Date.now() + 60_000;
    const task: ScheduledTask = {
      id: sessionLimitTaskId("thread-a"),
      threadId: "thread-a",
      channelId: "channel-1",
      agent: "cc",
      workDir: "/tmp/work",
      userId: "user-1",
      prompt: "continue",
      label: "Session limit resume",
      intervalSeconds: 60,
      nextRunAt: future,
      enabled: true,
      runCount: 0,
      maxRuns: 1,
      createdAt: Date.now(),
    };
    mockScheduledTask(task);

    expect(manager.isWaitingForUsageLimitReset("thread-a")).toBe(true);
    expect(manager.getUsageLimitWait("thread-a").waiting).toBe(true);
    expect(manager.getUsageLimitWait("thread-a").resetLabel).toBe(new Date(future).toLocaleString());
  });

  it("returns false when the usage-limit wakeup is disabled or past due", () => {
    const past = Date.now() - 1_000;
    mockScheduledTask({
      id: sessionLimitTaskId("thread-a"),
      threadId: "thread-a",
      channelId: "channel-1",
      agent: "cc",
      workDir: "/tmp/work",
      userId: "user-1",
      prompt: "continue",
      intervalSeconds: 60,
      nextRunAt: past,
      enabled: true,
      runCount: 0,
      createdAt: Date.now(),
    });

    expect(manager.isWaitingForUsageLimitReset("thread-a")).toBe(false);
  });

  it("replaces the session-limit wakeup prompt for use-on-resume", () => {
    const future = Date.now() + 60_000;
    const task: ScheduledTask = {
      id: sessionLimitTaskId("thread-a"),
      threadId: "thread-a",
      channelId: "channel-1",
      agent: "cc",
      workDir: "/tmp/work",
      userId: "user-1",
      prompt: "continue where you left off",
      label: "Session limit resume",
      intervalSeconds: 60,
      nextRunAt: future,
      enabled: true,
      runCount: 0,
      maxRuns: 1,
      createdAt: Date.now(),
    };
    mockScheduledTask(task);

    expect(manager.setUsageLimitResumePrompt("thread-a", "fix the login bug")).toBe(true);
    expect(manager.getDb().updateScheduledTaskPrompt).toHaveBeenCalledWith(
      sessionLimitTaskId("thread-a"),
      "fix the login bug"
    );
  });

  it("refuses use-on-resume when the usage-limit wakeup is no longer active", () => {
    mockScheduledTask(null);
    expect(manager.setUsageLimitResumePrompt("thread-a", "too late")).toBe(false);
    expect(manager.getDb().updateScheduledTaskPrompt).not.toHaveBeenCalled();
  });
});
