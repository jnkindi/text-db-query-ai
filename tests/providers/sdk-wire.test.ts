/**
 * The providers against the real SDKs, with global fetch stubbed: checks the
 * HTTP requests the SDKs build from our params and how the SDKs' streaming,
 * errors and response parsing reach the providers. No network access.
 */

import { ClaudeProvider } from '../../src/providers/claude';
import { OpenAIProvider } from '../../src/providers/openai';
import { TextToQueryError } from '../../src/types';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

let requests: CapturedRequest[] = [];
let respond: (request: CapturedRequest) => Response;
const realFetch = globalThis.fetch;

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const request: CapturedRequest = {
      url: String(url),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sse(events: any[]): Response {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A streamed Claude response built from content blocks. */
function claudeStream(blocks: any[], stopReason = 'end_turn', stopDetails: any = null): Response {
  const events: any[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      events.push({ type: 'content_block_start', index, content_block: block });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails },
    usage: { output_tokens: 7 },
  });
  events.push({ type: 'message_stop' });
  return sse(events);
}

describe('ClaudeProvider with @anthropic-ai/sdk', () => {
  // An explicit official baseURL keeps the test independent of ANTHROPIC_BASE_URL.
  const config = { provider: 'claude' as const, apiKey: 'sk-ant-test', baseURL: 'https://api.anthropic.com', maxRetries: 0 };

  it('streams a beta request with fallbacks and reads text past thinking and fallback blocks', async () => {
    respond = () =>
      claudeStream([
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: 'SELECT id ' },
        { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' }, trigger: { type: 'refusal', category: 'cyber' } },
        { type: 'text', text: 'FROM users' },
      ]);

    const result = await new ClaudeProvider({ ...config, effort: 'low' }).generateWithSystem('SYS', 'Q');

    expect(result).toBe('SELECT id FROM users');
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(request.body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Q' }],
      output_config: { effort: 'low' },
      fallbacks: 'default',
      stream: true,
    });
  });

  it('streams a plain request when fallbacks are off', async () => {
    respond = () => claudeStream([{ type: 'text', text: 'SELECT 1' }]);

    await expect(new ClaudeProvider({ ...config, fallbacks: false }).generate('Q')).resolves.toBe('SELECT 1');

    const [request] = requests;
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers['anthropic-beta']).toBeUndefined();
    expect(request.body).not.toHaveProperty('fallbacks');
    expect(request.body.stream).toBe(true);
  });

  it('resends without fallbacks when the API rejects the beta header', async () => {
    respond = (request) =>
      request.headers['anthropic-beta']
        ? json(400, {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Unexpected value(s) `server-side-fallback-2026-07-01` for the `anthropic-beta` header.',
            },
          })
        : claudeStream([{ type: 'text', text: 'SELECT 1' }]);

    const provider = new ClaudeProvider(config);
    await expect(provider.generate('Q')).resolves.toBe('SELECT 1');
    expect(requests.map((r) => r.headers['anthropic-beta'])).toEqual(['server-side-fallback-2026-07-01', undefined]);
    expect(requests[1].body).not.toHaveProperty('fallbacks');

    await provider.generate('Q');
    expect(requests).toHaveLength(3);
    expect(requests[2].headers['anthropic-beta']).toBeUndefined();
  });

  it('accepts a max_tokens above the SDK non-streaming limit', async () => {
    respond = () => claudeStream([{ type: 'text', text: 'SELECT 1' }]);
    await expect(new ClaudeProvider({ ...config, maxTokens: 128000 }).generate('Q')).resolves.toBe('SELECT 1');
    expect(requests[0].body.max_tokens).toBe(128000);
  });

  it('reports a streamed refusal', async () => {
    const stopDetails = { type: 'refusal', category: 'bio', explanation: null };
    respond = () => claudeStream([{ type: 'text', text: 'SEL' }], 'refusal', stopDetails);

    const error = await new ClaudeProvider(config).generate('Q').catch((e) => e);
    expect(error.code).toBe('CLAUDE_INVALID_RESPONSE');
    expect(error.details).toEqual({ stopReason: 'refusal', stopDetails });
  });

  it('maps an HTTP error to CLAUDE_API_ERROR carrying the SDK error', async () => {
    respond = () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const { AuthenticationError } = require('@anthropic-ai/sdk');

    const error = await new ClaudeProvider(config).generate('Q').catch((e) => e);
    expect(error).toBeInstanceOf(TextToQueryError);
    expect(error.code).toBe('CLAUDE_API_ERROR');
    expect(error.details).toBeInstanceOf(AuthenticationError);
  });

  it('validateApiKey lists one model', async () => {
    respond = () => json(200, { data: [], has_more: false, first_id: null, last_id: null });
    await expect(new ClaudeProvider(config).validateApiKey()).resolves.toBe(true);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe('https://api.anthropic.com/v1/models?limit=1');

    respond = () => json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    await expect(new ClaudeProvider(config).validateApiKey()).resolves.toBe(false);
  });
});

describe('OpenAIProvider with openai', () => {
  const config = { provider: 'openai' as const, apiKey: 'sk-test', baseURL: 'https://api.openai.com/v1', maxRetries: 0 };

  const completion = (content: string) =>
    json(200, {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-6-luna',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }],
    });

  it('sends max_completion_tokens to the default model', async () => {
    respond = () => completion('SELECT 1');
    await expect(new OpenAIProvider(config).generateWithSystem('SYS', 'Q')).resolves.toBe('SELECT 1');

    const [request] = requests;
    expect(request.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(request.body).toEqual({
      model: 'gpt-6-luna',
      messages: [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'Q' },
      ],
      max_completion_tokens: 8192,
    });
  });

  it('retries without a parameter the API reports as unsupported', async () => {
    respond = (request) =>
      'temperature' in request.body
        ? json(400, {
            error: {
              message: "Unsupported parameter: 'temperature' is not supported with this model.",
              type: 'invalid_request_error',
              param: 'temperature',
              code: 'unsupported_parameter',
            },
          })
        : completion('SELECT 2');

    const provider = new OpenAIProvider({ ...config, model: 'gpt-4o-mini' });
    await expect(provider.generate('Q')).resolves.toBe('SELECT 2');
    expect(requests.map((r) => 'temperature' in r.body)).toEqual([true, false]);

    await provider.generate('Q');
    expect(requests).toHaveLength(3);
    expect(requests[2].body).not.toHaveProperty('temperature');
  });

  it('maps an HTTP error to OPENAI_API_ERROR carrying the SDK error', async () => {
    respond = () => json(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } });
    const { AuthenticationError } = require('openai');

    const error = await new OpenAIProvider(config).generate('Q').catch((e) => e);
    expect(error.code).toBe('OPENAI_API_ERROR');
    expect(error.message).toBe('OpenAI API error: 401 Incorrect API key provided');
    expect(error.details).toBeInstanceOf(AuthenticationError);
  });
});
