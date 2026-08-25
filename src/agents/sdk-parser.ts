import type { AgentEvent, AgentParseContext } from "./index.js";
import { parseRateLimitReset } from "../utils/session-limit-reset.js";

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
    const info = msg.rate_limit_info;
    if (info?.status === "rejected") {
      const parsed = parseRateLimitReset(info);
      if (parsed) return { kind: "rate_limit", resetAt: parsed.resetAt, resetLabel: parsed.resetLabel };
      return null;
    }
    if (info?.status === "allowed") {
      const rateLimitType = typeof info.rateLimitType === "string" ? info.rateLimitType : null;
      const resetsAt = typeof info.resetsAt === "number" ? info.resetsAt : null;
      if (rateLimitType || resetsAt) {
        return { kind: "usage_info", rateLimitType, resetsAt };
      }
    }
    return null;
  }

  if (msg.type === "result") {
    const cost = msg.total_cost_usd ?? null;
    const turns = msg.num_turns ?? null;

    // modelUsage has camelCase keys + contextWindow per model; prefer over msg.usage (snake_case)
    const modelUsageValues: any[] = msg.modelUsage ? Object.values(msg.modelUsage) : [];
    const mu = modelUsageValues.length > 0 ? modelUsageValues[0] : null;
    const rawUsage = msg.usage ?? null;

    const inputTokens: number | null = mu?.inputTokens ?? rawUsage?.input_tokens ?? null;
    const outputTokens: number | null = mu?.outputTokens ?? rawUsage?.output_tokens ?? null;
    const cacheReadTokens: number | null = mu?.cacheReadInputTokens ?? rawUsage?.cache_read_input_tokens ?? null;
    const cacheCreateTokens: number | null = mu?.cacheCreationInputTokens ?? rawUsage?.cache_creation_input_tokens ?? null;
    const contextWindow: number | null = mu?.contextWindow ?? null;

    const tokens = [
      inputTokens != null ? `↑${inputTokens}` : null,
      outputTokens != null ? `↓${outputTokens}` : null,
      cacheReadTokens ? `cache ${cacheReadTokens}` : null,
    ].filter(Boolean).join(" ") || null;

    const contextUsed = (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheCreateTokens ?? 0);
    const ctxPct = contextWindow && contextUsed > 0
      ? Math.round(contextUsed / contextWindow * 100)
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
      return { kind: "done", turns, cost, tokens, inputTokens, ctxPct };
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
