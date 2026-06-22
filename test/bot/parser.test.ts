import { describe, it, expect } from "vitest";
import {
  hasAnyMention,
  hasReviewBotMention,
  parseAgentFromThreadName,
  parseAgentInvocations,
  shouldHandleAddressedMessage,
  titleFromThreadName,
} from "../../src/bot/parser.js";

describe("shouldHandleAddressedMessage", () => {
  const SELF = "self-bot-id";
  const OTHER = "other-bot-id";

  it("the default responder handles messages that address no bot", () => {
    expect(
      shouldHandleAddressedMessage({ selfId: SELF, isDefaultResponder: true, addressedBotIds: [] })
    ).toBe(true);
  });

  it("a non-default instance ignores messages that address no bot", () => {
    expect(
      shouldHandleAddressedMessage({ selfId: SELF, isDefaultResponder: false, addressedBotIds: [] })
    ).toBe(false);
  });

  it("a bot handles a message that addresses it, regardless of default status", () => {
    expect(
      shouldHandleAddressedMessage({ selfId: SELF, isDefaultResponder: false, addressedBotIds: [SELF] })
    ).toBe(true);
    expect(
      shouldHandleAddressedMessage({ selfId: SELF, isDefaultResponder: true, addressedBotIds: [SELF] })
    ).toBe(true);
  });

  it("a bot ignores a message that addresses only another bot, even if it is the default", () => {
    expect(
      shouldHandleAddressedMessage({ selfId: SELF, isDefaultResponder: true, addressedBotIds: [OTHER] })
    ).toBe(false);
  });

  it("a bot handles a message that addresses both it and another bot", () => {
    expect(
      shouldHandleAddressedMessage({ selfId: SELF, isDefaultResponder: false, addressedBotIds: [OTHER, SELF] })
    ).toBe(true);
  });

  it("ignores when self id is not yet known", () => {
    expect(
      shouldHandleAddressedMessage({ selfId: undefined, isDefaultResponder: false, addressedBotIds: [SELF] })
    ).toBe(false);
  });
});

describe("hasReviewBotMention", () => {
  const reviewBotIds = ["123456789", "hermes", "review-bot"];

  it("returns true for Discord ID mention matching review bot", () => {
    expect(hasReviewBotMention("<@123456789> please review", reviewBotIds)).toBe(true);
    expect(hasReviewBotMention("<@!123456789> please review", reviewBotIds)).toBe(true);
  });

  it("returns true for username mention matching review bot", () => {
    expect(hasReviewBotMention("@hermes please review this PR", reviewBotIds)).toBe(true);
    expect(hasReviewBotMention("@review-bot check this", reviewBotIds)).toBe(true);
  });

  it("is case-insensitive for username mentions", () => {
    expect(hasReviewBotMention("@Hermes please review", reviewBotIds)).toBe(true);
    expect(hasReviewBotMention("@HERMES review this", reviewBotIds)).toBe(true);
  });

  it("returns false when reviewBotIds is empty", () => {
    expect(hasReviewBotMention("@hermes please review", [])).toBe(false);
  });

  it("returns false for Discord ID mention not in review bots", () => {
    expect(hasReviewBotMention("<@987654321> please review", reviewBotIds)).toBe(false);
  });

  it("returns false for username mention not in review bots", () => {
    expect(hasReviewBotMention("@cc fix this bug", reviewBotIds)).toBe(false);
    expect(hasReviewBotMention("@tim can you review?", reviewBotIds)).toBe(false);
  });

  it("returns false for plain text", () => {
    expect(hasReviewBotMention("hello world", reviewBotIds)).toBe(false);
  });

  it("returns false for partial matches", () => {
    expect(hasReviewBotMention("@hermes123 review", reviewBotIds)).toBe(false);
  });
});

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
  it("parses @cco4.8 with model override and clean prompt", () => {
    expect(parseAgentInvocations("@cco4.8 fix this")).toEqual([
      { agent: "cc", prompt: "fix this", model: "claude-opus-4-8" },
    ]);
  });

  it("parses @cc o4.8 with space-separated model override", () => {
    expect(parseAgentInvocations("@cc o4.8 fix this")).toEqual([
      { agent: "cc", prompt: "fix this", model: "claude-opus-4-8" },
    ]);
  });

  it("parses plain @cc without model override", () => {
    expect(parseAgentInvocations("@cc fix this")).toEqual([
      { agent: "cc", prompt: "fix this" },
    ]);
  });

  it("keeps only the first model when the same agent is mentioned twice", () => {
    expect(parseAgentInvocations("@cco4.7 @cco4.6 fix this")).toEqual([
      { agent: "cc", prompt: "fix this", model: "claude-opus-4-7" },
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
