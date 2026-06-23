export type SDKMessage =
  | { type: "assistant"; message: any; session_id: string }
  | { type: "user"; message: any; session_id: string }
  | {
      type: "result";
      subtype: "success";
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      session_id: string;
      total_cost_usd: number;
    }
  | {
      type: "result";
      subtype: "error_max_turns" | "error_during_execution";
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      session_id: string;
      total_cost_usd: number;
    }
  | {
      type: "system";
      subtype: "init";
      apiKeySource: string;
      cwd: string;
      session_id: string;
      tools: string[];
      mcp_servers: { name: string; status: string }[];
      model: string;
      permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
    };

export type BotRole = "worker" | "manager";

export interface Config {
  discordToken: string;
  allowedUserIds: string[];
  baseFolder: string;
  discordAiTerminalChannelId?: string;
  reviewBotIds: string[];
  /** This instance's role; distinguishes co-running worker/manager instances. */
  botRole: BotRole;
  /** True when this instance answers messages that don't address a specific bot. */
  isDefaultResponder: boolean;
}

export interface ThreadContext {
  threadId: string;
  channelId: string;
  agent: string;
  workDir: string;
  sessionId?: string;
}
