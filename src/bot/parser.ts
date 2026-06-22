import { listAgentKeys } from "../agents/index.js";
import { resolveModelAlias } from "../utils/models.js";
import { stripStatusEmoji } from "../utils/thread-status.js";

/**
 * Check if the message mentions a configured review bot (by Discord ID or username).
 * @param content - The message content
 * @param reviewBotIds - Array of bot IDs or usernames from REVIEW_BOT_IDS env var
 * @returns true if the message mentions a review bot (case-insensitive for usernames)
 */
export function hasReviewBotMention(content: string, reviewBotIds: string[]): boolean {
  if (reviewBotIds.length === 0) return false;

  // Check for Discord user ID mentions like <@123456789> or <@!123456789>
  const discordMentionPattern = /<@!?(\d+)>/g;
  let match: RegExpExecArray | null;
  while ((match = discordMentionPattern.exec(content)) !== null) {
    const mentionedId = match[1]!;
    if (reviewBotIds.includes(mentionedId)) return true;
  }

  // Check for text @username mentions (case-insensitive)
  const lowerBotNames = reviewBotIds.map((id) => id.toLowerCase());
  const textMentionPattern = /@([a-zA-Z0-9_.-]+)/g;
  while ((match = textMentionPattern.exec(content)) !== null) {
    const token = match[1]!.toLowerCase();
    if (lowerBotNames.includes(token)) return true;
  }

  return false;
}

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
  const removeSpans: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(content)) !== null) {
    const token = match[1]!.toLowerCase();
    const mentionStart = match.index;
    let mentionEnd = match.index + match[0].length;

    // Exact agent key match, optionally followed by a space-separated model alias
    // (e.g. @cc 4.8).
    if (knownAgents.has(token)) {
      if (!matched.has(token)) {
        matched.add(token);
        let model: string | undefined;
        const afterMention = content.slice(mentionEnd);
        const spaceModel = /^\s+([a-zA-Z0-9._-]+)/.exec(afterMention);
        if (spaceModel) {
          const resolved = resolveModelAlias(token, spaceModel[1]!);
          if (resolved !== undefined) {
            model = resolved;
            mentionEnd += spaceModel[0].length;
          }
        }
        invocations.push({ agent: token, model });
      }
      removeSpans.push({ start: mentionStart, end: mentionEnd });
      continue;
    }

    // Agent key prefix + model suffix (e.g. "cx5.5" → agent "cx", suffix "5.5")
    for (const key of knownAgents) {
      if (token.startsWith(key) && token.length > key.length) {
        const suffix = token.slice(key.length);
        const model = resolveModelAlias(key, suffix);
        if (model !== undefined) {
          if (!matched.has(key)) {
            matched.add(key);
            invocations.push({ agent: key, model });
          }
          removeSpans.push({ start: mentionStart, end: mentionEnd });
          break;
        }
      }
    }
  }

  if (invocations.length === 0) return [];

  let cleanPrompt = content;
  for (const span of removeSpans.sort((a, b) => b.start - a.start)) {
    cleanPrompt = cleanPrompt.slice(0, span.start) + cleanPrompt.slice(span.end);
  }
  cleanPrompt = cleanPrompt
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
