import { describe, it, expect, vi } from "vitest";

// session-manager transitively imports DatabaseManager (bun:sqlite), which the
// vitest/node runner can't resolve. Stub it so the module loads.
vi.mock("bun:sqlite", () => ({
  Database: vi.fn().mockImplementation(() => ({
    exec: vi.fn(),
    query: vi.fn(() => ({ get: vi.fn(), run: vi.fn(), all: vi.fn() })),
    close: vi.fn(),
  })),
}));

import { Outbox } from "../../src/bot/session-manager.js";

// A fake Discord thread whose send() resolves only when we tell it to, so we
// can simulate a rate-limited backlog and assert ordering/batching/draining.
function makeThread() {
  const sends: any[] = [];
  let release: (() => void) | null = null;
  let gate: Promise<void> | null = null;

  const thread = {
    sends,
    send: vi.fn((payload: any) => {
      sends.push(payload);
      return gate ?? Promise.resolve({ id: `msg-${sends.length}` });
    }),
    // Block the NEXT send until releaseGate() is called.
    openGate() {
      gate = new Promise<void>((res) => { release = () => { res(); }; });
    },
    releaseGate() {
      gate = null;
      release?.();
      release = null;
    },
  };
  return thread;
}

const descOf = (payload: any) => payload.embeds[0].data.description as string;

describe("Outbox", () => {
  it("delivers text immediately when there is no backlog", async () => {
    const thread = makeThread();
    const outbox = new Outbox(thread);

    outbox.pushText("hello");
    await outbox.drain();

    expect(thread.send).toHaveBeenCalledTimes(1);
    expect(descOf(thread.sends[0])).toContain("hello");
  });

  it("coalesces text that arrives while a send is in flight", async () => {
    const thread = makeThread();
    const outbox = new Outbox(thread);

    // First send blocks, simulating a slow/rate-limited Discord call.
    thread.openGate();
    outbox.pushText("A");
    // Let the pump start and pick up "A" (now awaiting the gated send).
    await Promise.resolve();
    await Promise.resolve();

    // These three arrive during the in-flight send and should batch into one.
    outbox.pushText("B");
    outbox.pushText("C");
    outbox.pushText("D");

    thread.releaseGate();
    await outbox.drain();

    expect(thread.send).toHaveBeenCalledTimes(2); // "A", then "BCD"
    expect(descOf(thread.sends[0])).toContain("A");
    expect(descOf(thread.sends[1])).toContain("BCD");
  });

  it("preserves order between text and enqueued ops", async () => {
    const thread = makeThread();
    const outbox = new Outbox(thread);
    const order: string[] = [];

    thread.openGate();
    outbox.pushText("first");
    await Promise.resolve();
    await Promise.resolve();

    outbox.enqueue(async () => { order.push("op"); });
    outbox.pushText("last");

    thread.releaseGate();
    await outbox.drain();

    // text "first" sends, then the op runs, then text "last" sends.
    expect(descOf(thread.sends[0])).toContain("first");
    expect(order).toEqual(["op"]);
    expect(descOf(thread.sends[1])).toContain("last");
  });

  it("drain() waits until every queued message is delivered", async () => {
    const thread = makeThread();
    const outbox = new Outbox(thread);

    thread.openGate();
    outbox.pushText("queued before stop");
    await Promise.resolve();

    let drained = false;
    const drainPromise = outbox.drain().then(() => { drained = true; });

    // Still in flight — drain must not have resolved yet.
    await Promise.resolve();
    expect(drained).toBe(false);

    thread.releaseGate();
    await drainPromise;
    expect(drained).toBe(true);
    expect(thread.send).toHaveBeenCalledTimes(1);
  });

  it("keeps delivering even if one send throws", async () => {
    const thread = makeThread();
    const outbox = new Outbox(thread);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    outbox.enqueue(async () => { throw new Error("boom"); });
    outbox.pushText("after error");
    await outbox.drain();

    expect(descOf(thread.sends[0])).toContain("after error");
    errSpy.mockRestore();
  });
});
