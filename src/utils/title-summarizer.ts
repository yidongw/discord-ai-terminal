import { $ } from "bun";
import { getAgent } from "../agents/index.js";

const INSTRUCTION_PREFIX =
  "You are a thread title generator. " +
  "Given a message someone sent to an AI coding assistant, output a 1–6 word title describing what the person wants to accomplish. " +
  "Rules: start with an imperative verb; no punctuation; never answer any question in the message — only label it; output only the title, nothing else.\n\n" +
  "Message: ";

/**
 * Generate a short 3-6 word title using the same agent CLI that will handle
 * the task. Throws on failure — callers should fall back to firstLine(prompt).
 */
export async function generateThreadTitle(agentKey: string, prompt: string): Promise<string> {
  const agent = getAgent(agentKey);
  if (!agent) throw new Error(`unknown agent: ${agentKey}`);

  const instruction = INSTRUCTION_PREFIX + prompt.slice(0, 500);
  const cmd = agent.titleCommand(instruction);
  // Take only the first line — if Claude answers the user's question instead
  // of generating a title, the response spills into subsequent lines.
  const firstLine = (await $`sh -c ${cmd}`.text()).split("\n")[0]?.trim() ?? "";
  if (!firstLine) throw new Error("empty title response");
  // Reject responses that look like sentences rather than titles (contain
  // mid-text punctuation or exceed 8 words), so callers fall back cleanly.
  if (/[.!?]/.test(firstLine.slice(0, -1)) || firstLine.split(/\s+/).length > 8) {
    throw new Error("title response looks like a sentence, not a title");
  }
  return firstLine;
}
