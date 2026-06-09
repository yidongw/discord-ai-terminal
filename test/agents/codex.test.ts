import { describe, it, expect } from 'vitest';
import { codexAgent } from '../../src/agents/codex.js';

describe('codexAgent', () => {
  it('shows the configured Codex model name when thread.started omits it', () => {
    const event = codexAgent.parseLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
      '/test/dir'
    );

    expect(event).toEqual({
      kind: 'init',
      sessionId: 'thread-123',
      model: 'GPT-5.4-Mini',
      cwd: '/test/dir',
    });
  });
});
