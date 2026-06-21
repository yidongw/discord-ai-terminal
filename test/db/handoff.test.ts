import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../../src/db/database.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("Handoff Database Operations", () => {
  let db: DatabaseManager;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-handoff-${Date.now()}.db`);
    db = new DatabaseManager(dbPath);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(dbPath);
    } catch {}
  });

  it("should store and retrieve handoff bot", () => {
    db.createThreadSession({
      threadId: "thread-1",
      channelId: "channel-1",
      agent: "cc",
      workDir: "/tmp/test",
      isWorktree: false,
      createdAt: Date.now(),
    });
    db.updateHandoffBot("thread-1", "hermes");

    const session = db.getThreadSession("thread-1");
    expect(session?.handoffBot).toBe("hermes");
  });

  it("should clear handoff bot", () => {
    db.createThreadSession({
      threadId: "thread-2",
      channelId: "channel-1",
      agent: "cc",
      workDir: "/tmp/test",
      isWorktree: false,
      createdAt: Date.now(),
      handoffBot: "hermes",
    });
    db.updateHandoffBot("thread-2", null);

    const session = db.getThreadSession("thread-2");
    expect(session?.handoffBot).toBeUndefined();
  });

  it("should preserve handoff when session is replaced without handoff field", () => {
    db.createThreadSession({
      threadId: "thread-3",
      channelId: "channel-1",
      agent: "cc",
      workDir: "/tmp/test",
      isWorktree: false,
      createdAt: Date.now(),
      handoffBot: "hermes",
    });

    db.createThreadSession({
      threadId: "thread-3",
      channelId: "channel-1",
      agent: "cc",
      workDir: "/tmp/test-updated",
      isWorktree: true,
      createdAt: Date.now(),
    });

    const session = db.getThreadSession("thread-3");
    expect(session?.handoffBot).toBe("hermes");
    expect(session?.workDir).toBe("/tmp/test-updated");
  });
});
