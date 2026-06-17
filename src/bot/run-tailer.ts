import * as fs from "fs";

// How often we re-stat the log file for new output. Discord rate limits dominate
// end-to-end latency, so a quarter-second poll is imperceptible.
const POLL_INTERVAL_MS = 250;
// Cap per-read so a huge backlog (e.g. after a long detached run) is consumed in
// bounded chunks rather than one giant allocation.
const MAX_READ_BYTES = 1 << 20; // 1 MiB
// If the agent process is still alive but its log file stops growing for this
// long, treat the run as hung and finalize (stops the typing indicator). Long
// enough for slow shell tools; short enough that a zombie cursor/claude process
// does not leave "typing…" up indefinitely.
export const LOG_STALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunTailerOptions {
  logPath: string;
  // Byte offset to begin reading from. 0 for a fresh run; the persisted
  // stdout_offset when re-attaching after a restart.
  startOffset: number;
  pollIntervalMs?: number;
  // Log-byte inactivity threshold before finalizing a still-alive process.
  stallTimeoutMs?: number;
  // Is the agent process still running? Fresh runs check the ChildProcess; a
  // re-attached run checks the bare PID. When this returns false AND the file is
  // fully consumed, the run is finalized.
  isAlive: () => boolean;
  // Hand a complete, non-empty output line to the parser.
  onLine: (line: string) => void;
  // Persist the consumed (complete-line) byte offset. Called synchronously after
  // each tick so a restart resumes from the last line boundary.
  onOffset: (offset: number) => void;
  // Process exited and the file is fully drained.
  onFinalize: () => void | Promise<void>;
}

/**
 * Tails a detached agent's append-only log file and feeds complete lines to the
 * parser. Reading from a FILE (rather than the process's stdout pipe) is what
 * lets a brand-new bot re-attach to a run started by a previous bot: the file
 * outlives the process that wrote it, and the persisted offset marks where to
 * resume. Splitting on byte-level newlines keeps the offset arithmetic exact and
 * never splits a multibyte UTF-8 character (lines are whole UTF-8 sequences).
 */
export class RunTailer {
  private fd?: number;
  // Bytes physically read from the file so far.
  private readOffset: number;
  // Bytes consumed as complete lines (this is what gets persisted). Equals
  // readOffset minus whatever sits unterminated in `pending`.
  private consumedOffset: number;
  private pending: Buffer = Buffer.alloc(0);
  private timer?: ReturnType<typeof setInterval>;
  private finalizing = false;
  private stopped = false;
  private lastLogGrowthAt: number;

  constructor(private opts: RunTailerOptions) {
    this.readOffset = opts.startOffset;
    this.consumedOffset = opts.startOffset;
    this.lastLogGrowthAt = Date.now();
  }

  start(): void {
    const interval = this.opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.timer = setInterval(() => this.tick(), interval);
    // Tick immediately so an already-finished run (common on re-attach to a run
    // that completed while the bot was down) finalizes without waiting a poll.
    this.tick();
  }

  // Open the log lazily. A freshly-spawned detached agent may not have created
  // the file yet when we start tailing in the same tick, so we retry on later
  // ticks instead of giving up. Returns true once the fd is open.
  private ensureOpen(): boolean {
    if (this.fd !== undefined) return true;
    try { this.fd = fs.openSync(this.opts.logPath, "r"); return true; }
    catch { return false; }
  }

  // Stop tailing WITHOUT finalizing. Used on graceful shutdown: the agent keeps
  // running detached and a future bot re-attaches from the persisted offset. We
  // do one last drain first to narrow the duplicate window on the next boot.
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    try {
      if (this.ensureOpen()) this.drainAvailable();
    } catch (err) {
      console.error(`[tailer] final drain failed on ${this.opts.logPath}:`, err);
    }
    this.closeFd();
  }

  private closeFd(): void {
    if (this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch {}
      this.fd = undefined;
    }
  }

  private tick(): void {
    if (this.stopped || this.finalizing) return;
    try {
      if (this.ensureOpen()) this.drainAvailable();
    } catch (err) {
      console.error(`[tailer] read error on ${this.opts.logPath}:`, err);
    }
    // Finalize only once the process is gone AND we've consumed everything it
    // wrote — so a run that exits with a burst of trailing output still streams
    // it before we mark the thread idle. With the fd still unopened, atEof() is
    // true, so a dead process whose log never appeared also finalizes here.
    if (!this.opts.isAlive() && this.atEof()) {
      void this.finalize();
      return;
    }
    const stallMs = this.opts.stallTimeoutMs ?? LOG_STALL_TIMEOUT_MS;
    if (this.opts.isAlive() && this.atEof() && Date.now() - this.lastLogGrowthAt >= stallMs) {
      console.warn(`[tailer] log stall on ${this.opts.logPath} — finalizing hung run`);
      void this.finalize();
    }
  }

  private atEof(): boolean {
    if (this.fd === undefined) return true;
    try {
      return this.readOffset >= fs.fstatSync(this.fd).size;
    } catch {
      return true;
    }
  }

  private drainAvailable(): void {
    if (this.fd === undefined) return;
    const size = fs.fstatSync(this.fd).size;
    while (this.readOffset < size) {
      const want = Math.min(size - this.readOffset, MAX_READ_BYTES);
      const chunk = Buffer.allocUnsafe(want);
      const n = fs.readSync(this.fd, chunk, 0, want, this.readOffset);
      if (n <= 0) break;
      this.readOffset += n;
      this.lastLogGrowthAt = Date.now();
      const slice = chunk.subarray(0, n);
      this.pending = this.pending.length ? Buffer.concat([this.pending, slice]) : Buffer.from(slice);
      this.processLines();
    }
  }

  private processLines(): void {
    let nl: number;
    while ((nl = this.pending.indexOf(0x0a)) !== -1) {
      const lineBuf = this.pending.subarray(0, nl);
      this.pending = this.pending.subarray(nl + 1);
      // Advance by the line's bytes plus the newline we just consumed.
      this.consumedOffset += lineBuf.length + 1;
      const line = lineBuf.toString("utf8").trim();
      if (line) {
        try { this.opts.onLine(line); }
        catch (err) { console.error("[tailer] onLine failed:", err); }
      }
    }
    // Persist the line-boundary offset so a crash/restart resumes here.
    try { this.opts.onOffset(this.consumedOffset); }
    catch (err) { console.error("[tailer] onOffset failed:", err); }
  }

  private async finalize(): Promise<void> {
    if (this.finalizing) return;
    this.finalizing = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    // Flush a trailing line the agent wrote without a closing newline.
    const tail = this.pending.toString("utf8").trim();
    this.pending = Buffer.alloc(0);
    if (tail) {
      try { this.opts.onLine(tail); }
      catch (err) { console.error("[tailer] onLine (final) failed:", err); }
    }
    this.closeFd();
    try { await this.opts.onFinalize(); }
    catch (err) { console.error("[tailer] onFinalize failed:", err); }
  }
}

// True if a process with this PID currently exists. Used by re-attached runs
// (which have no ChildProcess handle) to detect when the detached agent exits.
export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means it exists but we can't signal it — still alive.
    return err?.code === "EPERM";
  }
}
