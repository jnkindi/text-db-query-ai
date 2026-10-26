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
