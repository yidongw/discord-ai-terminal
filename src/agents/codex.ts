import type { AgentRunner, AgentRunOptions } from "./index.js";
import { buildCodexCommand } from "../utils/shell.js";

export const codexAgent: AgentRunner = {
  key: "codex",
  label: "Codex",
  color: 0x4B88FF,

  buildCommand(workDir, prompt, opts) {
    return buildCodexCommand(workDir, prompt, opts.sessionId);
  },
};
