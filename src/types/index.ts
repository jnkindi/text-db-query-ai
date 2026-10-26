import type { BaseLLMProvider } from '../providers/base';

/**
 * Supported LLM providers
 */
export type LLMProvider = 'openai' | 'claude';

/**
 * Supported database types.
 *
 * `'mongodb'` is accepted for backwards compatibility only: the package
 * generates SQL and does not support MongoDB.
 */
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'mongodb' | 'mssql';

/**
 * Query operation types
 */
export type QueryOperation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/**
 * User context for security and personalization
 */
export interface UserContext {
  userId: string | number;
  role: string;
  permissions?: string[];
  metadata?: Record<string, any>;
}

/**
 * Database table schema definition
 */
export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  /** Primary key column. For composite keys, the columns joined with ", ". */
  primaryKey?: string;
  /** All primary key columns, in key order. */
  primaryKeyColumns?: string[];
  foreignKeys?: ForeignKeySchema[];
  description?: string;
  /** Schema (namespace) the table belongs to, e.g. "public" or "dbo". */
  schema?: string;
}

/**
 * Column schema definition
 */
export interface ColumnSchema {
  name: string;
  type: string;
  nullable?: boolean;
  description?: string;
  sensitive?: boolean; // Mark sensitive columns like passwords, SSN, etc.
  /** Type exactly as the database reports it, e.g. "uuid", "jsonb", "varchar(255)". */
  nativeType?: string;
  /** Allowed values for enum-like columns. Shown to the model so it does not invent literals. */
  enumValues?: string[];
  /** Example values shown to the model. Never filled automatically; do not put sensitive data here. */
  sampleValues?: Array<string | number | boolean | null>;
}

/**
 * Foreign key relationship
 */
export interface ForeignKeySchema {
  column: string;
  referencedTable: string;
  referencedColumn: string;
  /** Schema (namespace) of the referenced table, when it differs from the table's own. */
  referencedSchema?: string;
}

/**
 * Database schema
 */
export interface DatabaseSchema {
  tables: TableSchema[];
  databaseType: DatabaseType;
  /**
   * Table and column names match the database exactly, including case. The
   * introspection adapters and parsePrismaSchema set it. When it is not set,
   * a Postgres name that differs from a plain name only by its uppercase
   * letters (`Users`) is written unquoted, as in 0.0.1, since hand-written
   * schemas often capitalize lowercase tables; set it for tables really
   * created with mixed case, such as Prisma's "User".
   */
  exactNames?: boolean;
}

/**
 * Security configuration
 */
export interface SecurityConfig {
  allowedOperations?: QueryOperation[];
  allowedTables?: string[];
  restrictedColumns?: string[];
  maxRowLimit?: number;
  requireUserContext?: boolean;
  enableRowLevelSecurity?: boolean;
  customValidator?: (query: string, context?: UserContext) => Promise<boolean>;
  /** Allow UNION / UNION ALL. Blocked by default, as in 0.0.1. */
  allowUnion?: boolean;
  /** Extra function names to block (case-insensitive), added to DEFAULT_BLOCKED_FUNCTIONS. A trailing "*" matches a prefix. */
  blockedFunctions?: string[];
  /** Function names to allow even though DEFAULT_BLOCKED_FUNCTIONS lists them. */
  allowedFunctions?: string[];
  /** Column that row-level security filters on. Default "user_id". */
  rowLevelSecurityColumn?: string;
  /** Reject queries that read schema columns marked `sensitive: true` (default: warn only). */
  enforceSensitiveColumns?: boolean;
  /**
   * How a bare restrictedColumns entry (one without a table) matches column
   * names, case-insensitively. 'contains' (default, as in 0.0.1): `password`
   * restricts password, password_hash and password_updated_at. 'exact': only
   * a column named password. Entries of the form `table.column` always match
   * that column of that table exactly. Strings and comments never match.
   */
  restrictedColumnsMatch?: 'contains' | 'exact';
}

