import { describe, it, expect } from "vitest";
import {
  hasAnyMention,
  parseAgentFromThreadName,
  parseAgentInvocations,
  titleFromThreadName,
} from "../../src/bot/parser.js";

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

describe("parseAgentInvocations", () => {
  it("parses @cc4.8 with model override and clean prompt", () => {
    expect(parseAgentInvocations("@cc4.8 fix this")).toEqual([
      { agent: "cc", prompt: "fix this", model: "claude-opus-4-8" },
    ]);
  });

  it("parses @cc 4.8 with space-separated model override", () => {
    expect(parseAgentInvocations("@cc 4.8 fix this")).toEqual([
      { agent: "cc", prompt: "fix this", model: "claude-opus-4-8" },
    ]);
  });

  it("parses plain @cc without model override", () => {
    expect(parseAgentInvocations("@cc fix this")).toEqual([
      { agent: "cc", prompt: "fix this" },
    ]);
  });

  it("parses @cco4.8 shorthand", () => {
    expect(parseAgentInvocations("@cco4.8 fix this")).toEqual([
      { agent: "cc", prompt: "fix this", model: "claude-opus-4-8" },
    ]);
  });
});

describe("parseAgentFromThreadName", () => {
  it("parses agent prefix from a plain thread name", () => {
    expect(parseAgentFromThreadName("cs • Fix login bug")).toBe("cs");
    expect(parseAgentFromThreadName("cc • Add webhook")).toBe("cc");
  });

  it("parses agent prefix when a status emoji is present", () => {
    expect(parseAgentFromThreadName("🔄 cs • Fix login bug")).toBe("cs");
  });

  it("returns null for PR-renamed threads without an agent prefix", () => {
    expect(parseAgentFromThreadName("#20 • Fix login bug")).toBeNull();
  });

  it("returns null for unrelated thread names", () => {
    expect(parseAgentFromThreadName("general discussion")).toBeNull();
  });
});

describe("titleFromThreadName", () => {
  it("extracts the title portion after the agent prefix", () => {
    expect(titleFromThreadName("cs • Fix login bug")).toBe("Fix login bug");
    expect(titleFromThreadName("🔄 cc • Add tests")).toBe("Add tests");
  });
});
