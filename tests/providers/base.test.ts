/**
 * BaseLLMProvider defaults, the provider factory and the shared helpers.
 * Uses the real SDKs: constructing a client makes no network request.
 */

import {
  createLLMProvider,
  BaseLLMProvider,
  OpenAIProvider,
  ClaudeProvider,
} from '../../src/providers';
import { defaultExport, sdkClientOptions, urlHost } from '../../src/providers/base';
import { LLMConfig, TextToQueryError } from '../../src/types';

/** A custom provider written against the 0.0.1 API: it implements generate() only. */
class EchoProvider extends BaseLLMProvider {
  prompts: string[] = [];

  async generate(prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return 'SELECT 1';
  }

  async validateApiKey(): Promise<boolean> {
    return true;
  }

  getDefaultModel(): string {
    return 'echo';
  }
}

describe('BaseLLMProvider', () => {
  it('default generateWithSystem joins system and prompt and calls generate()', async () => {
    const provider = new EchoProvider({ provider: 'openai', apiKey: 'unused' });
    await expect(provider.generateWithSystem('RULES', 'QUESTION')).resolves.toBe('SELECT 1');
    expect(provider.prompts).toEqual(['RULES\n\nQUESTION']);
  });

  it('keeps generate() working for custom providers', async () => {
    const provider = new EchoProvider({ provider: 'openai', apiKey: 'unused' });
    await expect(provider.generate('QUESTION')).resolves.toBe('SELECT 1');
    expect(provider.prompts).toEqual(['QUESTION']);
  });
});

describe('createLLMProvider', () => {
  it('creates an OpenAIProvider', () => {
    const provider = createLLMProvider({ provider: 'openai', apiKey: 'sk-test' });
    expect(provider).toBeInstanceOf(OpenAIProvider);
    expect(provider).toBeInstanceOf(BaseLLMProvider);
    expect(provider.getDefaultModel()).toBe('gpt-6-luna');
  });

  it('creates a ClaudeProvider', () => {
    const provider = createLLMProvider({ provider: 'claude', apiKey: 'sk-ant-test' });
    expect(provider).toBeInstanceOf(ClaudeProvider);
    expect(provider).toBeInstanceOf(BaseLLMProvider);
    expect(provider.getDefaultModel()).toBe('claude-opus-5-5');
  });

  it('throws UNSUPPORTED_PROVIDER for an unknown provider', () => {
    const config = { provider: 'gemini', apiKey: 'k' } as unknown as LLMConfig;
    expect(() => createLLMProvider(config)).toThrow(TextToQueryError);
    expect(() => createLLMProvider(config)).toThrow('Unsupported LLM provider: gemini');
    try {
      createLLMProvider(config);
    } catch (error: any) {
      expect(error.code).toBe('UNSUPPORTED_PROVIDER');
    }
  });
});

describe('provider helpers', () => {
  it('sdkClientOptions includes only the fields that are set', () => {
    expect(sdkClientOptions({ provider: 'openai', apiKey: 'k' })).toEqual({ apiKey: 'k' });
    expect(
      sdkClientOptions({
        provider: 'claude',
        apiKey: 'k',
        baseURL: 'https://x.example',
        timeout: 0,
        maxRetries: 0,
        defaultHeaders: { a: 'b' },
        model: 'm',
        temperature: 0.5,
      })
    ).toEqual({ apiKey: 'k', baseURL: 'https://x.example', timeout: 0, maxRetries: 0, defaultHeaders: { a: 'b' } });
  });

  it('defaultExport handles ES module interop and plain CommonJS modules', () => {
    const fn = () => 1;
    expect(defaultExport({ __esModule: true, default: fn })).toBe(fn);
    expect(defaultExport(fn)).toBe(fn);
  });

  it('urlHost lowercases the host and returns undefined for bad URLs', () => {
    expect(urlHost('https://API.OpenAI.com/v1')).toBe('api.openai.com');
    expect(urlHost('http://localhost:11434/v1')).toBe('localhost');
    expect(urlHost('not a url')).toBeUndefined();
  });
});