/**
 * Reasoning effort for OpenAI reasoning models (sent as `reasoning_effort`).
 */
export type OpenAIReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Effort level for Claude models (sent as `output_config.effort`).
 */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * LLM configuration
 */
export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  /** Model ID. Defaults: "claude-opus-5-5" for claude, "gpt-6-luna" for openai. */
  model?: string;
  /**
   * Sampling temperature. Sent only to OpenAI models that accept it (gpt-4o, gpt-4.1,
   * custom `baseURL` endpoints, or `reasoningEffort: 'none'`). Ignored for Claude,
   * whose current API rejects sampling parameters.
   */
  temperature?: number;
  /** Maximum output tokens. On reasoning models this includes thinking tokens. */
  maxTokens?: number;
  /** API base URL, for OpenAI-compatible endpoints, proxies and gateways. */
  baseURL?: string;
  /** Request timeout in milliseconds. */
  timeout?: number;
  /** Automatic retries on connection errors, 429 and 5xx responses (SDK default: 2). */
  maxRetries?: number;
  /** Extra HTTP headers sent with every request. */
  defaultHeaders?: Record<string, string>;
  /** OpenAI only: reasoning effort for reasoning models. */
  reasoningEffort?: OpenAIReasoningEffort;
  /** Claude only: effort level (output_config.effort). */
  effort?: ClaudeEffort;
  /**
   * OpenAI only: which token limit field to send. Default: "max_completion_tokens"
   * for api.openai.com, "max_tokens" when `baseURL` points elsewhere.
   */
  tokenLimitParam?: 'max_tokens' | 'max_completion_tokens';
  /**
   * Claude only: if the model declines a request, let the API re-run it on
   * Anthropic's recommended fallback model. Default: true unless `baseURL` is set.
   */
  fallbacks?: boolean;
  /** Claude only: cache the static part of the prompt (rules and schema). Default: true. */
  promptCaching?: boolean;
}

/**
 * A question with the SQL that correctly answers it, used as a few-shot example.
 */
export interface QueryExample {
  question: string;
  sql: string;
}

/**
 * What to do when generated SQL references tables or columns that are not in the schema.
 * - off: no check
 * - warn: add warnings to the result
 * - retry: ask the model to correct the query, then warn if issues remain (default)
 * - strict: ask the model to correct the query, then throw if issues remain
 */
export type IdentifierCheckMode = 'off' | 'warn' | 'retry' | 'strict';

/**
 * Main configuration
 */
export interface TextToQueryConfig {
  llm: LLMConfig;
  database: DatabaseSchema;
  security?: SecurityConfig;
  userContext?: UserContext;
  debug?: boolean;
  /** Use this provider instead of creating one from `llm` (custom providers, tests). */
  llmProvider?: BaseLLMProvider;
  /** Question/SQL pairs shown to the model as examples. */
  examples?: QueryExample[];
  /** Domain knowledge for the model, e.g. "revenue means SUM(order_items.price * quantity)". */
  instructions?: string;
  /** Check generated SQL against the schema. Default: "retry". */
  identifierCheck?: IdentifierCheckMode;
  /** How many times to ask the model to fix invalid SQL or unknown identifiers. Default: 1. */
  maxCorrectionAttempts?: number;
  /** Receives debug messages when `debug` is true. Default: console.log. */
  logger?: (message: string) => void;
}

/**
 * Query result
 */
export interface QueryResult {
  query: string;
  parameters?: any[];
  explanation?: string;
  warnings?: string[];
  metadata?: {
    operation: QueryOperation;
    tables: string[];
    estimatedComplexity?: 'low' | 'medium' | 'high';
    /** Number of model calls used to produce the query (1 when no correction was needed). */
    attempts?: number;
    /** Tables or columns in the query that the schema does not contain. */
    unknownIdentifiers?: string[];
  };
}

/**
 * Error types
 */
export class TextToQueryError extends Error {
  constructor(message: string, public code: string, public details?: any) {
    super(message);
    this.name = 'TextToQueryError';
  }
}
