import OpenAI from 'openai';
import { LLMConfig, TextToQueryError } from '../types';
import { BaseLLMProvider } from './base';

/**
 * OpenAI LLM provider implementation
 */
export class OpenAIProvider extends BaseLLMProvider {
  private client: OpenAI;

  constructor(config: LLMConfig) {
    super(config);
    this.client = new OpenAI({
      apiKey: config.apiKey,
    });
  }

  /**
   * Generate a response from OpenAI
   */
  async generate(prompt: string): Promise<string> {
    try {
      const model = this.config.model || this.getDefaultModel();
      const temperature = this.config.temperature ?? 0.1;
      const maxTokens = this.config.maxTokens ?? 1000;

      const response = await this.client.chat.completions.create({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are a database query generator. Generate only valid SQL queries based on the provided schema and user request. Return ONLY the query without explanations unless specifically asked.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature,
        max_tokens: maxTokens,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new TextToQueryError(
          'No response from OpenAI',
          'OPENAI_EMPTY_RESPONSE'
        );
      }

      return content.trim();
    } catch (error: any) {
      if (error instanceof TextToQueryError) {
        throw error;
      }
      throw new TextToQueryError(
        `OpenAI API error: ${error.message}`,
        'OPENAI_API_ERROR',
        error
      );
    }
  }

  /**
   * Validate the OpenAI API key
   */
  async validateApiKey(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get the default OpenAI model
   */
  getDefaultModel(): string {
    return 'gpt-4o-mini';
  }
}
