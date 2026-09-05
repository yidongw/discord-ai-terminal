import { describe, it, expect } from "vitest";
import {
  MAX_EMPTY_DONE_RETRIES,
  isNoResponseAck,
  shouldRetryEmptyDone,
} from "../../src/bot/empty-done-retry.js";
import { shouldSendHandoffDone } from "../../src/bot/handoff.js";

describe("empty-done retry", () => {
  it("recognizes Claude Code no-response acknowledgements", () => {
    expect(isNoResponseAck("No response requested.")).toBe(true);
    expect(isNoResponseAck("  no action needed.  ")).toBe(true);
    expect(isNoResponseAck("Nothing needed from you.")).toBe(true);
    expect(isNoResponseAck("Here is the real answer")).toBe(false);
  });

  it("retries cc 0-turn done with no real work once", () => {
    expect(shouldRetryEmptyDone({
      agentKey: "cc",
      turns: 0,
      sawRealAssistantText: false,
      toolCallCount: 0,
      prompt: "fix the freeze",
      retriesSoFar: 0,
    })).toBe(true);
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
