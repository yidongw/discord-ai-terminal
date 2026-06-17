import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { RunTailer, isPidAlive } from "../../src/bot/run-tailer.js";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("RunTailer", () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tailer-"));
    logPath = path.join(dir, "run.jsonl");
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("emits complete lines, buffers the trailing partial, and tracks the byte offset", async () => {
    fs.writeFileSync(logPath, "a\nbb\nccc"); // two complete lines + a partial

    const lines: string[] = [];
    let lastOffset = -1;
    let alive = true;
    const tailer = new RunTailer({
      logPath,
      startOffset: 0,
      pollIntervalMs: 10,
      isAlive: () => alive,
      onLine: (l) => lines.push(l),
      onOffset: (o) => { lastOffset = o; },
      onFinalize: () => {},
    });
    tailer.start();
    await wait(40);

    // "ccc" has no newline yet → still buffered.
    expect(lines).toEqual(["a", "bb"]);
    // Offset = bytes of "a\nbb\n" = 5, the last complete-line boundary.
    expect(lastOffset).toBe(5);

    // Complete the partial line and add another.
    fs.appendFileSync(logPath, "c\nd\n");
    await wait(40);

    expect(lines).toEqual(["a", "bb", "cccc", "d"]);
    expect(lastOffset).toBe(fs.statSync(logPath).size); // all consumed

    alive = false;
    await wait(40);
    tailer.stop();
  });

  it("finalizes once the process is gone and flushes a trailing newline-less line", async () => {
    fs.writeFileSync(logPath, "one\ntwo"); // "two" has no trailing newline

    const lines: string[] = [];
    let finalized = false;
    let alive = true;
    const tailer = new RunTailer({
      logPath,
      startOffset: 0,
      pollIntervalMs: 10,
      isAlive: () => alive,
      onLine: (l) => lines.push(l),
      onOffset: () => {},
      onFinalize: () => { finalized = true; },
    });
    tailer.start();
    await wait(40);

    expect(lines).toEqual(["one"]); // "two" still buffered while alive
    expect(finalized).toBe(false);

    alive = false; // process exits
    await wait(40);

    expect(finalized).toBe(true);
    expect(lines).toEqual(["one", "two"]); // trailing partial flushed on finalize
  });

  it("resumes from a persisted offset without re-emitting consumed lines", async () => {
    fs.writeFileSync(logPath, "first\nsecond\n");

    // First tailer consumes everything, recording the offset.
    const firstLines: string[] = [];
    let offset = 0;
    let alive = true;
    const t1 = new RunTailer({
      logPath,
      startOffset: 0,
      pollIntervalMs: 10,
      isAlive: () => alive,
      onLine: (l) => firstLines.push(l),
      onOffset: (o) => { offset = o; },
      onFinalize: () => {},
    });
    t1.start();
    await wait(40);
    expect(firstLines).toEqual(["first", "second"]);
    t1.stop(); // graceful: stop WITHOUT finalizing, like a restart

    // More output arrives "while the bot was down".
    fs.appendFileSync(logPath, "third\n");

    // A fresh tailer re-attaches from the persisted offset.
    const resumeLines: string[] = [];
    const t2 = new RunTailer({
      logPath,
      startOffset: offset,
      pollIntervalMs: 10,
      isAlive: () => alive,
      onLine: (l) => resumeLines.push(l),
      onOffset: () => {},
      onFinalize: () => {},
    });
    t2.start();
    await wait(40);

    // Only the new line — no duplicates of first/second.
    expect(resumeLines).toEqual(["third"]);
    alive = false;
    await wait(20);
    t2.stop();
  });

  it("keeps multibyte UTF-8 intact and counts offset in bytes", async () => {
    const line = "🚀 status: ✅"; // multibyte emoji + text
    fs.writeFileSync(logPath, line + "\n");

    const lines: string[] = [];
    let offset = 0;
    let alive = true;
    const tailer = new RunTailer({
      logPath,
      startOffset: 0,
      pollIntervalMs: 10,
      isAlive: () => alive,
      onLine: (l) => lines.push(l),
      onOffset: (o) => { offset = o; },
      onFinalize: () => {},
    });
    tailer.start();
    await wait(40);

    expect(lines).toEqual([line]);
    expect(offset).toBe(Buffer.byteLength(line, "utf8") + 1); // bytes, not chars
    alive = false;
    await wait(20);
    tailer.stop();
  });

  it("waits for a not-yet-created log file and streams once it appears", async () => {
    // Reproduces the fresh-run race: the detached child hasn't created the
    // redirect target yet when the tailer starts. The tailer must NOT give up —
    // it should pick the file up once it exists.
    const lines: string[] = [];
    let finalized = false;
    let alive = true;
    const tailer = new RunTailer({
      logPath, // does not exist yet
      startOffset: 0,
      pollIntervalMs: 10,
      isAlive: () => alive,
      onLine: (l) => lines.push(l),
      onOffset: () => {},
      onFinalize: () => { finalized = true; },
    });
    tailer.start();
    await wait(30);
    expect(finalized).toBe(false); // still alive, file missing → keep waiting
    expect(lines).toEqual([]);

    fs.writeFileSync(logPath, "late\n"); // child finally creates + writes
    await wait(40);
    expect(lines).toEqual(["late"]);

    alive = false;
    await wait(30);
    expect(finalized).toBe(true);
    tailer.stop();
  });

  it("finalizes immediately when the log file does not exist", async () => {
    let finalized = false;
    const tailer = new RunTailer({
      logPath: path.join(dir, "missing.jsonl"),
      startOffset: 0,
      pollIntervalMs: 10,
      isAlive: () => false,
      onLine: () => {},
      onOffset: () => {},
      onFinalize: () => { finalized = true; },
    });
    tailer.start();
    await wait(20);
    expect(finalized).toBe(true);
  });

  it("finalizes when the process stays alive but the log stops growing", async () => {
    fs.writeFileSync(logPath, "stuck\n");

    let finalized = false;
    let alive = true;
    const tailer = new RunTailer({
      logPath,
      startOffset: 0,
      pollIntervalMs: 10,
      stallTimeoutMs: 80,
      isAlive: () => alive,
      onLine: () => {},
      onOffset: () => {},
      onFinalize: () => { finalized = true; },
    });
    tailer.start();
    await wait(40);
    expect(finalized).toBe(false);

    await wait(100);
    expect(finalized).toBe(true);
    expect(alive).toBe(true);

    alive = false;
    tailer.stop();
  });
});

describe("isPidAlive", () => {
  it("returns true for the current process and false for invalid pids", () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
  });
});
