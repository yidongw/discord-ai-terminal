import type { DiscordContext } from "../utils/shell.js";
import type { PermissionMode, ClaudeModel, CodexModel, CsModel } from "../db/database.js";

export interface AgentRunOptions {
  sessionId?: string;
  mode?: PermissionMode;
  model?: ClaudeModel;
  codexModel?: CodexModel;
  csModel?: CsModel;
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
  | { kind: "session_limit"; turns: number | null }
  | { kind: "rate_limit";  resetAt: number; resetLabel: string }
  | { kind: "error";      message: string; subtype?: string }
  | { kind: "image_file"; filePath: string }
  | { kind: "image_data"; data: string; mediaType: string; callId?: string };

export interface AgentParseContext {
  // Model we passed on the CLI for this run — used when the agent's init event
  // omits or misreports it (Codex thread.started often has no model field).
  requestedModel?: string;
  // Agent session/thread id for the current run. Codex image generation events
  // only expose the image call id, while the saved file lives under this id.
  sessionId?: string;
}

export interface AgentRunner {
  readonly key: string;
  readonly label: string;
  readonly color: number;
  buildCommand(workDir: string, prompt: string, opts: AgentRunOptions): string;
  parseLine(line: string, workDir: string, ctx?: AgentParseContext): AgentEvent | null;
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
