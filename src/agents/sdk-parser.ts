import type { AgentEvent, AgentParseContext } from "./index.js";
import {
  defaultServerRateLimitRetry,
  parseRateLimitReset,
} from "../utils/session-limit-reset.js";

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

  if (msg.type === "rate_limit_event") {
    // Informational when status is "allowed" — only act on an actual rejection.
    const info = msg.rate_limit_info;
    if (info?.status !== "rejected") return null;
    const parsed = parseRateLimitReset(info);
    if (parsed) return { kind: "rate_limit", resetAt: parsed.resetAt, resetLabel: parsed.resetLabel };
    const fallback = defaultServerRateLimitRetry();
    return { kind: "rate_limit", resetAt: fallback.resetAt, resetLabel: fallback.resetLabel };
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

    if (msg.subtype === "success") {
      // cc reports subscription usage limits as success+is_error with the limit text in result.
      if (msg.is_error) {
        const detail = msg.result ?? msg.error;
        const message = typeof detail === "string" && detail.trim()
          ? detail
          : "unknown error";
        return { kind: "error", message };
      }
      return { kind: "done", turns, cost, tokens };
    }
    if (msg.subtype === "error_max_turns") return { kind: "session_limit", turns };
    const detail = msg.error ?? msg.result;
    const message = typeof detail === "string" && detail.trim()
      ? detail
      : (msg.subtype ?? "unknown error");
    return { kind: "error", message, subtype: msg.subtype };
  }

  return null;
}
