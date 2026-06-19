import { listAgentKeys } from "../agents/index.js";
import { resolveModelAlias } from "../utils/models.js";
import { stripStatusEmoji } from "../utils/thread-status.js";

/** True when the message contains any @ token (Discord ping or text @foo). */
export function hasAnyMention(content: string): boolean {
  if (/<@[!&]?\d+>/.test(content)) return true;
  if (/<#\d+>/.test(content)) return true;
  return /@\S/.test(content);
}

export interface ParsedInvocation {
  agent: string;
  prompt: string;
  /** Model override from @mention suffix (e.g. @cx5.5 → "gpt-5.5"). Undefined means use channel default. */
  model?: string;
}

/**
 * Parse @agent mentions from a Discord message.
 * Returns one entry per mentioned agent with all other @agent tags stripped from the prompt.
 * Supports optional model suffix: @cx5.5 selects agent "cx" with model "gpt-5.5".
 * If no agents are mentioned, returns an empty array.
 */
export function parseAgentInvocations(content: string): ParsedInvocation[] {
  const knownAgents = new Set(listAgentKeys());
  // Include '.' so versions like @cx5.5 are captured in one token
  const mentionPattern = /@([a-zA-Z0-9_.-]+)/g;

  const invocations: Array<{ agent: string; model?: string }> = [];
  const matched = new Set<string>(); // deduplicate by agent key
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(content)) !== null) {
    const token = match[1]!.toLowerCase();

    // Exact agent key match
    if (knownAgents.has(token) && !matched.has(token)) {
      matched.add(token);
      invocations.push({ agent: token });
      continue;
    }

    // Agent key prefix + model suffix (e.g. "cx5.5" → agent "cx", suffix "5.5")
    for (const key of knownAgents) {
      if (!matched.has(key) && token.startsWith(key) && token.length > key.length) {
        const suffix = token.slice(key.length);
        const model = resolveModelAlias(key, suffix);
        if (model !== undefined) {
          matched.add(key);
          invocations.push({ agent: key, model });
          break;
        }
      }
    }
  }

  if (invocations.length === 0) return [];

  // Strip ALL @agent mentions (with any trailing model suffix) to build the
  // clean prompt. Collapse only horizontal whitespace; preserve newlines.
  const allAgentPattern = new RegExp(
    `@(${Array.from(knownAgents).join("|")})[a-zA-Z0-9._-]*`,
    "gi"
  );
  const cleanPrompt = content
    .replace(allAgentPattern, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();

  return invocations.map(({ agent, model }) => ({ agent, prompt: cleanPrompt, model }));
}

/** Agent key from a bot-created thread name, e.g. "🔄 cs • Fix login" → "cs". */
export function parseAgentFromThreadName(name: string): string | null {
  const stripped = stripStatusEmoji(name);
  const match = /^([a-z]+)\s*•/.exec(stripped);
  if (!match) return null;
  const key = match[1]!.toLowerCase();
  return listAgentKeys().includes(key) ? key : null;
}

/** Title slug from a bot-created thread name, e.g. "cs • Fix login" → "Fix login". */
export function titleFromThreadName(name: string): string | null {
  const stripped = stripStatusEmoji(name);
  const match = /^[a-z]+\s*•\s*(.+)$/i.exec(stripped);
  return match ? match[1]!.trim() : null;
}

/** The first line of a message (text before the first newline), trimmed. */
export function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return (idx === -1 ? text : text.slice(0, idx)).trim();
}

/** Build the starter message text for a given agent invocation */
export function starterMessageText(agent: string, prompt: string): string {
  const THREAD_NAME_LIMIT = 100;
  const line = firstLine(prompt);
  const full = `🌲 **${agent}** — ${line}`;
  if (full.length <= THREAD_NAME_LIMIT) return full;
  const maxPrompt = THREAD_NAME_LIMIT - `🌲 **${agent}** — `.length - 1;
  return `🌲 **${agent}** — ${line.slice(0, maxPrompt)}…`;
}

/** Build the thread name for a given agent + pre-computed title label. */
export function threadName(agent: string, title: string): string {
  const THREAD_NAME_LIMIT = 100;
  const prefix = `${agent} • `;
  const max = THREAD_NAME_LIMIT - prefix.length;
  const truncated = title.length > max ? title.slice(0, max - 1) + "…" : title;
  return `${prefix}${truncated}`;
}
