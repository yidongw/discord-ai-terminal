import type { AgentRunner, AgentRunOptions, AgentEvent } from "./index.js";
import { escapeShellString } from "../utils/shell.js";
import { parseSdkLine } from "./sdk-parser.js";

export const cursorAgent: AgentRunner = {
  key: "cs",
  label: "Cursor",
  color: 0x00b4d8,

  buildCommand(workDir, prompt, opts) {
    const escaped = escapeShellString(prompt);
    const parts = [
      `cd ${workDir}`,
      "&&",
      "cursor agent",
      "--print",
      "--output-format stream-json",
      "--yolo",
      "--trust",
      "--model", "auto",
    ];
    if (opts.sessionId) parts.push("--resume", opts.sessionId);
    parts.push(escaped);
    return parts.join(" ");
  },

  parseLine(line, workDir) { return parseSdkLine(line, workDir); },
};
