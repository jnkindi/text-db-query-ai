import Anthropic from '@anthropic-ai/sdk';
import { LLMConfig, TextToQueryError } from '../types';
import { BaseLLMProvider } from './base';

/**
 * Claude (Anthropic) LLM provider implementation
 */
export class ClaudeProvider extends BaseLLMProvider {
  private client: Anthropic;

  constructor(config: LLMConfig) {
    super(config);
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
  }

  /**
   * Generate a response from Claude
   */
  async generate(prompt: string): Promise<string> {
    try {
      const model = this.config.model || this.getDefaultModel();
      const temperature = this.config.temperature ?? 0.1;
      const maxTokens = this.config.maxTokens ?? 1000;

      const response = await this.client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature,
        system: 'You are a database query generator. Generate only valid SQL queries based on the provided schema and user request. Return ONLY the query without explanations unless specifically asked.',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new TextToQueryError(
          'Unexpected response type from Claude',
          'CLAUDE_INVALID_RESPONSE'
        );
      }

      return content.text.trim();
    } catch (error: any) {
      if (error instanceof TextToQueryError) {
        throw error;
      }
      throw new TextToQueryError(
        `Claude API error: ${error.message}`,
        'CLAUDE_API_ERROR',
        error
      );
    }
  }

  /**
   * Validate the Claude API key
   */
  async validateApiKey(): Promise<boolean> {
    try {
      // Make a minimal API call to test the key
      await this.client.messages.create({
        model: this.getDefaultModel(),
        max_tokens: 10,
        messages: [{ role: 'user', content: 'test' }],
      });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get the default Claude model
   */
  getDefaultModel(): string {
    return 'claude-3-5-sonnet-20241022';
  }
}
