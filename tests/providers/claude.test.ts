/**
 * ClaudeProvider request shapes and response handling, with the SDK mocked.
 */

import { ClaudeProvider } from '../../src/providers/claude';
import { LLMConfig, TextToQueryError } from '../../src/types';

const mockConstructor = jest.fn();
const mockStream = jest.fn();
const mockBetaStream = jest.fn();
const mockModelsList = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    baseURL: string;
    messages = { stream: (...args: any[]) => mockStream(...args) };
    beta = { messages: { stream: (...args: any[]) => mockBetaStream(...args) } };
    models = { list: (...args: any[]) => mockModelsList(...args) };
    constructor(options: any) {
      mockConstructor(options);
      // Same fallback order as the SDK.
      this.baseURL = options.baseURL ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
    }
  }
  return { __esModule: true, default: MockAnthropic };
});

const DEFAULT_SYSTEM =
  'You are a database query generator. Generate only valid SQL queries based on the provided schema and user request. Return ONLY the query without explanations unless specifically asked.';

function provider(overrides: Partial<LLMConfig> = {}): ClaudeProvider {
  return new ClaudeProvider({ provider: 'claude', apiKey: 'sk-ant-test', ...overrides });
}

function message(content: any[], stopReason: string = 'end_turn', stopDetails: any = null) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: stopDetails,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

const text = (t: string) => ({ type: 'text', text: t, citations: null });
const thinking = () => ({ type: 'thinking', thinking: '', signature: 'sig' });
const fallback = () => ({
  type: 'fallback',
  from: { model: 'claude-opus-5-5' },
  to: { model: 'claude-opus-4-8' },
  trigger: { type: 'refusal', category: 'cyber' },
});

/** Make both stream helpers return a stream whose finalMessage() resolves to `msg`. */
function respondWith(msg: any) {
  const stream = () => ({ finalMessage: () => Promise.resolve(msg) });
  mockStream.mockImplementation(stream);
  mockBetaStream.mockImplementation(stream);
}

function failWith(error: any) {
  const stream = () => ({ finalMessage: () => Promise.reject(error) });
  mockStream.mockImplementation(stream);
  mockBetaStream.mockImplementation(stream);
}

/** Params of the single stream call, from whichever helper was used. */
function sent(): Record<string, any> {
  const calls = [...mockStream.mock.calls, ...mockBetaStream.mock.calls];
  expect(calls).toHaveLength(1);
  return calls[0][0];
}

beforeEach(() => {
  mockConstructor.mockReset();
  mockStream.mockReset();
  mockBetaStream.mockReset();
  mockModelsList.mockReset();
  respondWith(message([text('SELECT 1')]));
});

