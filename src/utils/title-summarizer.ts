import { $ } from "bun";
import { getAgent } from "../agents/index.js";

const INSTRUCTION_PREFIX =
  "Summarize this task as a short title (1-6 words, start with an imperative verb, no punctuation). " +
  "Output only the title, nothing else.\n\nTask: ";

/**
 * Generate a short 3-6 word title using the same agent CLI that will handle
 * the task. Throws on failure — callers should fall back to firstLine(prompt).
 */
export async function generateThreadTitle(agentKey: string, prompt: string): Promise<string> {
  const agent = getAgent(agentKey);
  if (!agent) throw new Error(`unknown agent: ${agentKey}`);

  const instruction = INSTRUCTION_PREFIX + prompt.slice(0, 500);
  const cmd = agent.titleCommand(instruction);
  const text = (await $`sh -c ${cmd}`.text()).trim();
  if (!text) throw new Error("empty title response");
  return text;
}
