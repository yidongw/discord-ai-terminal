import type { AgentEvent, AgentParseContext } from "./index.js";
import { isImageType } from "../utils/attachments.js";
import { parseSdkLine } from "./sdk-parser.js";

/** Cursor stream-json tool_call events (readToolCall, generateImageToolCall, …). */
export function parseCsLine(line: string, workDir: string, ctx?: AgentParseContext): AgentEvent | null {
  const sdk = parseSdkLine(line, workDir, ctx);
  if (sdk) return sdk;

  let msg: any;
  try { msg = JSON.parse(line); } catch { return null; }

  if (msg.type !== "tool_call" || msg.subtype !== "completed") return null;

  const tc = msg.tool_call ?? {};
  const generated = tc.generateImageToolCall?.result?.success?.filePath;
  if (typeof generated === "string" && generated) {
    return { kind: "image_file", filePath: generated };
  }

  const readPath = tc.readToolCall?.args?.path;
  if (typeof readPath === "string" && isImageType(undefined, readPath)) {
    return { kind: "image_file", filePath: readPath };
  }

  return null;
}
