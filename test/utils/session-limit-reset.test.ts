import { describe, it, expect } from "vitest";
import {
  isUsageLimitMessage,
  isServerRateLimitMessage,
  parseSessionLimitReset,
  parseRateLimitReset,
  defaultServerRateLimitRetry,
  SERVER_RATE_LIMIT_RETRY_MS,
} from "../../src/utils/session-limit-reset.js";

describe("session-limit-reset", () => {
  it("detects usage limit messages", () => {
    expect(isUsageLimitMessage("You've hit your session limit · resets 3:45pm")).toBe(true);
    expect(isUsageLimitMessage("You've hit your weekly limit · resets Mon 12:00am")).toBe(true);
    expect(isUsageLimitMessage("error_max_turns")).toBe(false);
  });

  it("detects server rate limit messages but not usage limits", () => {
    expect(
      isServerRateLimitMessage(
        "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited"
      )
    ).toBe(true);
    expect(isServerRateLimitMessage("Rate limited")).toBe(true);
    expect(isServerRateLimitMessage("You've hit your session limit · resets 3:45pm")).toBe(false);
    expect(isServerRateLimitMessage("error_max_turns")).toBe(false);
  });

  it("defaults server rate limit retry to one minute", () => {
    const now = Date.parse("2026-06-11T14:00:00");
    const retry = defaultServerRateLimitRetry(now);
    expect(retry.resetAt).toBe(now + SERVER_RATE_LIMIT_RETRY_MS);
    expect(retry.resetLabel).toBeTruthy();
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

  it("parses resetsAt unix seconds from cc rate_limit_event", () => {
    const now = new Date("2026-06-10T19:00:00Z"); // before 1781121000 (= 2026-06-10T19:50:00Z)
    const parsed = parseRateLimitReset(
      { status: "rejected", resetsAt: 1781121000 },
      now
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.resetAt).toBe(1781121000 * 1000);
  });

  it("parses reset time with timezone suffix", () => {
    const now = new Date("2026-06-11T19:00:00Z");
    const parsed = parseSessionLimitReset(
      "You've hit your session limit · resets 2:50am (Asia/Bangkok)",
      now
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.resetLabel).toContain("2:50am");
  });
});
