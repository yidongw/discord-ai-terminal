import type { AgentRunner, AgentRunOptions, AgentEvent } from "./index.js";
import { buildClaudeCommand, buildClaudeCommandForGitHub, escapeShellString } from "../utils/shell.js";
import { parseSdkLine } from "./sdk-parser.js";

export const ccAgent: AgentRunner = {
  key: "cc",
  label: "Claude Code",
  color: 0x7289DA,

  buildCommand(workDir, prompt, opts) {
    if (!opts.discordContext) {
      return buildClaudeCommandForGitHub(workDir, prompt, { prNumber: opts.prNumber, model: opts.model });
    }
    return buildClaudeCommand(workDir, prompt, opts.sessionId, opts.discordContext, opts.mode ?? "auto", opts.model ?? "sonnet");
  },

  parseLine(line, workDir) { return parseSdkLine(line, workDir); },

  titleCommand(prompt) {
    return `claude -p ${escapeShellString(prompt)}`;
  },
};
