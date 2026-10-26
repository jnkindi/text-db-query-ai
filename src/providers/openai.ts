import type OpenAI from 'openai';
import { LLMConfig, TextToQueryError } from '../types';
import {
  BaseLLMProvider,
  DEFAULT_SYSTEM_PROMPT,
  defaultExport,
  sdkClientOptions,
  urlHost,
} from './base';

type ChatParams = OpenAI.ChatCompletionCreateParamsNonStreaming;
type TokenLimitParam = 'max_tokens' | 'max_completion_tokens';
/** Optional request fields that the unsupported-parameter retry removes. */
type DroppableParam = 'temperature' | 'top_p' | 'reasoning_effort';

/** Reasoning tokens count toward the limit, so current models need room to think. */
const DEFAULT_MAX_TOKENS = 8192;
/**
 * The 0.0.1 default, kept for the non-reasoning models 0.0.1 users pinned:
 * several of them (gpt-3.5-turbo, gpt-4-turbo) cannot write more than 4096
 * tokens and reject a larger limit, and gpt-4 has an 8k context.
 */
const LEGACY_MAX_TOKENS = 1000;
const DEFAULT_TEMPERATURE = 0.1;

/**
 * Non-reasoning model families, which accept `temperature` without `reasoning_effort: 'none'`
 * and default to the 0.0.1 token limit. Fine-tuned models ("ft:gpt-4o-mini:...") match too.
 */
const LEGACY_MODEL_PATTERN = /^(?:ft:)?(?:gpt-4o|chatgpt-4o|gpt-4\.1|gpt-4-|gpt-3\.5|gpt-4(?:$|:))/;

/** Error codes OpenAI uses when a model does not accept a request field or its value. */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set(['unsupported_parameter', 'unsupported_value']);
/** Request fields the retry knows how to fix. */
const RETRYABLE_PARAMS: ReadonlySet<string> = new Set([
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
]);
const UNSUPPORTED_MESSAGE = /unsupported/i;
/** First retryable field named in a message such as "Unsupported parameter: 'max_tokens' ...". */
const PARAM_IN_MESSAGE = /\b(max_completion_tokens|max_tokens|temperature|top_p|reasoning_effort)\b/;
/**
 * The 400 for a token limit above what the model can write: "max_tokens is too
 * large: 8192. This model supports at most 4096 completion tokens, whereas you
 * provided 8192." Captures the model's limit.
 */
const TOKEN_LIMIT_TOO_LARGE = /\b(?:max_completion_tokens|max_tokens)\b[^.]{0,40}\btoo large\b[\s\S]{0,200}?\bat most (\d+)/i;

/**
 * True for api.openai.com (and its regional hosts such as eu.api.openai.com)
 * and Azure OpenAI (*.openai.azure.com). Other OpenAI-compatible endpoints
 * (Ollama, Mistral, DeepSeek, gateways) get the classic request shape:
 * `max_tokens` and `temperature`.
 */
function isOpenAIEndpoint(baseURL: string | null | undefined): boolean {
  if (!baseURL) return true;
  const host = urlHost(baseURL);
  if (host === undefined) return false;
  return host === 'api.openai.com' || host.endsWith('.api.openai.com') || host.endsWith('.openai.azure.com');
}

/**
 * The request field a 400 response says the model does not support, if it is
 * one the retry can fix. Uses the error's `code`/`param` when present and falls
 * back to the message, since compatible endpoints do not always set them.
 */
function unsupportedParam(error: any): string | undefined {
  if (!error || error.status !== 400) return undefined;
  const message = typeof error.message === 'string' ? error.message : '';
  if (!UNSUPPORTED_CODES.has(error.code) && !UNSUPPORTED_MESSAGE.test(message)) return undefined;
  if (typeof error.param === 'string' && error.param) {
    return RETRYABLE_PARAMS.has(error.param) ? error.param : undefined;
  }
  return PARAM_IN_MESSAGE.exec(message)?.[1];
}

/**
 * The model's output token limit, when a 400 response rejected `requested` as
 * too large and names a lower limit. Undefined for any other error.
 */
