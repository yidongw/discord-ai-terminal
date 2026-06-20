import { describe, it, expect } from "vitest";
import { ccAgent } from "../../src/agents/cc.js";
import { codexAgent } from "../../src/agents/codex.js";
import { cursorAgent } from "../../src/agents/cs.js";
import type { AgentRunOptions } from "../../src/agents/index.js";

describe("Goal Integration", () => {
  const workDir = "/tmp/test";
  const prompt = "fix the bug";
  const goal = "Improve code quality and fix TypeScript errors";

  describe("Claude Code", () => {
    it("should include goal in system prompt when set", () => {
      const opts: AgentRunOptions = {
        goal,
        discordContext: {
          channelId: "123",
          channelName: "test",
          userId: "456",
        },
        mode: "auto",
      };

      const command = ccAgent.buildCommand(workDir, prompt, opts);

      // Goal should be in the --append-system-prompt
      expect(command).toContain("--append-system-prompt");
      expect(command).toContain(`Your goal for this session is: ${goal}`);
    });

    it("should not include goal when not set", () => {
      const opts: AgentRunOptions = {
        discordContext: {
          channelId: "123",
          channelName: "test",
          userId: "456",
        },
        mode: "auto",
      };

      const command = ccAgent.buildCommand(workDir, prompt, opts);

      expect(command).toContain("--append-system-prompt");
      expect(command).not.toContain("Your goal for this session is:");
    });
  });

  describe("Codex", () => {
    it("should prepend goal to prompt when set", () => {
      const opts: AgentRunOptions = {
        goal,
        codexModel: "gpt-5.4-mini",
      };

      const command = codexAgent.buildCommand(workDir, prompt, opts);

      // Goal should be prepended to the prompt
      expect(command).toContain(`Your goal for this session is: ${goal}`);
      expect(command).toContain(prompt);
    });

    it("should not prepend goal when not set", () => {
      const opts: AgentRunOptions = {
        codexModel: "gpt-5.4-mini",
      };

      const command = codexAgent.buildCommand(workDir, prompt, opts);

      expect(command).not.toContain("Your goal for this session is:");
      expect(command).toContain(prompt);
    });
  });

  describe("Cursor", () => {
    it("should prepend goal to prompt when set", () => {
      const opts: AgentRunOptions = {
        goal,
        csModel: "auto",
        discordContext: {
          channelId: "123",
          channelName: "test",
          userId: "456",
        },
      };

      const command = cursorAgent.buildCommand(workDir, prompt, opts);

      // Goal should be prepended before Discord wrapper
      expect(command).toContain(`Your goal for this session is: ${goal}`);
      expect(command).toContain(prompt);
    });

    it("should not prepend goal when not set", () => {
      const opts: AgentRunOptions = {
        csModel: "auto",
        discordContext: {
          channelId: "123",
          channelName: "test",
          userId: "456",
        },
      };

      const command = cursorAgent.buildCommand(workDir, prompt, opts);

      expect(command).not.toContain("Your goal for this session is:");
      expect(command).toContain(prompt);
    });
  });
});
