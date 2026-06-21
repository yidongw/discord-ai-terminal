import { describe, it, expect } from "vitest";
import {
  handoffDoneDescription,
  handoffBotNameFromAuthor,
  summarizeForHandoff,
} from "../../src/bot/handoff.js";

describe("handoffBotNameFromAuthor", () => {
  it("uses the Discord username", () => {
    expect(handoffBotNameFromAuthor({ username: "hermes" })).toBe("hermes");
  });
});

describe("handoffDoneDescription", () => {
  it("includes stats, summary, handoff bot, and continue instructions", () => {
    const desc = handoffDoneDescription(
      "*3 turns · $0.12*",
      "Implemented the feature.",
      "hermes",
      "cc"
    );
    expect(desc).toContain("*3 turns · $0.12*");
    expect(desc).toContain("Implemented the feature.");
    expect(desc).toContain("@hermes");
    expect(desc).toContain("Use @cc to continue.");
  });
});

describe("summarizeForHandoff", () => {
  it("returns default when text is empty", () => {
    expect(summarizeForHandoff("  ")).toBe("Work completed.");
  });

  it("truncates long text", () => {
    const long = "a".repeat(2000);
    const result = summarizeForHandoff(long, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith("…")).toBe(true);
  });
});
