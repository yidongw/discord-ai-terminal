import { describe, it, expect } from "vitest";
import {
  hasAnyMention,
  hasBlockingUserMention,
  hasReviewBotMention,
  parseAgentFromThreadName,
  parseAgentInvocations,
  titleFromThreadName,
} from "../../src/bot/parser.js";

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

describe("hasBlockingUserMention", () => {
  const users = (...ids: string[]) => {
    const map = new Map(ids.map((id) => [id, { id }]));
    return {
      size: map.size,
      keys: () => map.keys(),
    };
  };

  it("allows plain messages with no mentions", () => {
    expect(
      hasBlockingUserMention({
        mentions: { everyone: false, roles: { size: 0 }, users: users() },
      })
    ).toBe(false);
  });

  it("allows reply-only auto-mention of the replied-to user (e.g. reply to agent)", () => {
    expect(
      hasBlockingUserMention({
        reference: { messageId: "msg-1" },
        mentions: {
          everyone: false,
          roles: { size: 0 },
          users: users("bot-99"),
          repliedUser: { id: "bot-99" },
        },
      })
    ).toBe(false);
  });

  it("blocks intentional pings of other users", () => {
    expect(
      hasBlockingUserMention({
        mentions: {
          everyone: false,
          roles: { size: 0 },
          users: users("user-2"),
        },
      })
    ).toBe(true);
  });

  it("blocks reply-to-agent that also pings someone else", () => {
    expect(
      hasBlockingUserMention({
        reference: { messageId: "msg-1" },
        mentions: {
          everyone: false,
          roles: { size: 0 },
          users: users("bot-99", "user-2"),
          repliedUser: { id: "bot-99" },
        },
      })
    ).toBe(true);
  });

  it("blocks role and everyone mentions", () => {
    expect(
      hasBlockingUserMention({
        mentions: { everyone: true, roles: { size: 0 }, users: users() },
      })
    ).toBe(true);
    expect(
      hasBlockingUserMention({
        mentions: { everyone: false, roles: { size: 1 }, users: users() },
      })
    ).toBe(true);
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
