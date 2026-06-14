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
] as const;

export const CS_MODEL_CHOICES = [
  { name: "auto — cursor's automatic selection (default)", value: "auto" },
  { name: "Composer 2.5 Fast", value: "composer-2.5-fast" },
  { name: "Composer 2.5", value: "composer-2.5" },
  { name: "Opus 4.8", value: "claude-opus-4-8-high" },
  { name: "GPT-5.5", value: "gpt-5.5-medium" },
  { name: "Sonnet 4.6", value: "claude-4.6-sonnet-medium" },
  { name: "Codex 5.3", value: "gpt-5.3-codex" },
] as const;

export type CcModel = (typeof CC_MODEL_CHOICES)[number]["value"];
export type CodexModel = (typeof CODEX_MODEL_CHOICES)[number]["value"];
export type CsModel = (typeof CS_MODEL_CHOICES)[number]["value"];

export const DEFAULT_CC_MODEL: CcModel = "claude-sonnet-4-6";
export const DEFAULT_CODEX_MODEL: CodexModel = "gpt-5.4-mini";
export const DEFAULT_CS_MODEL: CsModel = "auto";

const CC_MODEL_VALUES = new Set<string>(CC_MODEL_CHOICES.map((c) => c.value));
const CODEX_MODEL_VALUES = new Set<string>(CODEX_MODEL_CHOICES.map((c) => c.value));

// Map legacy alias values stored before versioned IDs were introduced.
const CC_ALIAS_MAP: Record<string, CcModel> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
  haiku: "claude-haiku-4-5",
};

// Short aliases usable as @mention suffixes, e.g. @cco4.8 or @cx5.5
export const CC_MODEL_ALIASES: Record<string, CcModel> = {
  "s4.6": "claude-sonnet-4-6",
  "sonnet4.6": "claude-sonnet-4-6",
  "o4.8": "claude-opus-4-8",
  "opus4.8": "claude-opus-4-8",
  "o4.7": "claude-opus-4-7",
  "opus4.7": "claude-opus-4-7",
  "o4.6": "claude-opus-4-6",
  "opus4.6": "claude-opus-4-6",
  "s4.5": "claude-sonnet-4-5",
  "sonnet4.5": "claude-sonnet-4-5",
  "h4.5": "claude-haiku-4-5",
  "haiku": "claude-haiku-4-5",
  "fable": "claude-fable-5",
};

export const CODEX_MODEL_ALIASES: Record<string, CodexModel> = {
  "5.5": "gpt-5.5",
  "5.4": "gpt-5.4",
  "mini": "gpt-5.4-mini",
  "5.4-mini": "gpt-5.4-mini",
};

export const CS_MODEL_ALIASES: Record<string, CsModel> = {
  "fast": "composer-2.5-fast",
  "2.5fast": "composer-2.5-fast",
  "2.5": "composer-2.5",
};

/**
 * Resolve a model alias suffix (the part after the agent key in an @mention)
 * to the full model value. Returns undefined if the suffix is not recognized.
 */
export function resolveModelAlias(agentKey: string, suffix: string): string | undefined {
  const lower = suffix.toLowerCase();
  switch (agentKey) {
    case "cc": return CC_MODEL_VALUES.has(suffix) ? suffix : CC_MODEL_ALIASES[lower];
    case "cx": return CODEX_MODEL_VALUES.has(suffix) ? suffix : CODEX_MODEL_ALIASES[lower];
    case "cs": return CS_MODEL_VALUES.has(suffix) ? suffix : CS_MODEL_ALIASES[lower];
    default:   return undefined;
  }
}

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

const CS_MODEL_VALUES = new Set<string>(CS_MODEL_CHOICES.map((c) => c.value));

export function normalizeCsModel(stored: string | undefined | null): CsModel {
  if (!stored) return DEFAULT_CS_MODEL;
  if (CS_MODEL_VALUES.has(stored)) return stored as CsModel;
  return DEFAULT_CS_MODEL;
}
