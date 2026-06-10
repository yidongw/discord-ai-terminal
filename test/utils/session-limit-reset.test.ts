import { describe, it, expect } from "vitest";
import {
  isUsageLimitMessage,
  parseSessionLimitReset,
  parseRateLimitReset,
} from "../../src/utils/session-limit-reset.js";

describe("session-limit-reset", () => {
  it("detects usage limit messages", () => {
    expect(isUsageLimitMessage("You've hit your session limit · resets 3:45pm")).toBe(true);
    expect(isUsageLimitMessage("You've hit your weekly limit · resets Mon 12:00am")).toBe(true);
    expect(isUsageLimitMessage("error_max_turns")).toBe(false);
  });

  it("parses same-day reset time", () => {
    const now = new Date("2026-06-11T14:00:00");
    const parsed = parseSessionLimitReset(
      "You've hit your session limit · resets 3:45pm",
      now
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.resetLabel).toBe("3:45pm");
    expect(new Date(parsed!.resetAt).getHours()).toBe(15);
    expect(new Date(parsed!.resetAt).getMinutes()).toBe(45);
  });

  it("rolls same-day reset to tomorrow when already past", () => {
    const now = new Date("2026-06-11T16:00:00");
    const parsed = parseSessionLimitReset(
      "You've hit your session limit · resets 3:45pm",
      now
    );
    expect(parsed).not.toBeNull();
    expect(new Date(parsed!.resetAt).getDate()).toBe(12);
  });

  it("parses weekday reset time", () => {
    // 2026-06-11 is a Thursday
    const now = new Date("2026-06-11T14:00:00");
    const parsed = parseSessionLimitReset(
      "You've hit your weekly limit · resets Mon 12:00am",
      now
    );
    expect(parsed).not.toBeNull();
    expect(new Date(parsed!.resetAt).getDay()).toBe(1);
  });

  it("parses ISO reset from rate_limit_event", () => {
    const now = new Date("2026-06-11T14:00:00");
    const parsed = parseRateLimitReset(
      { requests_reset: "2026-06-11T15:45:00.000Z" },
      now
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.resetAt).toBe(new Date("2026-06-11T15:45:00.000Z").getTime());
  });
});
