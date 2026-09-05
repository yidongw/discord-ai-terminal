import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock bun:sqlite
const mockExec = vi.fn();
const mockClose = vi.fn();
const mockGet = vi.fn();
const mockRun = vi.fn();
const mockAll = vi.fn();

// Both query() and prepare() return the same statement stub. The production
// code uses .prepare(...).{get,run,all}; older tests were written against
// .query(...) — support both so the mock survives either API.
const stmtStub = () => ({ get: mockGet, run: mockRun, all: mockAll });

vi.mock("bun:sqlite", () => ({
  Database: vi.fn().mockImplementation(() => ({
    exec: mockExec,
    query: vi.fn(stmtStub),
    prepare: vi.fn(stmtStub),
    transaction: vi.fn((fn: (...a: unknown[]) => unknown) => fn),
    close: mockClose,
  })),
}));

import { DatabaseManager } from "../../src/db/database.js";
import type { ScheduledTask } from "../../src/db/database.js";

describe("DatabaseManager", () => {
  let db: DatabaseManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Construction runs migrate(), which reads PRAGMA table_info(...).all();
    // default that to an empty column list so migrations no-op cleanly.
    mockAll.mockReturnValue([]);
    db = new DatabaseManager("/test/path.db");
  });

  describe("initialization", () => {
    it("should create tables on initialization", () => {
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining("CREATE TABLE IF NOT EXISTS thread_sessions")
      );
    });

    it("should create the scheduled_tasks table", () => {
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining("CREATE TABLE IF NOT EXISTS scheduled_tasks")
      );
    });
  });

  describe("model management", () => {
    it("should return default model (claude-sonnet-4-6) for non-existent channel", () => {
      mockGet.mockReturnValue(null);

      const result = db.getModel("non-existent-channel");

      expect(result).toBe("claude-sonnet-4-6");
      expect(mockGet).toHaveBeenCalledWith("non-existent-channel");
    });

    it("should return model when it exists", () => {
      mockGet.mockReturnValue({ model: "claude-opus-4-8" });

      const result = db.getModel("channel-1");

      expect(result).toBe("claude-opus-4-8");
      expect(mockGet).toHaveBeenCalledWith("channel-1");
    });

    it("should store a model", () => {
      db.setModel("test-channel-123", "claude-haiku-4-5");

      expect(mockRun).toHaveBeenCalledWith("test-channel-123", "claude-haiku-4-5");
    });
  });

  describe("codex model management", () => {
    it("should return default codex model (gpt-5.4-mini) for non-existent channel", () => {
      mockGet.mockReturnValue(null);

      const result = db.getCodexModel("non-existent-channel");

      expect(result).toBe("gpt-5.4-mini");
      expect(mockGet).toHaveBeenCalledWith("non-existent-channel");
    });

    it("should return codex model when it exists", () => {
      mockGet.mockReturnValue({ model: "gpt-5.5" });

      const result = db.getCodexModel("channel-1");

      expect(result).toBe("gpt-5.5");
      expect(mockGet).toHaveBeenCalledWith("channel-1");
    });

    it("should store a codex model", () => {
      db.setCodexModel("test-channel-123", "gpt-5.4");

      expect(mockRun).toHaveBeenCalledWith("test-channel-123", "gpt-5.4");
    });
  });

  describe("mode management", () => {
    it("should return default mode (auto) for non-existent channel", () => {
      mockGet.mockReturnValue(null);

      const result = db.getMode("non-existent-channel");

      expect(result).toBe("auto");
    });

    it("should return mode when it exists", () => {
      mockGet.mockReturnValue({ mode: "plan" });

      const result = db.getMode("channel-1");

      expect(result).toBe("plan");
    });

    it("should store a mode", () => {
      db.setMode("test-channel-123", "approve");

      expect(mockRun).toHaveBeenCalledWith("test-channel-123", "approve");
    });
  });

  describe("scheduled tasks", () => {
    const sampleTask: ScheduledTask = {
      id: "t1",
      threadId: "th1",
      channelId: "ch1",
      agent: "cc",
      workDir: "/wd",
      userId: "u1",
      prompt: "do stuff",
      label: "lbl",
      intervalSeconds: 3600,
      nextRunAt: 123,
      enabled: true,
      runCount: 0,
      createdAt: 999,
    };

    it("createScheduledTask inserts all columns with nulls for optional fields", () => {
      db.createScheduledTask(sampleTask);

      expect(mockRun).toHaveBeenCalledWith(
        "t1", "th1", "ch1", "cc", "/wd", "u1", "do stuff", "lbl",
        3600, 123, 1, null, 0, null, 999
      );
    });

    it("getScheduledTask returns null when the row is missing", () => {
      mockGet.mockReturnValue(null);

      expect(db.getScheduledTask("nope")).toBeNull();
      expect(mockGet).toHaveBeenCalledWith("nope");
    });

    it("getScheduledTask maps a row to a ScheduledTask", () => {
      mockGet.mockReturnValue({
        id: "t1", thread_id: "th1", channel_id: "ch1", agent: "cc",
        work_dir: "/wd", user_id: "u1", prompt: "p", label: "l",
        interval_seconds: 60, next_run_at: 5, enabled: 1,
        last_run_at: null, run_count: 2, max_runs: null, created_at: 7,
      });

      const t = db.getScheduledTask("t1");
      expect(t).toMatchObject({ id: "t1", threadId: "th1", enabled: true, runCount: 2 });
    });

    it("markScheduledTaskRun runs with (ranAt, nextRunAt, id)", () => {
      db.markScheduledTaskRun("t1", 100, 200);

      expect(mockRun).toHaveBeenCalledWith(100, 200, "t1");
    });

    it("updateScheduledTask writes only the provided fields, id last", () => {
      db.updateScheduledTask("t1", { intervalSeconds: 120, enabled: false });

      expect(mockRun).toHaveBeenCalledWith(120, 0, "t1");
    });

    it("updateScheduledTask is a no-op when no fields are given", () => {
      db.updateScheduledTask("t1", {});

      expect(mockRun).not.toHaveBeenCalled();
    });

    it("deleteSpentSessionLimitTasks returns the number of rows removed", () => {
      mockRun.mockReturnValue({ changes: 3 });

      expect(db.deleteSpentSessionLimitTasks()).toBe(3);
      expect(mockRun).toHaveBeenCalled();
    });
  });
});
