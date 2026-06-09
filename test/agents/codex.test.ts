import { describe, it, expect } from 'vitest';
import { codexAgent } from '../../src/agents/codex.js';

describe('codexAgent', () => {
  it('uses the model from thread.started events when available', () => {
    const event = codexAgent.parseLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-123', model: 'gpt-5.4-mini' }),
      '/test/dir'
    );

    expect(event).toEqual({
      kind: 'init',
      sessionId: 'thread-123',
      model: 'gpt-5.4-mini',
      cwd: '/test/dir',
    });
  });
});
