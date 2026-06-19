import { describe, expect, it } from "vitest";
import { cursorAgent } from "../../src/agents/cs.js";
import { CURSOR_DISCORD_SYSTEM_PROMPT } from "../../src/utils/shell.js";

describe("cursorAgent.titleCommand", () => {
  it("uses read-only ask mode so title generation cannot run tools or return images", () => {
    expect(cursorAgent.titleCommand("title me")).toContain("--mode ask");
    expect(cursorAgent.titleCommand("title me")).not.toContain("--yolo");
  });
});

describe("cursorAgent.buildCommand", () => {
  it("prepends Discord status instructions when discordContext is set", () => {
    const command = cursorAgent.buildCommand("/work", "fix the bug", {
      discordContext: {
        channelId: "123",
        channelName: "test",
        userId: "456",
      },
    });

    expect(command).toContain(CURSOR_DISCORD_SYSTEM_PROMPT);
    expect(command).toContain("fix the bug");
    expect(command).toContain("---");
  });

  it("does not prepend Discord instructions without discordContext", () => {
    const command = cursorAgent.buildCommand("/work", "fix the bug", {});

    expect(command).not.toContain(CURSOR_DISCORD_SYSTEM_PROMPT);
    expect(command).toContain("'fix the bug'");
  });
});
