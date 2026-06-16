import { describe, it, expect } from 'vitest';
import {
  normalizeCcModel,
  normalizeCodexModel,
  resolveEffectiveModel,
  resolveResumeSessionId,
  DEFAULT_CC_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CS_MODEL,
} from '../../src/utils/models.js';
import { buildClaudeCommand } from '../../src/utils/shell.js';

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
    expect(normalizeCodexModel('gpt-5.4')).toBe('gpt-5.4');
  });
});

describe('resolveEffectiveModel', () => {
  const db = {
    getModel: () => 'claude-sonnet-4-6' as const,
    getCodexModel: () => 'gpt-5.4-mini' as const,
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

describe('resolveResumeSessionId', () => {
  it('resumes when the agent and model are unchanged', () => {
    expect(resolveResumeSessionId({
      agent: 'cc',
      sessionId: 'sess-1',
      lastRunModel: 'claude-sonnet-4-6',
    }, 'cc', 'claude-sonnet-4-6')).toBe('sess-1');
  });

  it('does not resume when the requested model changed', () => {
    expect(resolveResumeSessionId({
      agent: 'cc',
      sessionId: 'sess-1',
      lastRunModel: 'claude-sonnet-4-6',
    }, 'cc', 'claude-opus-4-7')).toBeUndefined();
  });

  it('does not resume when the session was cleared after /model', () => {
    expect(resolveResumeSessionId({
      agent: 'cc',
      sessionId: undefined,
      lastRunModel: 'claude-sonnet-4-6',
    }, 'cc', 'claude-opus-4-7')).toBeUndefined();
  });

  it('starts fresh when there is no prior session', () => {
    expect(resolveResumeSessionId(null, 'cc', 'claude-opus-4-7')).toBeUndefined();
  });
});

describe('model switch command', () => {
  it('starts a fresh claude session when the model changes', () => {
    const session = {
      agent: 'cc',
      sessionId: 'sess-1',
      lastRunModel: 'claude-sonnet-4-6',
    };
    const requestedModel = 'claude-opus-4-7';
    const resumeSessionId = resolveResumeSessionId(session, 'cc', requestedModel);
    const command = buildClaudeCommand('/repo', 'hello', resumeSessionId, undefined, 'auto', requestedModel);
    expect(resumeSessionId).toBeUndefined();
    expect(command).toContain('--model claude-opus-4-7');
    expect(command).not.toContain('--resume');
  });
});
