import { describe, it, expect } from 'vitest';
import {
  normalizeCcModel,
  normalizeCodexModel,
  DEFAULT_CC_MODEL,
  DEFAULT_CODEX_MODEL,
} from '../../src/utils/models.js';

describe('normalizeCcModel', () => {
  it('returns the default for missing values', () => {
    expect(normalizeCcModel(null)).toBe(DEFAULT_CC_MODEL);
    expect(normalizeCcModel(undefined)).toBe(DEFAULT_CC_MODEL);
  });

  it('passes through pinned model IDs', () => {
    expect(normalizeCcModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeCcModel('claude-fable-5')).toBe('claude-fable-5');
  });

  it('maps legacy aliases to pinned versions', () => {
    expect(normalizeCcModel('sonnet')).toBe('claude-sonnet-4-6');
    expect(normalizeCcModel('opus')).toBe('claude-opus-4-8');
    expect(normalizeCcModel('haiku')).toBe('claude-haiku-4-5');
  });
});

describe('normalizeCodexModel', () => {
  it('returns the default for missing values', () => {
    expect(normalizeCodexModel(null)).toBe(DEFAULT_CODEX_MODEL);
  });

  it('passes through known codex model IDs', () => {
    expect(normalizeCodexModel('gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeCodexModel('gpt-5.3-codex-spark')).toBe('gpt-5.3-codex-spark');
  });
});
