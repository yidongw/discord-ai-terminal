import { describe, it, expect } from "vitest";
import {
  MAX_STALL_WAKEUPS,
  STALL_CONTINUATION_PROMPT,
} from "../../src/bot/stall-wakeup.js";
import { shouldSendHandoffDone } from "../../src/bot/handoff.js";

describe("stall wakeup", () => {
  it("uses a continue-where-you-left-off prompt", () => {
    expect(STALL_CONTINUATION_PROMPT).toContain("Continue exactly where you left off");
    expect(STALL_CONTINUATION_PROMPT).toContain("at least once per minute");
  });

  it("caps automatic wakeups at 2 per turn", () => {
    expect(MAX_STALL_WAKEUPS).toBe(2);
  });

  it("suppresses handoff Done while a stall resume is pending", () => {
    expect(shouldSendHandoffDone({
      handoffBot: "review-bot",
      queueLength: 0,
      hasPendingPostRunPrompt: false,
      usageLimitWaiting: false,
      pendingUsageLimitResume: false,
      pendingTurnLimitResume: false,
      pendingStallWakeup: true,
      hasEnabledScheduledTasks: false,
    })).toBe(false);
  });
});
