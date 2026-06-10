import { describe, it, expect } from 'vitest';
import { parseSdkLine } from '../../src/agents/sdk-parser.js';

describe('parseSdkLine', () => {
  it('falls back to the requested model when init omits it', () => {
    const event = parseSdkLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        cwd: '/test/dir',
      }),
      '/test/dir',
      { requestedModel: 'claude-opus-4-8' }
    );

    expect(event).toEqual({
      kind: 'init',
      sessionId: 'sess-1',
      model: 'claude-opus-4-8',
      cwd: '/test/dir',
    });
  });
});
