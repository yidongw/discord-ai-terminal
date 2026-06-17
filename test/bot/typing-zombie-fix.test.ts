/**
 * Integration-style tests for the zombie typing indicator fix:
 * - log stall finalizes hung runs while the process is still alive
 * - abandonThread clears typing when a worker takes over
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("bun:sqlite", () => ({
  Database: vi.fn().mockImplementation(() => ({
    exec: vi.fn(),
    query: vi.fn(() => ({ get: vi.fn(), run: vi.fn(), all: vi.fn() })),
    close: vi.fn(),
  })),
}));

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RunTailer, LOG_STALL_TIMEOUT_MS } from "../../src/bot/run-tailer.js";
import { TypingIndicator } from "../../src/bot/session-manager.js";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("typing zombie fix integration", () => {
  it("exports a 5-minute default stall timeout", () => {
    expect(LOG_STALL_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });

  describe("RunTailer stall (simulates hung cursor agent)", () => {
    let dir: string;
    let logPath: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "zombie-log-"));
      logPath = path.join(dir, "run.jsonl");
    });

    afterEach(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    });

    it("finalizes a run that delivered output then stopped writing", async () => {
      // Reproduces the first session: two assistant lines, then silence.
      fs.writeFileSync(
        logPath,
        '{"type":"assistant","message":{"content":[{"type":"text","text":"partial reply"}]}}\n'
      );

      const lines: string[] = [];
      let finalized = false;
      let alive = true;
      const tailer = new RunTailer({
        logPath,
        startOffset: 0,
        pollIntervalMs: 10,
        stallTimeoutMs: 60,
        isAlive: () => alive,
        onLine: (l) => lines.push(l),
        onOffset: () => {},
        onFinalize: () => { finalized = true; },
      });

      tailer.start();
      await wait(30);
      expect(lines.length).toBe(1);
      expect(finalized).toBe(false);

      await wait(80);
      expect(finalized).toBe(true);

      alive = false;
      tailer.stop();
    });
  });

  describe("TypingIndicator + abandon pattern", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("simulates worker takeover: typing stops after abandon", () => {
      const thread = { sendTyping: vi.fn().mockResolvedValue(undefined) };
      const typing = new TypingIndicator(thread, 8000);

      // Main bot started typing for the first (zombie) run.
      typing.start();
      expect(thread.sendTyping).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(8000);
      expect(thread.sendTyping).toHaveBeenCalledTimes(2);

      // Worker spawn calls abandonThread → releaseThread → typing.stop()
      typing.stop();

      vi.advanceTimersByTime(8000 * 5);
      expect(thread.sendTyping).toHaveBeenCalledTimes(2);
    });
  });
});
