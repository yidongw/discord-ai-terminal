import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { GatewayWatchdog } from "../../src/bot/gateway-watchdog.js";

// Minimal stand-in for discord.js Client: an EventEmitter plus a toggleable
// isReady(). The watchdog only touches .on() and .isReady().
class FakeClient extends EventEmitter {
  private ready = true;
  isReady() {
    return this.ready;
  }
  setReady(v: boolean) {
    this.ready = v;
  }
}

function makeWatchdog(opts: { graceMs?: number } = {}) {
  const client = new FakeClient();
  let clock = 0;
  const reasons: string[] = [];
  const watchdog = new GatewayWatchdog(client as any, {
    graceMs: opts.graceMs ?? 90_000,
    now: () => clock,
    log: () => {},
    onUnhealthy: (r) => reasons.push(r),
  });
  watchdog.start();
  return {
    client,
    watchdog,
    reasons,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("GatewayWatchdog", () => {
  it("stays healthy while the gateway is ready", () => {
    const { watchdog, reasons } = makeWatchdog();
    for (let i = 0; i < 10; i++) expect(watchdog.tick()).toBe(false);
    expect(reasons).toEqual([]);
  });

  it("does not trip before the grace window elapses", () => {
    const { watchdog, client, reasons, advance } = makeWatchdog({ graceMs: 90_000 });
    client.setReady(false);
    watchdog.tick(); // starts the grace clock at t=0
    advance(89_000);
    expect(watchdog.tick()).toBe(false);
    expect(reasons).toEqual([]);
  });

  it("trips after the gateway stays un-ready past the grace window", () => {
    const { watchdog, client, reasons, advance } = makeWatchdog({ graceMs: 90_000 });
    client.setReady(false);
    watchdog.tick(); // grace clock starts at t=0
    advance(90_000);
    expect(watchdog.tick()).toBe(true);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/not ready for 90s/);
  });

  it("resets the grace clock when the gateway recovers before the window", () => {
    const { watchdog, client, reasons, advance } = makeWatchdog({ graceMs: 90_000 });
    client.setReady(false);
    watchdog.tick();
    advance(80_000);
    // Recover, then drop again — the clock should restart, not carry the 80s over.
    client.setReady(true);
    expect(watchdog.tick()).toBe(false);
    client.setReady(false);
    watchdog.tick(); // grace clock restarts here
    advance(80_000);
    expect(watchdog.tick()).toBe(false);
    expect(reasons).toEqual([]);
  });

  it("trips immediately when the session is invalidated, regardless of grace", () => {
    const { watchdog, client, reasons } = makeWatchdog({ graceMs: 90_000 });
    client.setReady(false); // invalidated sessions are also un-ready
    client.emit("invalidated");
    expect(watchdog.tick()).toBe(true);
    expect(reasons).toEqual(["gateway session invalidated"]);
  });

  it("only fires onUnhealthy once even if ticked again after tripping", () => {
    const { watchdog, client, reasons, advance } = makeWatchdog({ graceMs: 90_000 });
    client.setReady(false);
    watchdog.tick();
    advance(120_000);
    expect(watchdog.tick()).toBe(true);
    expect(watchdog.tick()).toBe(true);
    expect(watchdog.tick()).toBe(true);
    expect(reasons).toHaveLength(1);
  });

  it("stop() clears the polling timer", () => {
    const client = new FakeClient();
    const onUnhealthy = vi.fn();
    const watchdog = new GatewayWatchdog(client as any, {
      checkIntervalMs: 10,
      now: () => 0,
      log: () => {},
      onUnhealthy,
    });
    watchdog.start();
    watchdog.stop();
    // No assertion on timers beyond "does not throw"; tick() remains callable.
    expect(() => watchdog.tick()).not.toThrow();
  });
});
