import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeEffort, LLMConfig, TextToQueryError } from '../types';
import {
  BaseLLMProvider,
  DEFAULT_SYSTEM_PROMPT,
  defaultExport,
  sdkClientOptions,
  urlHost,
} from './base';

/** Thinking is always on for current models and counts toward max_tokens. */
const DEFAULT_MAX_TOKENS = 16000;
/** Beta header for `fallbacks: 'default'` (the array form uses a different header). */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** A 400 whose message names the fallbacks parameter or its beta header. */
const FALLBACK_REJECTED = /fallback/i;
/**
 * The 400 for a max_tokens above what the model can write: "max_tokens: 16000 >
 * 8192, which is the maximum allowed number of output tokens for ...". Captures
 * the model's limit.
 */
const MAX_TOKENS_TOO_LARGE = /\bmax_tokens:\s*\d+\s*>\s*(\d+)/;

type ClaudeMessage = Anthropic.Message | Anthropic.Beta.BetaMessage;
type SystemParam = string | Array<{ type: 'text'; text: string; cache_control: { type: 'ephemeral' } }>;

/** Request params shared by the beta (fallbacks) and the standard Messages API. */
interface ClaudeParams {
  model: string;
  max_tokens: number;
  system: SystemParam;
  messages: Array<{ role: 'user'; content: string }>;
  output_config?: { effort: ClaudeEffort };
}

/**
 * Server-side fallbacks exist only on the Claude API itself, not on proxies,
 * gateways or other compatible endpoints.
 */
function isAnthropicEndpoint(baseURL: string | null | undefined): boolean {
  return !baseURL || urlHost(baseURL) === 'api.anthropic.com';
}

function isFallbackRejection(error: any): boolean {
  return error?.status === 400 && FALLBACK_REJECTED.test(String(error.message));
}

/**
 * The model's output token limit, when a 400 response rejected `requested` as
 * too large and names a lower limit. Undefined for any other error.
 */
function outputTokenLimit(error: any, requested: number): number | undefined {
  if (error?.status !== 400) return undefined;
  const match = MAX_TOKENS_TOO_LARGE.exec(String(error.message));
  if (!match) return undefined;
  const limit = Number(match[1]);
  return Number.isSafeInteger(limit) && limit > 0 && limit < requested ? limit : undefined;
}

/**
 * Claude (Anthropic) LLM provider implementation
 */
export class ClaudeProvider extends BaseLLMProvider {
  private client: Anthropic;
  /** Send `fallbacks: 'default'`, so a declined request is retried on Anthropic's recommended fallback model. */
  private useFallbacks: boolean;
  /** The model's output token limit, after the API rejected a larger max_tokens. */
  private outputTokenCap?: number;

  constructor(config: LLMConfig) {
    super(config);
    // Loaded here instead of with a top-level import, so that importing the
    // package does not load the Anthropic SDK until a Claude provider is created.
    const AnthropicClient = defaultExport<typeof Anthropic>(require('@anthropic-ai/sdk'));
    this.client = new AnthropicClient(sdkClientOptions(config));
    // The SDK also reads ANTHROPIC_BASE_URL, so check the URL it actually uses.
    this.useFallbacks =
      config.fallbacks !== false && isAnthropicEndpoint(config.baseURL ?? this.client.baseURL);
  }

  /**
   * Generate a response from Claude
   */
  async generate(prompt: string): Promise<string> {
    return this.complete(DEFAULT_SYSTEM_PROMPT, prompt);
  }

  /**
   * Generate a response from Claude, sending `system` as the system prompt
   * (cached unless `promptCaching` is false).
   */
  async generateWithSystem(system: string, prompt: string): Promise<string> {
    if (this.generate !== ownGenerate) {
      // generate() was overridden or stubbed: keep calling it, as 0.0.1 did.
      return super.generateWithSystem(system, prompt);
    }
    return this.complete(system, prompt);
  }

