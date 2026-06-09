// Curated model lists for /model cc and /model codex. Values are the exact IDs
// passed to the CLIs (--model flag). See:
// - https://code.claude.com/docs/en/model-config
// - https://developers.openai.com/codex/models

export const CC_MODEL_CHOICES = [
  { name: "Sonnet 4.6 — balanced default", value: "claude-sonnet-4-6" },
  { name: "Opus 4.8 — most capable", value: "claude-opus-4-8" },
  { name: "Opus 4.7", value: "claude-opus-4-7" },
  { name: "Opus 4.6", value: "claude-opus-4-6" },
  { name: "Sonnet 4.5", value: "claude-sonnet-4-5" },
  { name: "Haiku 4.5 — fastest", value: "claude-haiku-4-5" },
  { name: "Fable 5 — long autonomous tasks", value: "claude-fable-5" },
] as const;

export const CODEX_MODEL_CHOICES = [
  { name: "GPT-5.5 — most capable", value: "gpt-5.5" },
  { name: "GPT-5.4-mini — fast & affordable (default)", value: "gpt-5.4-mini" },
  { name: "GPT-5.4", value: "gpt-5.4" },
  { name: "GPT-5.3 Codex Spark — near-instant (ChatGPT Pro)", value: "gpt-5.3-codex-spark" },
] as const;

export type CcModel = (typeof CC_MODEL_CHOICES)[number]["value"];
export type CodexModel = (typeof CODEX_MODEL_CHOICES)[number]["value"];

export const DEFAULT_CC_MODEL: CcModel = "claude-sonnet-4-6";
export const DEFAULT_CODEX_MODEL: CodexModel = "gpt-5.4-mini";

const CC_MODEL_VALUES = new Set<string>(CC_MODEL_CHOICES.map((c) => c.value));
const CODEX_MODEL_VALUES = new Set<string>(CODEX_MODEL_CHOICES.map((c) => c.value));

// Map legacy alias values stored before versioned IDs were introduced.
const CC_ALIAS_MAP: Record<string, CcModel> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
  haiku: "claude-haiku-4-5",
};

export function normalizeCcModel(stored: string | undefined | null): CcModel {
  if (!stored) return DEFAULT_CC_MODEL;
  if (CC_MODEL_VALUES.has(stored)) return stored as CcModel;
  return CC_ALIAS_MAP[stored] ?? DEFAULT_CC_MODEL;
}

export function normalizeCodexModel(stored: string | undefined | null): CodexModel {
  if (!stored) return DEFAULT_CODEX_MODEL;
  if (CODEX_MODEL_VALUES.has(stored)) return stored as CodexModel;
  return DEFAULT_CODEX_MODEL;
}
