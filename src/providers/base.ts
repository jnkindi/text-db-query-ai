import { LLMConfig } from '../types';

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
}
