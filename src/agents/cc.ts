import type { AgentRunner, AgentRunOptions } from "./index.js";
import { buildClaudeCommand } from "../utils/shell.js";

export const ccAgent: AgentRunner = {
  key: "cc",
  label: "Claude Code",
  color: 0x7289DA,

  buildCommand(workDir, prompt, opts) {
    return buildClaudeCommand(
      workDir,
      prompt,
      opts.sessionId,
      opts.discordContext,
      opts.mode ?? "auto",
      opts.model ?? "sonnet"
    );
  },
};
