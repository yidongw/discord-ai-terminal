import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DatabaseManager } from "../../src/db/database.js";

describe("queued_wakes (sqlite) — wakes queued behind a busy run survive a restart", () => {
  let dir: string;
  let db: DatabaseManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "queued-wakes-db-"));
    db = new DatabaseManager(path.join(dir, "test.db"));
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("round-trips in FIFO order and deletes by id / by thread", () => {
    const a = db.insertQueuedWake("t-1", "first", "first");
    const b = db.insertQueuedWake("t-1", "second", "second");
    db.insertQueuedWake("t-2", "other", "other");
    expect(db.listQueuedWakes().map((r) => r.prompt)).toEqual(["first", "second", "other"]);
    db.deleteQueuedWake(a);
    expect(db.listQueuedWakes().map((r) => r.id)).not.toContain(a);
    db.deleteQueuedWakesForThread("t-1");
    expect(db.listQueuedWakes().map((r) => r.threadId)).toEqual(["t-2"]);
    expect(b).toBeGreaterThan(a);
  });

  it("persists across a re-open of the same file (a bot restart)", () => {
    db.insertQueuedWake("t-9", "fix it", "fix it");
    const reopened = new DatabaseManager(path.join(dir, "test.db"));
    expect(reopened.listQueuedWakes()).toMatchObject([{ threadId: "t-9", prompt: "fix it" }]);
  });
});