function outputTokenLimit(error: any, requested: number): number | undefined {
  if (!error || error.status !== 400) return undefined;
  const message = typeof error.message === 'string' ? error.message : '';
  const match = TOKEN_LIMIT_TOO_LARGE.exec(message);
  if (!match) return undefined;
  const limit = Number(match[1]);
  return Number.isSafeInteger(limit) && limit > 0 && limit < requested ? limit : undefined;
}

/**
 * OpenAI LLM provider implementation
 */
export class OpenAIProvider extends BaseLLMProvider {
  private client: OpenAI;
  /** api.openai.com or Azure OpenAI, as opposed to another compatible endpoint. */
  private readonly officialEndpoint: boolean;
  /** Fields the server rejected on an earlier request; later requests leave them out. */
  private readonly droppedParams = new Set<DroppableParam>();
  /** Token limit field to send after the server rejected the other one. */
  private tokenLimitOverride?: TokenLimitParam;
  /** The model's output token limit, after the server rejected a larger one. */
  private outputTokenCap?: number;

  constructor(config: LLMConfig) {
    super(config);
    // Loaded here instead of with a top-level import, so that importing the
    // package does not load the OpenAI SDK until an OpenAI provider is created.
    const OpenAIClient = defaultExport<typeof OpenAI>(require('openai'));
    this.client = new OpenAIClient(sdkClientOptions(config));
    // The SDK also reads OPENAI_BASE_URL, so check the URL it actually uses.
    this.officialEndpoint = isOpenAIEndpoint(config.baseURL ?? this.client.baseURL);
  }

  /**
   * Generate a response from OpenAI
   */
  async generate(prompt: string): Promise<string> {
    return this.complete(DEFAULT_SYSTEM_PROMPT, prompt);
  }

  /**
   * Generate a response from OpenAI, sending `system` as the system message.
   */
  async generateWithSystem(system: string, prompt: string): Promise<string> {
    if (this.generate !== ownGenerate) {
      // generate() was overridden or stubbed: keep calling it, as 0.0.1 did.
      return super.generateWithSystem(system, prompt);
    }
    return this.complete(system, prompt);
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
    return 'gpt-6-luna';
  }

  /**
   * Send one chat completion. If the server rejects a field as unsupported
   * (for example `temperature` or `max_tokens` on a reasoning model), the field
   * is dropped or swapped and the request is retried, once per field. If it
   * rejects the token limit as larger than the model can write, the request is
   * retried once with the limit the server reports. Each adjustment is kept
   * for later requests on this provider.
   */
  private async complete(system: string, prompt: string): Promise<string> {
    const params = this.buildParams(system, prompt);
    const adjusted = new Set<string>();
    let lowered = false;
    for (;;) {
      try {
        // A copy per attempt, since a retry changes params.
        const response = await this.client.chat.completions.create({ ...params });
        return readContent(response, params);
      } catch (error: any) {
        if (error instanceof TextToQueryError) {
          throw error;
        }
        const param = unsupportedParam(error);
        if (param !== undefined) {
          // The two token limit fields are one setting: swap them at most once.
          const key = param === 'max_completion_tokens' ? 'max_tokens' : param;
          if (!adjusted.has(key) && this.adjustParams(params, param)) {
            adjusted.add(key);
            continue;
          }
        }
        if (!lowered) {
          // An older model (gpt-3.5-turbo, gpt-4-turbo, a pinned snapshot)
          // writes fewer tokens than the default limit or maxTokens: the
          // limit only caps the output, so the model's own limit is equivalent.
          const field: TokenLimitParam = params.max_completion_tokens != null ? 'max_completion_tokens' : 'max_tokens';
          const requested = params[field];
          const limit = requested == null ? undefined : outputTokenLimit(error, requested);
          if (limit !== undefined) {
            params[field] = limit;
            this.outputTokenCap = limit;
            lowered = true;
            continue;
          }
        }
        throw new TextToQueryError(
          `OpenAI API error: ${error.message}`,
          'OPENAI_API_ERROR',
          error
        );
      }
    }
  }

