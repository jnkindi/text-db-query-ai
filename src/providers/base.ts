import { LLMConfig } from '../types';

/**
 * System prompt that generate() sends. Same text as 0.0.1.
 * @internal
 */
export const DEFAULT_SYSTEM_PROMPT =
  'You are a database query generator. Generate only valid SQL queries based on the provided schema and user request. Return ONLY the query without explanations unless specifically asked.';

/**
 * The SDK client options both providers pass through from LLMConfig.
 * @internal
 */
export interface SdkClientOptions {
  apiKey: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  defaultHeaders?: Record<string, string>;
}

/**
 * Build SDK client options from the config, including only the fields that are set,
 * so the SDK keeps its own defaults (and environment variables) for the rest.
 * @internal
 */
export function sdkClientOptions(config: LLMConfig): SdkClientOptions {
  const options: SdkClientOptions = { apiKey: config.apiKey };
  if (config.baseURL) options.baseURL = config.baseURL;
  if (config.timeout !== undefined) options.timeout = config.timeout;
  if (config.maxRetries !== undefined) options.maxRetries = config.maxRetries;
  if (config.defaultHeaders) options.defaultHeaders = config.defaultHeaders;
  return options;
}

/**
 * Return the default export of a CommonJS module the way TypeScript's
 * esModuleInterop does. The SDKs are loaded with require() so that importing
 * this package does not load them until a provider is constructed.
 * @internal
 */
export function defaultExport<T>(mod: any): T {
  return mod && mod.__esModule ? mod.default : mod;
}

/**
 * Lowercased host name of a URL, or undefined when it cannot be parsed.
 * @internal
 */
export function urlHost(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Abstract base class for LLM providers
 */
export abstract class BaseLLMProvider {
  protected config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  /**
   * Generate a response from the LLM
   */
  abstract generate(prompt: string): Promise<string>;

  /**
   * Validate the API key
   */
  abstract validateApiKey(): Promise<boolean>;

  /**
   * Get the default model for the provider
   */
  abstract getDefaultModel(): string;

  /**
   * Generate a response from a system prompt and a user message.
   * Providers override this to send the two separately (which enables prompt
   * caching). The default joins them and calls generate(), so custom
   * subclasses that only implement generate() keep working.
   */
  async generateWithSystem(system: string, prompt: string): Promise<string> {
    return this.generate(`${system}\n\n${prompt}`);
  }
}
