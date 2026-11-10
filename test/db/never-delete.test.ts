import { describe, it, expect, afterEach } from "vitest";
import { DatabaseManager } from "../../src/db/database.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Loops (smartmoney, position-review, …) lost their scheduled tasks when their Discord
// threads were archived: cleanup deleted every task of the thread. Tasks are now paused
// and kept, and a /clear keeps the old thread→session mapping in history.
describe("scheduled tasks and sessions are never deleted", () => {
  const dbPath = path.join(os.tmpdir(), `test-never-delete-${process.pid}-${Date.now()}.db`);
  const db = new DatabaseManager(dbPath);
  afterEach(() => { try { fs.unlinkSync(dbPath); } catch {} });

  it("a closed thread's tasks are paused, not deleted", () => {
    db.createScheduledTask({
      id: "task-loop", threadId: "t1", channelId: "c1", agent: "cc", workDir: "/tmp/w", userId: "u",
      prompt: "loop prompt", label: "loop", intervalSeconds: 7200, nextRunAt: Date.now() + 1000,
      enabled: true, runCount: 5, createdAt: Date.now(),
    } as never);
    db.disableScheduledTasksForThread("t1");
    const t = db.getScheduledTask("task-loop");
    expect(t).toBeTruthy();
    expect(t!.enabled).toBe(false);
    expect(t!.prompt).toBe("loop prompt");
  });

  it("/clear keeps the replaced thread→session mapping", () => {
    db.createThreadSession({ threadId: "t2", channelId: "c1", agent: "cc", workDir: "/tmp/w2", isWorktree: false, createdAt: Date.now() } as never);
    db.updateSessionId("t2", "session-abc");
    db.deleteThreadSession("t2");
    const row = (db as unknown as { db: { prepare: (s: string) => { get: (...a: unknown[]) => unknown } } }).db
      .prepare("SELECT session_id FROM thread_sessions_history WHERE thread_id = ?").get("t2") as { session_id: string };
    expect(row.session_id).toBe("session-abc");
  });
});