describe('ClaudeProvider', () => {
  describe('client options', () => {
    it('passes only the API key when nothing else is set', () => {
      provider();
      expect(mockConstructor).toHaveBeenCalledWith({ apiKey: 'sk-ant-test' });
    });

    it('passes baseURL, timeout, maxRetries and defaultHeaders when set', () => {
      provider({
        baseURL: 'https://llm-proxy.internal',
        timeout: 60000,
        maxRetries: 4,
        defaultHeaders: { 'X-Team': 'data' },
      });
      expect(mockConstructor).toHaveBeenCalledWith({
        apiKey: 'sk-ant-test',
        baseURL: 'https://llm-proxy.internal',
        timeout: 60000,
        maxRetries: 4,
        defaultHeaders: { 'X-Team': 'data' },
      });
    });
  });

  describe('model', () => {
    it('defaults to claude-opus-5-5', async () => {
      const p = provider();
      expect(p.getDefaultModel()).toBe('claude-opus-5-5');
      await p.generate('q');
      expect(sent().model).toBe('claude-opus-5-5');
    });

    it('uses the configured model', async () => {
      await provider({ model: 'claude-haiku-5-5' }).generate('q');
      expect(sent().model).toBe('claude-haiku-5-5');
    });
  });

  describe('requests', () => {
    it('streams through the beta API with server-side fallbacks by default', async () => {
      await provider().generateWithSystem('SYS', 'Q');
      expect(mockStream).not.toHaveBeenCalled();
      expect(mockBetaStream).toHaveBeenCalledTimes(1);
      expect(sent()).toEqual({
        model: 'claude-opus-5-5',
        max_tokens: 16000,
        system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'Q' }],
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    });

    it('never sends sampling or thinking parameters', async () => {
      await provider({ temperature: 0.2, reasoningEffort: 'low' }).generate('q');
      const params = sent();
      for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'reasoning_effort']) {
        expect(params).not.toHaveProperty(key);
      }
    });

    it('sends maxTokens as max_tokens', async () => {
      await provider({ maxTokens: 64000 }).generate('q');
      expect(sent().max_tokens).toBe(64000);
    });

    it('uses the non-beta API without fallbacks when fallbacks is false', async () => {
      await provider({ fallbacks: false }).generateWithSystem('SYS', 'Q');
      expect(mockBetaStream).not.toHaveBeenCalled();
      expect(sent()).toEqual({
        model: 'claude-opus-5-5',
        max_tokens: 16000,
        system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'Q' }],
      });
    });

    it('turns fallbacks off when baseURL points to another endpoint', async () => {
      await provider({ baseURL: 'https://llm-proxy.internal/anthropic' }).generate('q');
      expect(mockBetaStream).not.toHaveBeenCalled();
      expect(sent()).not.toHaveProperty('fallbacks');
      expect(sent()).not.toHaveProperty('betas');
    });

    it('turns fallbacks off when ANTHROPIC_BASE_URL points to another endpoint', async () => {
      const saved = process.env.ANTHROPIC_BASE_URL;
      process.env.ANTHROPIC_BASE_URL = 'http://localhost:4000';
      try {
        await provider().generate('q');
      } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_BASE_URL;
        else process.env.ANTHROPIC_BASE_URL = saved;
      }
      expect(mockBetaStream).not.toHaveBeenCalled();
    });

    it('keeps fallbacks on for an explicit api.anthropic.com baseURL', async () => {
      await provider({ baseURL: 'https://api.anthropic.com' }).generate('q');
      expect(mockBetaStream).toHaveBeenCalledTimes(1);
      expect(sent().fallbacks).toBe('default');
    });

    it('sends effort as output_config.effort', async () => {
      await provider({ effort: 'low' }).generate('q');
      expect(sent().output_config).toEqual({ effort: 'low' });

      mockBetaStream.mockClear();
      await provider().generate('q');
      expect(sent()).not.toHaveProperty('output_config');
    });

    it('sends effort on the non-beta API too', async () => {
      await provider({ effort: 'high', fallbacks: false }).generate('q');
      expect(mockStream.mock.calls[0][0].output_config).toEqual({ effort: 'high' });
    });

    it('resends without fallbacks when the API rejects them, and keeps them off', async () => {
      const rejection = Object.assign(
        new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"fallbacks: Extra inputs are not permitted"}}'),
        { status: 400 }
      );
      mockBetaStream.mockImplementation(() => ({ finalMessage: () => Promise.reject(rejection) }));
      const p = provider();

      await expect(p.generateWithSystem('SYS', 'Q')).resolves.toBe('SELECT 1');
      expect(mockBetaStream).toHaveBeenCalledTimes(1);
      expect(mockStream).toHaveBeenCalledTimes(1);
      expect(mockStream.mock.calls[0][0]).toEqual({
        model: 'claude-opus-5-5',
        max_tokens: 16000,
        system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: 'Q' }],
      });

      await p.generate('Q2');
      expect(mockBetaStream).toHaveBeenCalledTimes(1);
      expect(mockStream).toHaveBeenCalledTimes(2);
    });

    it('does not resend for other errors', async () => {
      const badRequest = Object.assign(new Error('400 messages: text content blocks must be non-empty'), { status: 400 });
      mockBetaStream.mockImplementation(() => ({ finalMessage: () => Promise.reject(badRequest) }));
      await expect(provider().generate('q')).rejects.toMatchObject({ code: 'CLAUDE_API_ERROR', details: badRequest });

      const overloaded = Object.assign(new Error('529 overloaded (fallback unavailable)'), { status: 529 });
      mockBetaStream.mockImplementation(() => ({ finalMessage: () => Promise.reject(overloaded) }));
      await expect(provider().generate('q')).rejects.toMatchObject({ code: 'CLAUDE_API_ERROR', details: overloaded });

      expect(mockStream).not.toHaveBeenCalled();
    });

    it('sends the system prompt as a plain string when promptCaching is false', async () => {
      await provider({ promptCaching: false }).generateWithSystem('SYS', 'Q');
      expect(sent().system).toBe('SYS');
    });
  });

  describe('max_tokens above the model output limit', () => {
    /** The API's 400 for a max_tokens above what the model can write, as the SDK reports it. */
    function tooLarge(requested: number, cap: number) {
      const body = {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `max_tokens: ${requested} > ${cap}, which is the maximum allowed number of output tokens for claude-3-5-haiku-20241022`,
        },
      };
      return Object.assign(new Error(`400 ${JSON.stringify(body)}`), { status: 400, error: body });
    }

    /** Both stream helpers answer like a model that writes at most `cap` tokens. */
    function modelWithCap(cap: number) {
      const stream = (params: any) => ({
        finalMessage: () =>
          params.max_tokens > cap ? Promise.reject(tooLarge(params.max_tokens, cap)) : Promise.resolve(message([text('SELECT 1')])),
      });
      mockStream.mockImplementation(stream);
      mockBetaStream.mockImplementation(stream);
    }

    const limits = (mock: jest.Mock) => mock.mock.calls.map((call) => call[0].max_tokens);

    it('retries once at the limit the API reports, with fallbacks, and remembers it', async () => {
      modelWithCap(8192);
      const p = provider({ model: 'claude-3-5-haiku-20241022' });

      await expect(p.generate('q')).resolves.toBe('SELECT 1');
      expect(limits(mockBetaStream)).toEqual([16000, 8192]);
      expect(mockBetaStream.mock.calls[1][0].fallbacks).toBe('default');

      // Later requests start at the limit, without a failed attempt first.
      await p.generateWithSystem('SYS', 'Q');
      expect(limits(mockBetaStream)).toEqual([16000, 8192, 8192]);
      expect(mockStream).not.toHaveBeenCalled();
    });

    it('retries on the non-beta API too, and lowers an explicit maxTokens', async () => {
      modelWithCap(4096);
      await expect(provider({ fallbacks: false, maxTokens: 64000 }).generate('q')).resolves.toBe('SELECT 1');
      expect(limits(mockStream)).toEqual([64000, 4096]);
    });

    it('lowers the limit at most once', async () => {
      const stream = (params: any) => ({ finalMessage: () => Promise.reject(tooLarge(params.max_tokens, params.max_tokens - 1)) });
      mockBetaStream.mockImplementation(stream);
      const error = await provider().generate('q').catch((e) => e);
      expect(error).toBeInstanceOf(TextToQueryError);
      expect(error.code).toBe('CLAUDE_API_ERROR');
      expect(limits(mockBetaStream)).toEqual([16000, 15999]);
    });

    it('does not retry when the reported limit is not below the one sent, or the status is not 400', async () => {
      failWith(tooLarge(16000, 16000));
      await expect(provider().generate('q')).rejects.toMatchObject({ code: 'CLAUDE_API_ERROR' });
      expect(mockBetaStream).toHaveBeenCalledTimes(1);

      mockBetaStream.mockClear();
      failWith(Object.assign(tooLarge(16000, 8192), { status: 500 }));
      await expect(provider().generate('q')).rejects.toMatchObject({ code: 'CLAUDE_API_ERROR' });
      expect(mockBetaStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('generate and generateWithSystem', () => {
    it('generate sends the 0.0.1 system prompt', async () => {
      await provider({ promptCaching: false }).generate('Count users');
      expect(sent().system).toBe(DEFAULT_SYSTEM);
      expect(sent().messages).toEqual([{ role: 'user', content: 'Count users' }]);
    });

    it('generateWithSystem sends the given system prompt separately', async () => {
      await expect(provider().generateWithSystem('SCHEMA AND RULES', 'Count users')).resolves.toBe('SELECT 1');
      expect(sent().system).toEqual([
        { type: 'text', text: 'SCHEMA AND RULES', cache_control: { type: 'ephemeral' } },
      ]);
      expect(sent().messages).toEqual([{ role: 'user', content: 'Count users' }]);
    });

    it('generateWithSystem goes through generate() when it is overridden', async () => {
      const p = provider();
      const stub = jest.fn().mockResolvedValue('SELECT stub');
      p.generate = stub;
      await expect(p.generateWithSystem('SYS', 'Q')).resolves.toBe('SELECT stub');
      expect(stub).toHaveBeenCalledWith('SYS\n\nQ');
      expect(mockBetaStream).not.toHaveBeenCalled();
    });

    it('a subclass calling super.generate() does not recurse', async () => {
      class Wrapped extends ClaudeProvider {
        async generate(prompt: string): Promise<string> {
          return `-- wrapped\n${await super.generate(prompt)}`;
        }
      }
      const p = new Wrapped({ provider: 'claude', apiKey: 'k' });
      await expect(p.generateWithSystem('SYS', 'Q')).resolves.toBe('-- wrapped\nSELECT 1');
      expect(mockBetaStream).toHaveBeenCalledTimes(1);
    });
  });

  describe('responses', () => {
    it('joins every text block and skips thinking and fallback blocks', async () => {
      respondWith(message([thinking(), text('SELECT id'), fallback(), text(' FROM users\n')]));
      await expect(provider().generate('q')).resolves.toBe('SELECT id FROM users');
    });

    it('does not assume the first block is text', async () => {
      respondWith(message([thinking(), text('SELECT 42')]));
      await expect(provider({ fallbacks: false }).generate('q')).resolves.toBe('SELECT 42');
    });

    it('reports a refusal with its stop details, ignoring partial text', async () => {
      const stopDetails = { type: 'refusal', category: 'cyber', explanation: 'Declined by policy' };
      respondWith(message([text('SELECT')], 'refusal', stopDetails));
      const error = await provider().generate('q').catch((e) => e);
      expect(error).toBeInstanceOf(TextToQueryError);
      expect(error.code).toBe('CLAUDE_INVALID_RESPONSE');
      expect(error.details).toEqual({ stopReason: 'refusal', stopDetails });
      expect(error.message).toContain('cyber');
    });

    it('reports a refusal without stop details', async () => {
      respondWith(message([], 'refusal', null));
      const error = await provider().generate('q').catch((e) => e);
      expect(error.code).toBe('CLAUDE_INVALID_RESPONSE');
      expect(error.details).toEqual({ stopReason: 'refusal', stopDetails: null });
    });

    it('reports max_tokens without text with a helpful message', async () => {
      respondWith(message([thinking()], 'max_tokens'));
      const error = await provider({ maxTokens: 2000 }).generate('q').catch((e) => e);
      expect(error.code).toBe('CLAUDE_INVALID_RESPONSE');
      expect(error.details).toEqual({ stopReason: 'max_tokens' });
      expect(error.message).toContain('2000');
      expect(error.message).toContain('maxTokens');
      expect(error.message).toContain('effort');
    });

    it('rejects text cut off by max_tokens, with the partial text', async () => {
      respondWith(message([thinking(), text('SELECT id, total'), text(' FROM orders\n')], 'max_tokens'));
      const error = await provider({ maxTokens: 2000 }).generate('q').catch((e) => e);
      expect(error).toBeInstanceOf(TextToQueryError);
      expect(error.code).toBe('CLAUDE_INVALID_RESPONSE');
      expect(error.details).toEqual({ stopReason: 'max_tokens', partialText: 'SELECT id, total FROM orders' });
      expect(error.message).toContain('2000');
      expect(error.message).toContain('maxTokens');
    });

    it('rejects text cut off by the context window, with the partial text', async () => {
      respondWith(message([text('SELECT id FROM')], 'model_context_window_exceeded'));
      const error = await provider().generate('q').catch((e) => e);
      expect(error.code).toBe('CLAUDE_INVALID_RESPONSE');
      expect(error.details).toEqual({ stopReason: 'model_context_window_exceeded', partialText: 'SELECT id FROM' });
      expect(error.message).toContain('context window');

      respondWith(message([thinking()], 'model_context_window_exceeded'));
      const empty = await provider().generate('q').catch((e) => e);
      expect(empty.code).toBe('CLAUDE_INVALID_RESPONSE');
      expect(empty.details).toEqual({ stopReason: 'model_context_window_exceeded' });
      expect(empty.message).toContain('context window');
    });

    it('reports a response without text as CLAUDE_INVALID_RESPONSE', async () => {
      respondWith(message([thinking()]));
      const error = await provider().generate('q').catch((e) => e);
      expect(error.code).toBe('CLAUDE_INVALID_RESPONSE');
      expect(error.message).toBe('Unexpected response type from Claude');
      expect(error.details).toEqual({ stopReason: 'end_turn' });

      respondWith(message([text('   ')]));
      await expect(provider().generate('q')).rejects.toMatchObject({ code: 'CLAUDE_INVALID_RESPONSE' });

      respondWith(message([]));
      await expect(provider().generate('q')).rejects.toMatchObject({ code: 'CLAUDE_INVALID_RESPONSE' });
    });

    it('maps API errors to CLAUDE_API_ERROR with the original error', async () => {
      const apiError = Object.assign(new Error('401 invalid x-api-key'), { status: 401 });
      failWith(apiError);
      const error = await provider().generate('q').catch((e) => e);
      expect(error).toBeInstanceOf(TextToQueryError);
      expect(error.code).toBe('CLAUDE_API_ERROR');
      expect(error.message).toBe('Claude API error: 401 invalid x-api-key');
      expect(error.details).toBe(apiError);
    });

    it('maps errors thrown while starting the stream to CLAUDE_API_ERROR', async () => {
      mockBetaStream.mockImplementation(() => {
        throw new Error('boom');
      });
      await expect(provider().generate('q')).rejects.toMatchObject({
        code: 'CLAUDE_API_ERROR',
        message: 'Claude API error: boom',
      });
    });
  });

  describe('validateApiKey', () => {
    it('lists one model and returns true', async () => {
      mockModelsList.mockResolvedValue({ data: [] });
      await expect(provider().validateApiKey()).resolves.toBe(true);
      expect(mockModelsList).toHaveBeenCalledWith({ limit: 1 });
      expect(mockStream).not.toHaveBeenCalled();
      expect(mockBetaStream).not.toHaveBeenCalled();
    });

    it('returns false on any error', async () => {
      mockModelsList.mockRejectedValue(new Error('401'));
      await expect(provider().validateApiKey()).resolves.toBe(false);
    });
  });
});
