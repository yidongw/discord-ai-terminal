import { describe, it, expect } from 'vitest';
import type { SDKMessage, ChannelProcess, Config } from '../../src/types/index.js';

describe('Types', () => {
  describe('SDKMessage', () => {
    it('should accept assistant message type', () => {
      const message: SDKMessage = {
        type: "assistant",
        message: { content: "Hello" },
        session_id: "session-123"
      };
      
      expect(message.type).toBe("assistant");
      expect(message.session_id).toBe("session-123");
    });

    it('should accept user message type', () => {
      const message: SDKMessage = {
        type: "user",
        message: { content: "Hi there" },
        session_id: "session-123"
      };
      
      expect(message.type).toBe("user");
      expect(message.session_id).toBe("session-123");
    });

    it('should accept result success message type', () => {
      const message: SDKMessage = {
        type: "result",
        subtype: "success",
        duration_ms: 1000,
        duration_api_ms: 800,
        is_error: false,
        num_turns: 5,
        result: "Task completed",
        session_id: "session-123",
        total_cost_usd: 0.05
      };
      
      expect(message.type).toBe("result");
      expect(message.subtype).toBe("success");
      expect(message.is_error).toBe(false);
    });

    it('should accept result error message type', () => {
      const message: SDKMessage = {
        type: "result",
        subtype: "error_max_turns",
        duration_ms: 2000,
        duration_api_ms: 1500,
        is_error: true,
        num_turns: 10,
        session_id: "session-123",
        total_cost_usd: 0.10
      };
      
      expect(message.type).toBe("result");
      expect(message.subtype).toBe("error_max_turns");
      expect(message.is_error).toBe(true);
    });

    it('should accept system message type', () => {
      const message: SDKMessage = {
        type: "system",
        subtype: "init",
        apiKeySource: "env",
        cwd: "/test/dir",
        session_id: "session-123",
        tools: ["Read", "Write"],
        mcp_servers: [{ name: "server1", status: "active" }],
        model: "claude-3",
        permissionMode: "default"
      };
      
      expect(message.type).toBe("system");
      expect(message.subtype).toBe("init");
      expect(message.tools).toContain("Read");
    });
  });

  describe('ChannelProcess', () => {
    it('should accept valid channel process structure', () => {
      const channelProcess: ChannelProcess = {
        process: { kill: () => {} },
        sessionId: "session-123",
        discordMessage: { edit: () => {} }
      };
      
      expect(channelProcess.sessionId).toBe("session-123");
      expect(typeof channelProcess.process).toBe("object");
    });

    it('should accept channel process without optional sessionId', () => {
      const channelProcess: ChannelProcess = {
        process: { kill: () => {} },
        discordMessage: { edit: () => {} }
      };
      
      expect(channelProcess.sessionId).toBeUndefined();
      expect(typeof channelProcess.process).toBe("object");
    });
  });

  describe('Config', () => {
    it('should accept valid config structure', () => {
      const config: Config = {
        discordToken: "token-123",
        allowedUserId: "user-456",
        baseFolder: "/test/folder"
      };
      
      expect(config.discordToken).toBe("token-123");
      expect(config.allowedUserId).toBe("user-456");
      expect(config.baseFolder).toBe("/test/folder");
    });
  });
});