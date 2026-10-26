/**
 * OpenAIProvider request shapes and response handling, with the SDK mocked.
 */

import { OpenAIProvider } from '../../src/providers/openai';
import { LLMConfig, TextToQueryError } from '../../src/types';

const mockConstructor = jest.fn();
const mockCreate = jest.fn();
const mockModelsList = jest.fn();

jest.mock('openai', () => {
  class MockOpenAI {
    baseURL: string;
    chat = { completions: { create: (...args: any[]) => mockCreate(...args) } };
    models = { list: (...args: any[]) => mockModelsList(...args) };
    constructor(options: any) {
      mockConstructor(options);
      // Same fallback order as the SDK.
      this.baseURL = options.baseURL ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    }
  }
  return { __esModule: true, default: MockOpenAI };
});

const DEFAULT_SYSTEM =
  'You are a database query generator. Generate only valid SQL queries based on the provided schema and user request. Return ONLY the query without explanations unless specifically asked.';

function provider(overrides: Partial<LLMConfig> = {}): OpenAIProvider {
  return new OpenAIProvider({ provider: 'openai', apiKey: 'sk-test', ...overrides });
}

function completion(content: string | null, extra: { refusal?: string | null; finish_reason?: string } = {}) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        finish_reason: extra.finish_reason ?? 'stop',
        message: { role: 'assistant', content, refusal: extra.refusal ?? null },
      },
    ],
  };
}

/** Shaped like the SDK's BadRequestError: status, code, param, and a "400 ..." message. */
function badRequest(message: string, code?: string | null, param?: string | null) {
  return Object.assign(new Error(`400 ${message}`), { status: 400, code, param });
}

/** Request params of the n-th create() call. */
function sent(n = 0): Record<string, any> {
  return mockCreate.mock.calls[n][0];
}

beforeEach(() => {
  mockConstructor.mockReset();
  mockCreate.mockReset();
  mockModelsList.mockReset();
  mockCreate.mockResolvedValue(completion('SELECT 1'));
});

