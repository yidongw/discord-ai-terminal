import type { Client } from "discord.js";

/**
 * Watches the Discord gateway connection and, if it stays down past a grace
 * window, exits the process so the service supervisor (launchd `KeepAlive` on
 * macOS, systemd `Restart=` on Linux) brings up a fresh instance.
 *
 * Why this exists: the bot also runs an HTTP health server (the MCP permission
 * server on :3001). discord.js auto-reconnects most of the time, but a gateway
 * WebSocket that aborts mid-connect during a Discord hiccup can leave the client
 * permanently un-ready while the HTTP server keeps answering. The process looks
 * "alive" to KeepAlive but is invisible/unreachable from Discord — a half-up
 * zombie that only a manual `launchctl kickstart` recovers. This watchdog turns
 * that silent wedge into a clean exit so KeepAlive can actually cycle it.
 *
 * The decision logic ({@link tick}) is pure and clock-injectable so it can be
 * unit-tested without real timers or a live gateway.
 */
export interface GatewayWatchdogOptions {
  /** How long the gateway may stay un-ready before we judge the process wedged. */
  graceMs?: number;
  /** How often to poll gateway readiness. */
  checkIntervalMs?: number;
  /**
   * Called when the gateway is judged unrecoverable. Defaults to exiting with a
   * non-zero code so the supervisor's KeepAlive restarts the bot.
   */
  onUnhealthy?: (reason: string) => void;
  /** Injectable clock (ms). Defaults to Date.now. */
  now?: () => number;
  /** Injectable logger. Defaults to console.log. */
  log?: (msg: string) => void;
}

// 90s comfortably covers discord.js's normal reconnect/resume backoff (a healthy
// blip recovers in seconds) while still bailing well before a human notices the
// bot is gone.
const DEFAULT_GRACE_MS = 90_000;
const DEFAULT_CHECK_INTERVAL_MS = 15_000;

export class GatewayWatchdog {
  private timer?: ReturnType<typeof setInterval>;
  // Timestamp the gateway first went un-ready in the current down stretch, or
  // null while it's ready. Reset to null on every recovery so only a *sustained*
  // outage trips the watchdog.
  private unhealthySince: number | null = null;
  private invalidated = false;
  private tripped = false;

  private readonly graceMs: number;
  private readonly checkIntervalMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly onUnhealthy: (reason: string) => void;

  constructor(private readonly client: Client, opts: GatewayWatchdogOptions = {}) {
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.log(m));
    this.onUnhealthy =
      opts.onUnhealthy ??
      ((reason) => {
        console.error(`[watchdog] ${reason} — exiting so KeepAlive restarts the bot`);
        process.exit(1);
      });
  }

  /**
   * Start polling and wire gateway lifecycle logging. Call this only after the
   * client has first reached `ready`, so the initial connect isn't mistaken for
   * an outage.
   */
  start(): void {
    // Surface gateway lifecycle in the log so a reconnect storm is visible
    // instead of the log going silent (which is what made the original incident
    // hard to diagnose).
    this.client.on("shardDisconnect", (event: { code?: number }, id: number) =>
      this.log(`[watchdog] shard ${id} disconnected (code=${event?.code})`)
    );
    this.client.on("shardReconnecting", (id: number) =>
      this.log(`[watchdog] shard ${id} reconnecting`)
    );
    this.client.on("shardResume", (id: number) => this.log(`[watchdog] shard ${id} resumed`));
    this.client.on("shardReady", (id: number) => this.log(`[watchdog] shard ${id} ready`));
    this.client.on("shardError", (err: Error, id: number) =>
      this.log(`[watchdog] shard ${id} error: ${err?.message ?? err}`)
    );
    // Emitted when the session can't be resumed and a fresh identify is refused:
    // discord.js stops trying, so we must restart rather than wait out the grace.
    this.client.on("invalidated", () => {
      this.invalidated = true;
      this.log("[watchdog] session invalidated");
    });

    this.timer = setInterval(() => this.tick(), this.checkIntervalMs);
    // Don't hold the event loop open just for the watchdog.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Evaluate gateway health once. Exposed (and pure aside from the injected
   * clock/callback) so tests can drive it deterministically. Returns true once
   * it has tripped.
   */
  tick(): boolean {
    if (this.tripped) return true;

    if (this.invalidated) {
      return this.trip("gateway session invalidated");
    }

    if (this.client.isReady()) {
      this.unhealthySince = null;
      return false;
    }

    const now = this.now();
    if (this.unhealthySince === null) {
      this.unhealthySince = now;
      return false;
    }

    const downMs = now - this.unhealthySince;
    if (downMs >= this.graceMs) {
      return this.trip(`gateway not ready for ${Math.round(downMs / 1000)}s`);
    }
    return false;
  }

  private trip(reason: string): boolean {
    this.tripped = true;
    this.stop();
    this.onUnhealthy(reason);
    return true;
  }
}
