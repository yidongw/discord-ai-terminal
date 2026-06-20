import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../src/db/database.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Goal Database Operations", () => {
  let db: DatabaseManager;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary database for testing
    dbPath = path.join(os.tmpdir(), `test-goal-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
  });

  afterEach(() => {
    db.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {}
  });

  it("should create session without goal", () => {
    db.createThreadSession({
      threadId: "thread-1",
      channelId: "channel-1",
      agent: "cc",
      workDir: "/tmp/test",
      isWorktree: false,
      createdAt: Date.now(),
    });

    const session = db.getThreadSession("thread-1");
    expect(session).toBeDefined();
    expect(session?.goal).toBeUndefined();
  });

  it("should create session with goal", () => {
    const goal = "Fix authentication bugs";
    db.createThreadSession({
      threadId: "thread-2",
      channelId: "channel-1",
      agent: "cc",
      workDir: "/tmp/test",
      isWorktree: false,
      createdAt: Date.now(),
      goal,
    });

    const session = db.getThreadSession("thread-2");
    expect(session).toBeDefined();
    expect(session?.goal).toBe(goal);
  });

  it("should update goal for existing session", () => {
    // Create session without goal
    db.createThreadSession({
      threadId: "thread-3",
      channelId: "channel-1",
      agent: "cc",
      workDir: "/tmp/test",
      isWorktree: false,
      createdAt: Date.now(),
    });

    // Set a goal
    const goal = "Refactor the database layer";
    db.updateGoal("thread-3", goal);

    const session = db.getThreadSession("thread-3");
    expect(session?.goal).toBe(goal);
  });

  it("should clear goal when set to null", () => {
    // Create session with goal
    const goal = "Improve test coverage";
    db.createThreadSession({
      threadId: "thread-4",
      channelId: "channel-1",
      agent: "cx",
      workDir: "/tmp/test",
      isWorktree: false,
      createdAt: Date.now(),
      goal,
    });

    // Clear the goal
    db.updateGoal("thread-4", null);

    const session = db.getThreadSession("thread-4");
    expect(session?.goal).toBeUndefined();
  });

  it("should persist goal across updates", () => {
    const goal1 = "First goal";
    const goal2 = "Second goal";

    db.createThreadSession({
      threadId: "thread-5",
      channelId: "channel-1",
      agent: "cs",
      workDir: "/tmp/test",
      isWorktree: false,
      createdAt: Date.now(),
      goal: goal1,
    });

    // Update to a new goal
    db.updateGoal("thread-5", goal2);

    const session = db.getThreadSession("thread-5");
    expect(session?.goal).toBe(goal2);
  });

  it("should support goals in all agent types", () => {
    const goal = "Test goal for all agents";

    ["cc", "cx", "cs"].forEach((agent, index) => {
      const threadId = `thread-agent-${agent}`;
      db.createThreadSession({
        threadId,
        channelId: "channel-1",
        agent,
        workDir: "/tmp/test",
        isWorktree: false,
        createdAt: Date.now(),
        goal,
      });

      const session = db.getThreadSession(threadId);
      expect(session?.goal).toBe(goal);
      expect(session?.agent).toBe(agent);
    });
  });
});
