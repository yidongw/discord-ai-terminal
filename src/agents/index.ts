import type { DiscordContext } from "../utils/shell.js";
import type { PermissionMode, ClaudeModel } from "../db/database.js";

export interface AgentRunOptions {
  sessionId?: string;
  mode?: PermissionMode;
  model?: ClaudeModel;
  discordContext?: DiscordContext;
}

export interface AgentRunner {
  readonly key: string;
  readonly label: string;
  readonly color: number;
  buildCommand(workDir: string, prompt: string, opts: AgentRunOptions): string;
}

const registry = new Map<string, AgentRunner>();

export function registerAgent(agent: AgentRunner): void {
  registry.set(agent.key, agent);
}

export function getAgent(key: string): AgentRunner | undefined {
  return registry.get(key.toLowerCase());
}

export function listAgentKeys(): string[] {
  return Array.from(registry.keys());
}

// Register built-in agents on import
import { ccAgent } from "./cc.js";
import { codexAgent } from "./codex.js";

registerAgent(ccAgent);
registerAgent(codexAgent);
