import type { AgentEvent, AgentParseContext } from "./index.js";

// Shared parser for agents that use the Claude SDK stream-json format (cc, cs)
export function parseSdkLine(line: string, workDir: string, ctx?: AgentParseContext): AgentEvent | null {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return null; }

  if (msg.type === "system" && msg.subtype === "init") {
    return {
      kind: "init",
      sessionId: msg.session_id,
      model: msg.model ?? ctx?.requestedModel ?? "unknown",
      cwd: msg.cwd ?? workDir,
    };
  }

  if (msg.type === "assistant") {
    const content = Array.isArray(msg.message?.content)
      ? msg.message.content.find((c: any) => c.type === "text")?.text ?? ""
      : msg.message?.content ?? "";

    const tools: any[] = Array.isArray(msg.message?.content)
      ? msg.message.content.filter((c: any) => c.type === "tool_use")
      : [];

    // Return text first; tools are emitted separately — caller handles multi-event
    // We batch them into an array by returning a special wrapper
    return { kind: "_sdk_assistant" as any, content, tools, sessionId: msg.session_id } as any;
  }

  if (msg.type === "user") {
    const results: any[] = Array.isArray(msg.message?.content)
      ? msg.message.content.filter((c: any) => c.type === "tool_result")
      : [];
    return { kind: "_sdk_tool_results" as any, results } as any;
  }

  if (msg.type === "result") {
    const cost = msg.total_cost_usd ?? null;
    const turns = msg.num_turns ?? null;
    const usage = msg.usage ?? null;
    const tokens = usage
      ? [
          usage.inputTokens != null ? `↑${usage.inputTokens}` : null,
          usage.outputTokens != null ? `↓${usage.outputTokens}` : null,
          usage.cacheReadTokens ? `cache ${usage.cacheReadTokens}` : null,
        ].filter(Boolean).join(" ") || null
      : null;

    if (msg.subtype === "success") return { kind: "done", turns, cost, tokens };
    return { kind: "error", message: msg.subtype ?? "unknown error" };
  }

  return null;
}
