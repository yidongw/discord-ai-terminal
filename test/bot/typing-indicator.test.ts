import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// session-manager transitively imports DatabaseManager (bun:sqlite), which the
// vitest/node runner can't resolve. Stub it so the module loads.
vi.mock("bun:sqlite", () => ({
  Database: vi.fn().mockImplementation(() => ({
    exec: vi.fn(),
    query: vi.fn(() => ({ get: vi.fn(), run: vi.fn(), all: vi.fn() })),
    close: vi.fn(),
  })),
}));

import { TypingIndicator } from "../../src/bot/session-manager.js";

describe("TypingIndicator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires immediately on start and then on the interval", () => {
    const thread = { sendTyping: vi.fn().mockResolvedValue(undefined) };
    const typing = new TypingIndicator(thread, 8000);

    typing.start();
    expect(thread.sendTyping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(8000);
    expect(thread.sendTyping).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(8000);
    expect(thread.sendTyping).toHaveBeenCalledTimes(3);

    typing.stop();
  });

  it("stops firing after stop()", () => {
    const thread = { sendTyping: vi.fn().mockResolvedValue(undefined) };
    const typing = new TypingIndicator(thread, 8000);

    typing.start();
    typing.stop();

    vi.advanceTimersByTime(8000 * 5);
    expect(thread.sendTyping).toHaveBeenCalledTimes(1); // only the immediate one
  });

  it("is idempotent: a second start() does not stack timers", () => {
    const thread = { sendTyping: vi.fn().mockResolvedValue(undefined) };
    const typing = new TypingIndicator(thread, 8000);

    typing.start();
    typing.start(); // no-op while already running
    expect(thread.sendTyping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(8000);
    expect(thread.sendTyping).toHaveBeenCalledTimes(2); // not 3+

    typing.stop();
  });

  it("swallows sendTyping rejections without throwing", () => {
    const thread = { sendTyping: vi.fn().mockRejectedValue(new Error("rate limited")) };
    const typing = new TypingIndicator(thread, 8000);

    expect(() => typing.start()).not.toThrow();
    expect(() => vi.advanceTimersByTime(8000)).not.toThrow();

    typing.stop();
  });

  it("can be restarted after stop", () => {
    const thread = { sendTyping: vi.fn().mockResolvedValue(undefined) };
    const typing = new TypingIndicator(thread, 8000);

    typing.start();
    typing.stop();
    typing.start();
    expect(thread.sendTyping).toHaveBeenCalledTimes(2); // one per start

    typing.stop();
  });
});
