import { describe, it, expect } from "vitest";
import {
  MAX_EMPTY_DONE_RETRIES,
  isNoResponseAck,
  shouldRetryEmptyDone,
  shouldFreshSessionEmptyDone,
  isProgrammaticWake,
} from "../../src/bot/empty-done-retry.js";
import { shouldSendHandoffDone } from "../../src/bot/handoff.js";

describe("empty-done retry", () => {
  it("a scheduled task firing is not a programmatic wake, so its 0-turn phantom is retried", () => {
    // smart-money 2h loop lost 3 rounds on 2026-09-25 (08:53/12:55/18:55Z):
    // scheduler sends messageId "" → treated as a wake → 'giving up retries=0'.
    const scheduled = { channelId: "t", channelName: "loop", userId: "u", messageId: "", scheduled: true };
    expect(isProgrammaticWake(scheduled)).toBe(false);
    expect(isProgrammaticWake({ channelId: "t", channelName: "x", userId: "", messageId: "" })).toBe(true);
    expect(isProgrammaticWake(undefined)).toBe(true);
    expect(isProgrammaticWake({ channelId: "t", channelName: "x", userId: "u", messageId: "123" })).toBe(false);
    expect(shouldRetryEmptyDone({
      agentKey: "cc",
      turns: 0,
      sawRealAssistantText: false,
      toolCallCount: 0,
      prompt: "smart-money 2h review",
      retriesSoFar: 0,
      isWake: isProgrammaticWake(scheduled),
    })).toBe(true);
  });

  it("recognizes Claude Code no-response acknowledgements", () => {
    expect(isNoResponseAck("No response requested.")).toBe(true);
    expect(isNoResponseAck("  no action needed.  ")).toBe(true);
    expect(isNoResponseAck("Nothing needed from you.")).toBe(true);
    expect(isNoResponseAck("Here is the real answer")).toBe(false);
  });

  it("retries cc 0-turn done with no real work up to the cap", () => {
    expect(shouldRetryEmptyDone({
      agentKey: "cc",
      turns: 0,
      sawRealAssistantText: false,
      toolCallCount: 0,
      prompt: "fix the freeze",
      retriesSoFar: 0,
    })).toBe(true);
    expect(shouldRetryEmptyDone({
      agentKey: "cc",
      turns: 0,
      sawRealAssistantText: false,
      toolCallCount: 0,
      prompt: "fix the freeze",
      retriesSoFar: 1,
    })).toBe(true);
  });

  it("uses a fresh session on the second retry attempt", () => {
    expect(shouldFreshSessionEmptyDone(1)).toBe(false);
    expect(shouldFreshSessionEmptyDone(2)).toBe(true);
  });

  it("does not retry after the cap, for other agents, or after real work", () => {
    const base = {
      agentKey: "cc",
      turns: 0 as number | null,
      sawRealAssistantText: false,
      toolCallCount: 0,
      prompt: "fix the freeze",
      retriesSoFar: 0,
    };
    expect(shouldRetryEmptyDone({ ...base, retriesSoFar: MAX_EMPTY_DONE_RETRIES })).toBe(false);
    expect(shouldRetryEmptyDone({ ...base, agentKey: "cs" })).toBe(false);
    expect(shouldRetryEmptyDone({ ...base, turns: 1 })).toBe(false);
    expect(shouldRetryEmptyDone({ ...base, turns: null })).toBe(false);
    expect(shouldRetryEmptyDone({ ...base, sawRealAssistantText: true })).toBe(false);
    expect(shouldRetryEmptyDone({ ...base, toolCallCount: 1 })).toBe(false);
    expect(shouldRetryEmptyDone({ ...base, prompt: "  " })).toBe(false);
  });

  it("does not retry a programmatic wake (no messageId) — valid no-op, inbox backstops", () => {
    const base = {
      agentKey: "cc",
      turns: 0 as number | null,
      sawRealAssistantText: false,
      toolCallCount: 0,
      prompt: "买后仓位复核 MICRODUCK [robinhood/live] …",
      retriesSoFar: 0,
    };
    // A user-typed message that phantoms still retries…
    expect(shouldRetryEmptyDone({ ...base, isWake: false })).toBe(true);
    // …but a wake the agent deliberately no-ops does not re-spam.
    expect(shouldRetryEmptyDone({ ...base, isWake: true })).toBe(false);
  });

  it("suppresses handoff Done while empty-done retry is pending", () => {
    expect(shouldSendHandoffDone({
      handoffBot: "review-bot",
      queueLength: 0,
      hasPendingPostRunPrompt: false,
      usageLimitWaiting: false,
      pendingUsageLimitResume: false,
      pendingTurnLimitResume: false,
      pendingStallWakeup: false,
      pendingEmptyDoneRetry: true,
      hasEnabledScheduledTasks: false,
    })).toBe(false);
  });
});
