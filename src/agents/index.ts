import type { DiscordContext } from "../utils/shell.js";
import type { PermissionMode, ClaudeModel } from "../db/database.js";

export interface AgentRunOptions {
  sessionId?: string;
  mode?: PermissionMode;
  model?: ClaudeModel;
  discordContext?: DiscordContext;
  // Set for GitHub fix runs — CC uses --from-pr instead of --resume
  prNumber?: number;
}

// Normalized events that session-manager handles regardless of agent
export type AgentEvent =
  | { kind: "init";       sessionId: string; model: string; cwd: string }
  | { kind: "text";       content: string }
  | { kind: "tool_start"; id: string; label: string; name?: string }
  | { kind: "tool_done";  id: string; preview: string; isError: boolean }
  | { kind: "done";       turns: number | null; cost: number | null; tokens: string | null }
  | { kind: "error";      message: string };

export interface AgentRunner {
  readonly key: string;
  readonly label: string;
  readonly color: number;
  buildCommand(workDir: string, prompt: string, opts: AgentRunOptions): string;
  parseLine(line: string, workDir: string): AgentEvent | null;
  /** Shell command that runs the agent in one-shot mode and prints plain text to stdout. */
  titleCommand(prompt: string): string;
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
import { cursorAgent } from "./cs.js";

registerAgent(ccAgent);
registerAgent(codexAgent);
registerAgent(cursorAgent);
