import { describe, it, expect } from 'vitest';
import { codexAgent } from '../../src/agents/codex.js';

describe('codexAgent', () => {
  it('passes the configured codex model into the command', () => {
    const command = codexAgent.buildCommand('/test/dir', 'hello', { codexModel: 'gpt-5.5' });
    expect(command).toContain('--model gpt-5.5');
  });

  it('uses the requested model when thread.started omits it', () => {
    const event = codexAgent.parseLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-123' }),
      '/test/dir',
      { requestedModel: 'gpt-5.4' }
    );

    expect(event).toEqual({
      kind: 'init',
      sessionId: 'thread-123',
      model: 'gpt-5.4',
      cwd: '/test/dir',
    });
  });

  it('uses the model from thread.started events when available', () => {
    const event = codexAgent.parseLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-123', model: 'gpt-5.4-mini' }),
      '/test/dir',
      { requestedModel: 'gpt-5.4' }
    );

    expect(event).toEqual({
      kind: 'init',
      sessionId: 'thread-123',
      model: 'gpt-5.4-mini',
      cwd: '/test/dir',
    });
  });

  it('maps generated image events to saved image files', () => {
    const event = codexAgent.parseLine(
      JSON.stringify({
        type: 'image_generation_end',
        call_id: 'ig_abc123',
        status: 'completed',
      }),
      '/test/dir',
      { sessionId: 'thread-123' }
    );

    expect(event).toEqual({
      kind: 'image_file',
      filePath: `${process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`}/generated_images/thread-123/ig_abc123.png`,
    });
  });

  it('maps generated image results to inline image data', () => {
    const event = codexAgent.parseLine(
      JSON.stringify({
        type: 'image_generation_end',
        call_id: 'ig_abc123',
        status: 'generating',
        result: 'iVBORw0KGgo=',
      }),
      '/test/dir'
    );

    expect(event).toEqual({
      kind: 'image_data',
      data: 'iVBORw0KGgo=',
      mediaType: 'image/png',
      callId: 'ig_abc123',
    });
  });

  it('maps wrapped image generation calls to inline image data', () => {
    const event = codexAgent.parseLine(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'image_generation_call',
          call_id: 'ig_wrapped',
          status: 'generating',
          result: 'iVBORw0KGgo=',
        },
      }),
      '/test/dir'
    );

    expect(event).toEqual({
      kind: 'image_data',
      data: 'iVBORw0KGgo=',
      mediaType: 'image/png',
      callId: 'ig_wrapped',
    });
  });

  it('maps Codex event_msg final answers to text', () => {
    const event = codexAgent.parseLine(
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'Here it is:\n\n![crab](/Users/me/.codex/generated_images/thread-123/ig_crab.png)',
        },
      }),
      '/test/dir'
    );

    expect(event).toEqual({
      kind: 'text',
      content: 'Here it is:\n\n![crab](/Users/me/.codex/generated_images/thread-123/ig_crab.png)',
    });
  });

  it('maps Codex response_item assistant messages to text', () => {
    const event = codexAgent.parseLine(
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Here it is:\n\n![crab](/Users/me/.codex/generated_images/thread-123/ig_crab.png)',
            },
          ],
        },
      }),
      '/test/dir'
    );

    expect(event).toEqual({
      kind: 'text',
      content: 'Here it is:\n\n![crab](/Users/me/.codex/generated_images/thread-123/ig_crab.png)',
    });
  });
});
