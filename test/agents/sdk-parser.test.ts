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

  it('maps success+is_error result with limit text to error', () => {
    const event = parseSdkLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: "You've hit your session limit · resets 2:50am (Asia/Bangkok)",
      }),
      '/test/dir'
    );

    expect(event).toEqual({
      kind: 'error',
      message: "You've hit your session limit · resets 2:50am (Asia/Bangkok)",
    });
  });

  it('maps rejected rate_limit_event to rate_limit', () => {
    const now = Date.now();
    const resetsAt = Math.floor((now + 3600_000) / 1000);
    const event = parseSdkLine(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt },
      }),
      '/test/dir'
    );

    expect(event?.kind).toBe('rate_limit');
    if (event?.kind === 'rate_limit') {
      expect(event.resetAt).toBe(resetsAt * 1000);
    }
  });

  it('maps rejected rate_limit_event without reset time to default retry', () => {
    const now = Date.now();
    const event = parseSdkLine(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected' },
      }),
      '/test/dir'
    );

    expect(event?.kind).toBe('rate_limit');
    if (event?.kind === 'rate_limit') {
      expect(event.resetAt).toBeGreaterThanOrEqual(now);
      expect(event.resetAt).toBeLessThanOrEqual(now + 61_000);
    }
  });

  it('maps server rate limit error detail to error', () => {
    const event = parseSdkLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        error: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
      }),
      '/test/dir'
    );

    expect(event).toEqual({
      kind: 'error',
      message: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
      subtype: 'error_during_execution',
    });
  });

  it('ignores allowed rate_limit_event (informational, not a limit hit)', () => {
    const event = parseSdkLine(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', resetsAt: 1781157000 },
      }),
      '/test/dir'
    );

    expect(event).toBeNull();
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
