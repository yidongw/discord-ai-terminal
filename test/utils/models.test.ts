import { describe, it, expect } from 'vitest';
import {
  normalizeCcModel,
  normalizeCodexModel,
  resolveModelAlias,
  resolveEffectiveModel,
  DEFAULT_CC_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CS_MODEL,
} from '../../src/utils/models.js';

describe('normalizeCcModel', () => {
  it('returns the default for missing values', () => {
    expect(normalizeCcModel(null)).toBe(DEFAULT_CC_MODEL);
    expect(normalizeCcModel(undefined)).toBe(DEFAULT_CC_MODEL);
  });

  it('passes through pinned model IDs', () => {
    expect(normalizeCcModel('claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(normalizeCcModel('claude-mythos-5-1')).toBe('claude-mythos-5-1');
    expect(normalizeCcModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeCcModel('claude-fable-5')).toBe('claude-fable-5');
  });

  it('maps legacy aliases to pinned versions', () => {
    expect(normalizeCcModel('sonnet')).toBe('claude-sonnet-4-6');
    expect(normalizeCcModel('opus')).toBe('claude-opus-5-5');
    expect(normalizeCcModel('haiku')).toBe('claude-haiku-4-5');
  });
});

describe('normalizeCodexModel', () => {
  it('returns the default for missing values', () => {
    expect(normalizeCodexModel(null)).toBe(DEFAULT_CODEX_MODEL);
  });

  it('passes through known codex model IDs', () => {
    expect(normalizeCodexModel('gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeCodexModel('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    expect(normalizeCodexModel('gpt-6-astra')).toBe('gpt-6-astra');
    expect(normalizeCodexModel('gpt-6-sol')).toBe('gpt-6-sol');
    expect(normalizeCodexModel('gpt-6-luna')).toBe('gpt-6-luna');
  });

  it('maps retired gpt-5.4 IDs to GPT-5.6 replacements', () => {
    expect(normalizeCodexModel('gpt-5.4-mini')).toBe('gpt-5.6-luna');
    expect(normalizeCodexModel('gpt-5.4')).toBe('gpt-5.6-terra');
  });
});

describe('resolveModelAlias', () => {
  it('resolves the latest Claude aliases', () => {
    expect(resolveModelAlias('cc', 'opus')).toBe('claude-opus-5-5');
    expect(resolveModelAlias('cc', 'o5.5')).toBe('claude-opus-5-5');
    expect(resolveModelAlias('cc', 'mythos')).toBe('claude-mythos-5-1');
  });

  it('distinguishes GPT-6 aliases from pinned GPT-5.6 aliases', () => {
    expect(resolveModelAlias('cx', 'sol')).toBe('gpt-6-sol');
    expect(resolveModelAlias('cx', '5.6sol')).toBe('gpt-5.6-sol');
    expect(resolveModelAlias('cx', 'luna')).toBe('gpt-6-luna');
    expect(resolveModelAlias('cx', '5.6luna')).toBe('gpt-5.6-luna');
  });
});

describe('resolveEffectiveModel', () => {
  const db = {
    getModel: () => 'claude-opus-5-5' as const,
    getCodexModel: () => 'gpt-5.6-luna' as const,
    getCsModel: () => 'auto' as const,
  };

  it('prefers explicit @mention model over thread and channel defaults', () => {
    expect(resolveEffectiveModel(db, 'cc', 'ch-1', {
      explicitModel: 'claude-opus-4-8',
      threadModelOverride: 'claude-haiku-4-5',
    })).toBe('claude-opus-4-8');
  });

  it('uses thread model override when no explicit model is set', () => {
    expect(resolveEffectiveModel(db, 'cx', 'ch-1', {
      threadModelOverride: 'gpt-5.5',
    })).toBe('gpt-5.5');
  });

  it('falls back to channel model when no overrides are set', () => {
    expect(resolveEffectiveModel(db, 'cc', 'ch-1')).toBe(DEFAULT_CC_MODEL);
    expect(resolveEffectiveModel(db, 'cx', 'ch-1')).toBe(DEFAULT_CODEX_MODEL);
    expect(resolveEffectiveModel(db, 'cs', 'ch-1')).toBe(DEFAULT_CS_MODEL);
  });
});
