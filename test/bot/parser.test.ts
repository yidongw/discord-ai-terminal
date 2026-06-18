import { describe, it, expect } from "vitest";
import { hasAnyMention } from "../../src/bot/parser.js";

describe("hasAnyMention", () => {
  it("returns false for plain text", () => {
    expect(hasAnyMention("hello world")).toBe(false);
  });

  it("returns true for Discord user pings", () => {
    expect(hasAnyMention("hey <@123456789>")).toBe(true);
  });

  it("returns true for text @mentions that are not agents", () => {
    expect(hasAnyMention("@tim can you review?")).toBe(true);
  });

  it("returns false when @ is not followed by a token", () => {
    expect(hasAnyMention("email me @ example.com")).toBe(false);
  });
});