  /**
   * Validate the Claude API key. Lists models, which uses no tokens.
   */
  async validateApiKey(): Promise<boolean> {
    try {
      await this.client.models.list({ limit: 1 });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get the default Claude model
   */
  getDefaultModel(): string {
    return 'claude-opus-5-5';
  }

  /**
   * Send one message and return its text. No sampling or thinking parameters
   * are sent: current models reject the former and always think. If the API
   * rejects max_tokens as larger than the model can write, the request is
   * retried once with the limit the API reports, and later requests use it.
   */
  private async complete(system: string, prompt: string): Promise<string> {
    try {
      const maxTokens = this.config.maxTokens ?? DEFAULT_MAX_TOKENS;
      const params: ClaudeParams = {
        model: this.config.model || this.getDefaultModel(),
        max_tokens: this.outputTokenCap === undefined ? maxTokens : Math.min(maxTokens, this.outputTokenCap),
        system: this.systemParam(system),
        messages: [{ role: 'user', content: prompt }],
      };
      if (this.config.effort) {
        params.output_config = { effort: this.config.effort };
      }
      let lowered = false;
      for (;;) {
        try {
          // A copy per attempt, since a retry changes params.
          return readText(await this.send({ ...params }), params.max_tokens);
        } catch (error) {
          // An older model writes fewer tokens than the default or maxTokens.
          // max_tokens only caps the output, so the model's own limit is equivalent.
          const limit = lowered ? undefined : outputTokenLimit(error, params.max_tokens);
          if (limit === undefined) throw error;
          params.max_tokens = limit;
          this.outputTokenCap = limit;
          lowered = true;
        }
      }
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
   * Stream the request and collect it with finalMessage(), so a large
   * max_tokens never hits the SDK's limit for non-streaming requests. With
   * fallbacks on, the beta API is used. If the API rejects the fallbacks
   * parameter or its beta header, the request is sent once more without them
   * and later requests leave them out.
   */
  private async send(params: ClaudeParams): Promise<ClaudeMessage> {
    if (this.useFallbacks) {
      try {
        return await this.client.beta.messages
          .stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' })
          .finalMessage();
      } catch (error) {
        if (!isFallbackRejection(error)) {
          throw error;
        }
        this.useFallbacks = false;
      }
    }
    return this.client.messages.stream(params).finalMessage();
  }

  private systemParam(system: string): SystemParam {
    if (this.config.promptCaching === false) {
      return system;
    }
    // One breakpoint on the system block caches it. Prompts shorter than the
    // model's minimum cacheable length are simply not cached.
    return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }
}

/** generate() as defined above; generateWithSystem() compares against it to detect overrides. */
const ownGenerate = ClaudeProvider.prototype.generate;

/**
 * Join the text of every text block. Thinking and fallback blocks are skipped,
 * and after a mid-answer fallback the text blocks continue one another.
 *
 * A response cut off by max_tokens or by the context window is an error, with
 * the text so far in `details.partialText`: a query missing its end (a WHERE
 * clause, say) can still be valid SQL.
 */
function readText(message: ClaudeMessage, maxTokens: number): string {
  // A refusal can arrive after partial output, which must not be used.
  if (message.stop_reason === 'refusal') {
    const stopDetails = message.stop_details ?? null;
    const category = stopDetails?.category;
    throw new TextToQueryError(
      `Claude declined the request${category ? ` (category: ${category})` : ''}`,
      'CLAUDE_INVALID_RESPONSE',
      { stopReason: 'refusal', stopDetails }
    );
  }

  let text = '';
  for (const block of message.content ?? []) {
    if (block.type === 'text') {
      text += block.text;
    }
  }
  text = text.trim();

  if (message.stop_reason === 'max_tokens') {
    throw new TextToQueryError(
      `Claude reached max_tokens (${maxTokens}) before ${text ? 'finishing the response, so it was not used' : 'writing a response'}. ` +
        'Thinking counts toward this limit: increase maxTokens or set a lower effort.',
      'CLAUDE_INVALID_RESPONSE',
      text ? { stopReason: 'max_tokens', partialText: text } : { stopReason: 'max_tokens' }
    );
  }
  if (message.stop_reason === 'model_context_window_exceeded') {
    throw new TextToQueryError(
      `Claude reached the model's context window before ${text ? 'finishing the response, so it was not used' : 'writing a response'}. ` +
        'Send a smaller schema (includeTables or excludeTables) or use a model with a larger context window.',
      'CLAUDE_INVALID_RESPONSE',
      text
        ? { stopReason: 'model_context_window_exceeded', partialText: text }
        : { stopReason: 'model_context_window_exceeded' }
    );
  }
  if (text) {
    return text;
  }
  throw new TextToQueryError(
    'Unexpected response type from Claude',
    'CLAUDE_INVALID_RESPONSE',
    { stopReason: message.stop_reason }
  );
}
