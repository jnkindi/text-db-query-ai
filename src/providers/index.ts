import { LLMConfig, TextToQueryError } from '../types';
import { BaseLLMProvider } from './base';
import { OpenAIProvider } from './openai';
import { ClaudeProvider } from './claude';

/**
 * Factory function to create LLM provider instances
 */
export function createLLMProvider(config: LLMConfig): BaseLLMProvider {
  switch (config.provider) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'claude':
      return new ClaudeProvider(config);
    default:
      throw new TextToQueryError(
        `Unsupported LLM provider: ${config.provider}`,
        'UNSUPPORTED_PROVIDER'
      );
  }
}

export { BaseLLMProvider, OpenAIProvider, ClaudeProvider };