  private buildParams(system: string, prompt: string): ChatParams {
    const model = this.config.model || this.getDefaultModel();
    const params: ChatParams = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    };

    const legacyModel = LEGACY_MODEL_PATTERN.test(model.toLowerCase());
    const tokenLimitParam: TokenLimitParam =
      this.tokenLimitOverride ??
      this.config.tokenLimitParam ??
      (this.officialEndpoint ? 'max_completion_tokens' : 'max_tokens');
    const maxTokens = this.config.maxTokens ?? (legacyModel ? LEGACY_MAX_TOKENS : DEFAULT_MAX_TOKENS);
    params[tokenLimitParam] = this.outputTokenCap === undefined ? maxTokens : Math.min(maxTokens, this.outputTokenCap);

    const effort = this.droppedParams.has('reasoning_effort') ? undefined : this.config.reasoningEffort;
    if (effort) {
      params.reasoning_effort = effort;
    }

    // Reasoning models reject temperature unless reasoning effort is 'none'.
    // Compatible endpoints keep it (Ollama, for one, defaults to 1.0 without it).
    const sendTemperature = !this.officialEndpoint || effort === 'none' || legacyModel;
    if (sendTemperature && !this.droppedParams.has('temperature')) {
      params.temperature = this.config.temperature ?? DEFAULT_TEMPERATURE;
    }
    return params;
  }

  /**
   * Drop or swap the field the server rejected. Returns false when the request
   * does not contain it, so there is nothing to retry.
   */
  private adjustParams(params: ChatParams, param: string): boolean {
    switch (param) {
      case 'max_tokens':
      case 'max_completion_tokens': {
        const value = params[param];
        if (value == null) return false;
        const other: TokenLimitParam = param === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
        delete params[param];
        params[other] = value;
        this.tokenLimitOverride = other;
        return true;
      }
      case 'temperature':
      case 'top_p':
      case 'reasoning_effort':
        if (params[param] == null) return false;
        delete params[param];
        this.droppedParams.add(param);
        return true;
      default:
        return false;
    }
  }
}

/** generate() as defined above; generateWithSystem() compares against it to detect overrides. */
const ownGenerate = OpenAIProvider.prototype.generate;

/**
 * Text of the first choice. Empty content is an OPENAI_EMPTY_RESPONSE error,
 * with `details.reason` set when the model refused or ran out of tokens.
 * Content cut off by the token limit is one too, with `details.partialText`:
 * a query missing its end (a WHERE clause, say) can still be valid SQL.
 */
function readContent(response: OpenAI.ChatCompletion, params: ChatParams): string {
  const choice = response.choices[0];
  const content = choice?.message?.content;
  const truncated = choice?.finish_reason === 'length';
  if (content && !truncated) {
    return content.trim();
  }

  const refusal = choice?.message?.refusal;
  if (refusal) {
    throw new TextToQueryError(
      `No response from OpenAI: the model refused the request ("${refusal}")`,
      'OPENAI_EMPTY_RESPONSE',
      { reason: 'refusal', refusal }
    );
  }
  if (truncated) {
    const limit = params.max_completion_tokens ?? params.max_tokens;
    const partialText = content ? content.trim() : '';
    if (partialText) {
      throw new TextToQueryError(
        `Incomplete response from OpenAI: the output token limit (${limit}) was reached before the response was finished, ` +
          'so it was not used. Reasoning tokens count toward this limit: increase maxTokens or use a lower reasoningEffort.',
        'OPENAI_EMPTY_RESPONSE',
        { reason: 'length', partialText }
      );
    }
    throw new TextToQueryError(
      `No response from OpenAI: the output token limit (${limit}) was reached before any text was written. ` +
        'Reasoning tokens count toward this limit: increase maxTokens or use a lower reasoningEffort.',
      'OPENAI_EMPTY_RESPONSE',
      { reason: 'length' }
    );
  }
  throw new TextToQueryError(
    'No response from OpenAI',
    'OPENAI_EMPTY_RESPONSE'
  );
}
