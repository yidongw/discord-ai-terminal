import { describe, it, expect, vi } from "vitest";
import {
  handoffDoneDescription,
  handoffBotNameFromAuthor,
  shouldSendHandoffDone,
  summarizeForHandoff,
} from "../../src/bot/handoff.js";
import { parseAgentInvocations } from "../../src/bot/parser.js";
import { SessionManager } from "../../src/bot/session-manager.js";

describe("handoffBotNameFromAuthor", () => {
  it("uses the Discord username", () => {
    expect(handoffBotNameFromAuthor({ username: "hermes" })).toBe("hermes");
  });
});

describe("shouldSendHandoffDone", () => {
  const idle = {
    handoffBot: "hermes",
    queueLength: 0,
    hasPendingPostRunPrompt: false,
    usageLimitWaiting: false,
    pendingUsageLimitResume: false,
    pendingTurnLimitResume: false,
    hasEnabledScheduledTasks: false,
  };

  it("returns true when handoff is configured and thread is idle", () => {
    expect(shouldSendHandoffDone(idle)).toBe(true);
  });

  it("returns false without handoff bot", () => {
    expect(shouldSendHandoffDone({ ...idle, handoffBot: undefined })).toBe(false);
  });

  it("returns false when messages are queued", () => {
    expect(shouldSendHandoffDone({ ...idle, queueLength: 1 })).toBe(false);
  });

  it("returns false when scheduled tasks are enabled", () => {
    expect(shouldSendHandoffDone({ ...idle, hasEnabledScheduledTasks: true })).toBe(false);
  });

  it("returns false while waiting on usage limit", () => {
    expect(shouldSendHandoffDone({ ...idle, usageLimitWaiting: true })).toBe(false);
  });
});

describe("bot @agent parsing for handoff flows", () => {
  it("recognizes model suffix mentions bots use to re-invoke cc", () => {
    expect(parseAgentInvocations("@cco4.8 please review")).toEqual([
      { agent: "cc", prompt: "please review", model: "claude-opus-4-8" },
    ]);
  });

  it("drops duplicate same-agent model mentions from the prompt", () => {
    expect(parseAgentInvocations("@cco4.7 @cco4.6 continue")).toEqual([
      { agent: "cc", prompt: "continue", model: "claude-opus-4-7" },
    ]);
  });
});

describe("SessionManager handoff idle detection", () => {
  it("defers handoff while bot messages are queued", () => {
    const manager = new SessionManager();
    vi.spyOn(manager.getDb(), "getThreadSession").mockReturnValue({
      threadId: "t1",
      channelId: "c1",
      agent: "cc",
      workDir: "/tmp/wt",
      isWorktree: true,
      createdAt: Date.now(),
      handoffBot: "hermes",
    });
    vi.spyOn(manager.getDb(), "listScheduledTasks").mockReturnValue([]);
    vi.spyOn(manager, "getUsageLimitWait").mockReturnValue({ waiting: false });

    manager.enqueueMessage("t1", {
      prompt: "@cc continue",
      originalText: "@cc continue",
      discordContext: { channelId: "t1", channelName: "cc • x", userId: "bot", messageId: "m1" },
      agentKey: "cc",
      workDir: "/tmp/wt",
      channelId: "c1",
      thread: { name: "cc • x" },
    });

    expect(
      manager.shouldIncludeHandoffInDone("t1", {
        pendingUsageLimitResume: false,
        pendingTurnLimitResume: false,
      } as any)
    ).toBe(false);

    expect(manager.dequeueMessage("t1")).toBeDefined();
    expect(
      manager.shouldIncludeHandoffInDone("t1", {
        pendingUsageLimitResume: false,
        pendingTurnLimitResume: false,
      } as any)
    ).toBe(true);
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