describe('OpenAIProvider', () => {
  describe('client options', () => {
    it('passes only the API key when nothing else is set', () => {
      provider();
      expect(mockConstructor).toHaveBeenCalledWith({ apiKey: 'sk-test' });
    });

    it('passes baseURL, timeout, maxRetries and defaultHeaders when set', () => {
      provider({
        baseURL: 'https://gateway.example.com/v1',
        timeout: 30000,
        maxRetries: 5,
        defaultHeaders: { 'X-Team': 'data' },
      });
      expect(mockConstructor).toHaveBeenCalledWith({
        apiKey: 'sk-test',
        baseURL: 'https://gateway.example.com/v1',
        timeout: 30000,
        maxRetries: 5,
        defaultHeaders: { 'X-Team': 'data' },
      });
    });

    it('passes maxRetries: 0 and timeout: 0 through', () => {
      provider({ maxRetries: 0, timeout: 0 });
      expect(mockConstructor).toHaveBeenCalledWith({ apiKey: 'sk-test', maxRetries: 0, timeout: 0 });
    });
  });

  describe('model', () => {
    it('defaults to gpt-6-luna', async () => {
      const p = provider();
      expect(p.getDefaultModel()).toBe('gpt-6-luna');
      await p.generate('q');
      expect(sent().model).toBe('gpt-6-luna');
    });

    it('uses the configured model', async () => {
      await provider({ model: 'gpt-6.1-sol' }).generate('q');
      expect(sent().model).toBe('gpt-6.1-sol');
    });
  });

  describe('request parameters on api.openai.com', () => {
    it('sends max_completion_tokens 8192 and no temperature for reasoning models', async () => {
      await provider().generate('q');
      expect(sent()).toEqual({
        model: 'gpt-6-luna',
        messages: [
          { role: 'system', content: DEFAULT_SYSTEM },
          { role: 'user', content: 'q' },
        ],
        max_completion_tokens: 8192,
      });
    });

    it('sends maxTokens as max_completion_tokens', async () => {
      await provider({ maxTokens: 500 }).generate('q');
      expect(sent().max_completion_tokens).toBe(500);
      expect(sent()).not.toHaveProperty('max_tokens');
    });

    it.each([
      'gpt-4o-mini',
      'gpt-4o',
      'gpt-4o-2024-08-06',
      'chatgpt-4o-latest',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
      'GPT-4o-mini',
      'ft:gpt-4o-mini-2024-07-18:acme::abc123',
    ])('sends temperature 0.1 for the non-reasoning model %s', async (model) => {
      await provider({ model }).generate('q');
      expect(sent().temperature).toBe(0.1);
      expect(sent().max_completion_tokens).toBe(8192);
    });

    it.each(['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.4-mini', 'o3', 'gpt-40'])(
      'does not send temperature for %s',
      async (model) => {
        await provider({ model, temperature: 0.3 }).generate('q');
        expect(sent()).not.toHaveProperty('temperature');
      }
    );

    it('uses the configured temperature for non-reasoning models', async () => {
      await provider({ model: 'gpt-4o-mini', temperature: 0.7 }).generate('q');
      expect(sent().temperature).toBe(0.7);
    });

    it('sends reasoning_effort only when reasoningEffort is set', async () => {
      await provider().generate('q');
      expect(sent()).not.toHaveProperty('reasoning_effort');

      await provider({ reasoningEffort: 'low' }).generate('q');
      expect(sent(1).reasoning_effort).toBe('low');
      expect(sent(1)).not.toHaveProperty('temperature');
    });

    it("sends temperature with reasoningEffort 'none'", async () => {
      await provider({ reasoningEffort: 'none' }).generate('q');
      expect(sent().reasoning_effort).toBe('none');
      expect(sent().temperature).toBe(0.1);
    });

    it('treats Azure OpenAI like api.openai.com', async () => {
      await provider({ baseURL: 'https://acme.openai.azure.com/openai/v1/', model: 'prod-sql' }).generate('q');
      expect(sent().max_completion_tokens).toBe(8192);
      expect(sent()).not.toHaveProperty('max_tokens');
      expect(sent()).not.toHaveProperty('temperature');
    });

    it.each(['https://api.openai.com/v1', 'https://eu.api.openai.com/v1'])(
      'treats %s as the default endpoint',
      async (baseURL) => {
        await provider({ baseURL }).generate('q');
        expect(sent().max_completion_tokens).toBe(8192);
        expect(sent()).not.toHaveProperty('temperature');
      }
    );

    it('does not treat look-alike hosts as OpenAI', async () => {
      await provider({ baseURL: 'https://api.openai.com.example.net/v1' }).generate('q');
      expect(sent().max_tokens).toBe(8192);
      expect(sent().temperature).toBe(0.1);
    });
  });

  describe('request parameters on other endpoints', () => {
    it('sends max_tokens and temperature when baseURL points elsewhere', async () => {
      await provider({ baseURL: 'http://localhost:11434/v1', model: 'llama3.3' }).generate('q');
      expect(sent()).toEqual({
        model: 'llama3.3',
        messages: [
          { role: 'system', content: DEFAULT_SYSTEM },
          { role: 'user', content: 'q' },
        ],
        max_tokens: 8192,
        temperature: 0.1,
      });
    });

    it('treats a base URL from OPENAI_BASE_URL like a configured one', async () => {
      const saved = process.env.OPENAI_BASE_URL;
      process.env.OPENAI_BASE_URL = 'https://api.mistral.ai/v1';
      try {
        await provider({ model: 'mistral-large-latest' }).generate('q');
      } finally {
        if (saved === undefined) delete process.env.OPENAI_BASE_URL;
        else process.env.OPENAI_BASE_URL = saved;
      }
      expect(sent().max_tokens).toBe(8192);
      expect(sent().temperature).toBe(0.1);
    });

    it('treats an unparseable baseURL as another endpoint', async () => {
      await provider({ baseURL: 'not a url' }).generate('q');
      expect(sent().max_tokens).toBe(8192);
    });

    it('lets tokenLimitParam override the default field', async () => {
      await provider({ tokenLimitParam: 'max_tokens' }).generate('q');
      expect(sent().max_tokens).toBe(8192);
      expect(sent()).not.toHaveProperty('max_completion_tokens');

      await provider({ baseURL: 'https://api.groq.com/openai/v1', tokenLimitParam: 'max_completion_tokens' }).generate('q');
      expect(sent(1).max_completion_tokens).toBe(8192);
      expect(sent(1)).not.toHaveProperty('max_tokens');
    });
  });

  describe('unsupported parameter retry', () => {
    it('drops a rejected temperature, retries, and remembers it', async () => {
      mockCreate
        .mockRejectedValueOnce(
          badRequest("Unsupported parameter: 'temperature' is not supported with this model.", 'unsupported_parameter', 'temperature')
        )
        .mockResolvedValue(completion('SELECT 2'));
      const p = provider({ model: 'gpt-4o-mini' });

      await expect(p.generate('q')).resolves.toBe('SELECT 2');
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(sent(0).temperature).toBe(0.1);
      expect(sent(1)).not.toHaveProperty('temperature');
      expect(sent(1).max_completion_tokens).toBe(8192);

      await p.generateWithSystem('sys', 'q2');
      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(sent(2)).not.toHaveProperty('temperature');
    });

    it('swaps a rejected max_tokens for max_completion_tokens and remembers it', async () => {
      mockCreate
        .mockRejectedValueOnce(
          badRequest(
            "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            'unsupported_parameter',
            'max_tokens'
          )
        )
        .mockResolvedValue(completion('SELECT 3'));
      const p = provider({ baseURL: 'https://proxy.example.com/v1', maxTokens: 1234 });

      await expect(p.generate('q')).resolves.toBe('SELECT 3');
      expect(sent(0).max_tokens).toBe(1234);
      expect(sent(1)).not.toHaveProperty('max_tokens');
      expect(sent(1).max_completion_tokens).toBe(1234);

      await p.generate('q2');
      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(sent(2).max_completion_tokens).toBe(1234);
      expect(sent(2)).not.toHaveProperty('max_tokens');
    });

    it('finds the parameter in the message when code and param are missing', async () => {
      mockCreate
        .mockRejectedValueOnce(
          badRequest("Unsupported parameter: 'max_completion_tokens' is not supported by this endpoint.", null, null)
        )
        .mockResolvedValue(completion('SELECT 4'));

      await expect(provider().generate('q')).resolves.toBe('SELECT 4');
      expect(sent(1).max_tokens).toBe(8192);
      expect(sent(1)).not.toHaveProperty('max_completion_tokens');
    });

    it('handles unsupported_value for reasoning_effort and then temperature', async () => {
      mockCreate
        .mockRejectedValueOnce(
          badRequest(
            "Unsupported value: 'reasoning_effort' does not support 'none' with this model.",
            'unsupported_value',
            'reasoning_effort'
          )
        )
        .mockRejectedValueOnce(
          badRequest(
            "Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) value is supported.",
            'unsupported_value',
            'temperature'
          )
        )
        .mockResolvedValue(completion('SELECT 5'));
      const p = provider({ model: 'gpt-6.1-sol', reasoningEffort: 'none' });

      await expect(p.generate('q')).resolves.toBe('SELECT 5');
      expect(mockCreate).toHaveBeenCalledTimes(3);
      expect(sent(0)).toMatchObject({ reasoning_effort: 'none', temperature: 0.1 });
      expect(sent(1)).not.toHaveProperty('reasoning_effort');
      expect(sent(1).temperature).toBe(0.1);
      expect(sent(2)).not.toHaveProperty('reasoning_effort');
      expect(sent(2)).not.toHaveProperty('temperature');

      // Later requests send neither, without a failed attempt first.
      await p.generate('q2');
      expect(mockCreate).toHaveBeenCalledTimes(4);
      expect(sent(3)).not.toHaveProperty('reasoning_effort');
      expect(sent(3)).not.toHaveProperty('temperature');
    });

    it('retries at most once per parameter', async () => {
      const error = badRequest("Unsupported parameter: 'temperature'", 'unsupported_parameter', 'temperature');
      mockCreate.mockRejectedValue(error);

      const failure = await provider({ model: 'gpt-4o' }).generate('q').catch((e) => e);
      expect(mockCreate).toHaveBeenCalledTimes(2);
      expect(failure).toBeInstanceOf(TextToQueryError);
      expect(failure.code).toBe('OPENAI_API_ERROR');
      expect(failure.details).toBe(error);
    });

    it('swaps the token limit field at most once', async () => {
      mockCreate.mockImplementation((params: any) =>
        Promise.reject(
          'max_tokens' in params
            ? badRequest("Unsupported parameter: 'max_tokens'", 'unsupported_parameter', 'max_tokens')
            : badRequest("Unsupported parameter: 'max_completion_tokens'", 'unsupported_parameter', 'max_completion_tokens')
        )
      );

      await expect(provider({ tokenLimitParam: 'max_tokens' }).generate('q')).rejects.toMatchObject({
        code: 'OPENAI_API_ERROR',
      });
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });

    it('does not retry other 400 errors', async () => {
      mockCreate.mockRejectedValue(
        badRequest('max_tokens is too large: 999999. This model supports at most 128000 completion tokens.', 'invalid_value', 'max_tokens')
      );
      await expect(provider({ maxTokens: 999999 }).generate('q')).rejects.toMatchObject({ code: 'OPENAI_API_ERROR' });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('does not retry unsupported parameters it cannot fix', async () => {
      mockCreate.mockRejectedValue(
        badRequest("Unsupported value: 'messages[0].role' does not support 'system' with this model.", 'unsupported_value', 'messages[0].role')
      );
      await expect(provider().generate('q')).rejects.toMatchObject({ code: 'OPENAI_API_ERROR' });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('does not retry when the rejected parameter was not sent', async () => {
      mockCreate.mockRejectedValue(badRequest("Unsupported parameter: 'top_p'", 'unsupported_parameter', 'top_p'));
      await expect(provider().generate('q')).rejects.toMatchObject({ code: 'OPENAI_API_ERROR' });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('does not retry errors other than 400', async () => {
      mockCreate.mockRejectedValue(
        Object.assign(new Error("429 Unsupported parameter: 'temperature'"), { status: 429, code: 'unsupported_parameter', param: 'temperature' })
      );
      await expect(provider({ model: 'gpt-4o' }).generate('q')).rejects.toMatchObject({ code: 'OPENAI_API_ERROR' });
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe('responses', () => {
    it('returns trimmed content', async () => {
      mockCreate.mockResolvedValue(completion('  SELECT * FROM users\n'));
      await expect(provider().generate('q')).resolves.toBe('SELECT * FROM users');
    });

    it('returns content even when finish_reason is length', async () => {
      mockCreate.mockResolvedValue(completion('SELECT id FROM', { finish_reason: 'length' }));
      await expect(provider().generate('q')).resolves.toBe('SELECT id FROM');
    });

    it('reports a refusal as OPENAI_EMPTY_RESPONSE with the refusal text', async () => {
      mockCreate.mockResolvedValue(completion(null, { refusal: "I can't help with that." }));
      const error = await provider().generate('q').catch((e) => e);
      expect(error).toBeInstanceOf(TextToQueryError);
      expect(error.code).toBe('OPENAI_EMPTY_RESPONSE');
      expect(error.details).toEqual({ reason: 'refusal', refusal: "I can't help with that." });
      expect(error.message).toContain("I can't help with that.");
    });

    it('reports an empty response cut off by the token limit', async () => {
      mockCreate.mockResolvedValue(completion('', { finish_reason: 'length' }));
      const error = await provider({ maxTokens: 300 }).generate('q').catch((e) => e);
      expect(error.code).toBe('OPENAI_EMPTY_RESPONSE');
      expect(error.details).toEqual({ reason: 'length' });
      expect(error.message).toContain('300');
      expect(error.message).toContain('maxTokens');
      expect(error.message).toContain('reasoningEffort');
    });

    it('keeps the 0.0.1 error for other empty responses', async () => {
      mockCreate.mockResolvedValue(completion(null, { finish_reason: 'content_filter' }));
      const error = await provider().generate('q').catch((e) => e);
      expect(error.code).toBe('OPENAI_EMPTY_RESPONSE');
      expect(error.message).toBe('No response from OpenAI');
      expect(error.details).toBeUndefined();
    });

    it('reports a response without choices as OPENAI_EMPTY_RESPONSE', async () => {
      mockCreate.mockResolvedValue({ choices: [] });
      await expect(provider().generate('q')).rejects.toMatchObject({
        code: 'OPENAI_EMPTY_RESPONSE',
        message: 'No response from OpenAI',
      });
    });

    it('maps API errors to OPENAI_API_ERROR with the original error', async () => {
      const apiError = Object.assign(new Error('401 Incorrect API key provided'), { status: 401 });
      mockCreate.mockRejectedValue(apiError);
      const error = await provider().generate('q').catch((e) => e);
      expect(error).toBeInstanceOf(TextToQueryError);
      expect(error.code).toBe('OPENAI_API_ERROR');
      expect(error.message).toBe('OpenAI API error: 401 Incorrect API key provided');
      expect(error.details).toBe(apiError);
    });
  });

  describe('generate and generateWithSystem', () => {
    it('generate sends the 0.0.1 system prompt', async () => {
      await provider().generate('Count users');
      expect(sent().messages).toEqual([
        { role: 'system', content: DEFAULT_SYSTEM },
        { role: 'user', content: 'Count users' },
      ]);
    });

    it('generateWithSystem sends the given system prompt separately', async () => {
      await expect(provider().generateWithSystem('SCHEMA AND RULES', 'Count users')).resolves.toBe('SELECT 1');
      expect(sent().messages).toEqual([
        { role: 'system', content: 'SCHEMA AND RULES' },
        { role: 'user', content: 'Count users' },
      ]);
    });

    it('generateWithSystem goes through generate() when an instance stubs it', async () => {
      const p = provider();
      const stub = jest.fn().mockResolvedValue('SELECT stub');
      p.generate = stub;
      await expect(p.generateWithSystem('SYS', 'Q')).resolves.toBe('SELECT stub');
      expect(stub).toHaveBeenCalledWith('SYS\n\nQ');
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('generateWithSystem goes through generate() when a subclass overrides it', async () => {
      const seen: string[] = [];
      class LoggingProvider extends OpenAIProvider {
        async generate(prompt: string): Promise<string> {
          seen.push(prompt);
          return super.generate(prompt);
        }
      }
      const p = new LoggingProvider({ provider: 'openai', apiKey: 'sk-test' });
      await expect(p.generateWithSystem('SYS', 'Q')).resolves.toBe('SELECT 1');
      expect(seen).toEqual(['SYS\n\nQ']);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(sent().messages[0]).toEqual({ role: 'system', content: DEFAULT_SYSTEM });
    });

    it('generateWithSystem goes through generate() when the prototype is spied on', async () => {
      const spy = jest.spyOn(OpenAIProvider.prototype, 'generate').mockResolvedValue('SELECT spied');
      try {
        await expect(provider().generateWithSystem('SYS', 'Q')).resolves.toBe('SELECT spied');
        expect(spy).toHaveBeenCalledWith('SYS\n\nQ');
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('validateApiKey', () => {
    it('returns true when models.list succeeds', async () => {
      mockModelsList.mockResolvedValue({ data: [] });
      await expect(provider().validateApiKey()).resolves.toBe(true);
      expect(mockModelsList).toHaveBeenCalledTimes(1);
    });

    it('returns false on any error', async () => {
      mockModelsList.mockRejectedValue(new Error('401'));
      await expect(provider().validateApiKey()).resolves.toBe(false);
    });
  });
});
