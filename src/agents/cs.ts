import type { AgentRunner, AgentRunOptions, AgentEvent } from "./index.js";
import { escapeShellString } from "../utils/shell.js";
import { parseCsLine } from "./cs-parser.js";

export const cursorAgent: AgentRunner = {
  key: "cs",
  label: "Cursor",
  color: 0x00b4d8,

  buildCommand(workDir, prompt, opts) {
    const escaped = escapeShellString(prompt);
    const model = opts.csModel ?? "auto";
    const parts = [
      `cd ${workDir}`,
      "&&",
      "cursor agent",
      "--print",
      "--output-format stream-json",
      "--yolo",
      "--trust",
      "--model", model,
    ];
    if (opts.sessionId) parts.push("--resume", opts.sessionId);
    parts.push(escaped);
    return parts.join(" ");
  },

  parseLine(line, workDir, ctx) { return parseCsLine(line, workDir, ctx); },

  titleCommand(prompt) {
    // ask mode is read-only — title generation must not run tools or return images.
    return `cursor agent --print --mode ask --trust --model auto ${escapeShellString(prompt)}`;
  },
};
