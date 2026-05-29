import { listAgentKeys } from "../agents/index.js";

export interface ParsedInvocation {
  agent: string;
  prompt: string;
}

/**
 * Parse @agent mentions from a Discord message.
 * Returns one entry per mentioned agent with all other @agent tags stripped from the prompt.
 * If no agents are mentioned, returns an empty array.
 */
export function parseAgentInvocations(content: string): ParsedInvocation[] {
  const knownAgents = new Set(listAgentKeys());
  const mentionPattern = /@([a-zA-Z0-9_-]+)/g;

  const mentionedAgents: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = mentionPattern.exec(content)) !== null) {
    const key = match[1].toLowerCase();
    if (knownAgents.has(key) && !mentionedAgents.includes(key)) {
      mentionedAgents.push(key);
    }
  }

  if (mentionedAgents.length === 0) return [];

  // Strip ALL @agent mentions to build the clean prompt
  const allAgentPattern = new RegExp(
    `@(${Array.from(knownAgents).join("|")})`,
    "gi"
  );
  const cleanPrompt = content.replace(allAgentPattern, "").replace(/\s+/g, " ").trim();

  return mentionedAgents.map((agent) => ({ agent, prompt: cleanPrompt }));
}

/** Build the starter message text for a given agent invocation */
export function starterMessageText(agent: string, prompt: string): string {
  const THREAD_NAME_LIMIT = 100;
  const full = `🌲 **${agent}** — ${prompt}`;
  if (full.length <= THREAD_NAME_LIMIT) return full;
  const maxPrompt = THREAD_NAME_LIMIT - `🌲 **${agent}** — `.length - 1;
  return `🌲 **${agent}** — ${prompt.slice(0, maxPrompt)}…`;
}

/** Build the thread name for a given agent + prompt */
export function threadName(agent: string, prompt: string): string {
  const THREAD_NAME_LIMIT = 100;
  const prefix = `${agent} • `;
  const max = THREAD_NAME_LIMIT - prefix.length;
  const truncated = prompt.length > max ? prompt.slice(0, max - 1) + "…" : prompt;
  return `${prefix}${truncated}`;
}
