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

  it('maps error_max_turns to session_limit', () => {
    const event = parseSdkLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        num_turns: 25,
        is_error: true,
      }),
      '/test/dir'
    );

    expect(event).toEqual({ kind: 'session_limit', turns: 25 });
  });

  it('maps other result errors to error', () => {
    const event = parseSdkLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
      }),
      '/test/dir'
    );

    expect(event).toEqual({ kind: 'error', message: 'error_during_execution' });
  });

  it('prefers the error detail string over subtype', () => {
    const event = parseSdkLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        error: "You've hit your session limit · resets 3:45pm",
      }),
      '/test/dir'
    );

    expect(event).toEqual({
      kind: 'error',
      message: "You've hit your session limit · resets 3:45pm",
    });
  });
});
