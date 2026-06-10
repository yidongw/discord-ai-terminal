import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseManager } from "../../src/db/database.js";
import { registerSessionLimitWakeup } from "../../src/bot/session-limit-wakeup.js";

describe("session-limit wakeup (sqlite)", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-limit-db-"));
    dbPath = path.join(dir, "test.db");
    db = new DatabaseManager(dbPath);
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("persists a due wakeup row the scheduler can pick up", () => {
    const resetAt = Date.now() - 1000;
    registerSessionLimitWakeup(db, {
      threadId: "thread-abc",
      channelId: "channel-xyz",
      workDir: "/tmp/work",
      userId: "user-1",
      resetAt,
    });

    const stored = db.getScheduledTask("session-limit-thread-abc");
    expect(stored).not.toBeNull();
    expect(stored!.enabled).toBe(true);
    expect(stored!.maxRuns).toBe(1);
    expect(stored!.nextRunAt).toBe(resetAt);

    const due = db.getDueScheduledTasks(Date.now());
    expect(due.some((t) => t.id === "session-limit-thread-abc")).toBe(true);
  });
});
