/**
 * Easy setup helpers for common use cases
 */

import { QueryGenerator } from '../generator';
import {
  TextToQueryConfig,
  LLMConfig,
  LLMProvider,
  SecurityConfig,
  DatabaseSchema,
  UserContext,
  QueryResult,
} from '../types';
import {
  PrismaAdapter,
  DatabaseIntrospectionAdapter,
  SchemaExtractionOptions,
} from '../adapters';

/** LLMConfig options that EasySetupConfig passes through (see LLMConfig). */
const LLM_OPTIONS = [
  'temperature',
  'maxTokens',
  'baseURL',
  'timeout',
  'maxRetries',
  'defaultHeaders',
  'reasoningEffort',
  'effort',
  'tokenLimitParam',
  'fallbacks',
  'promptCaching',
] as const;

/** TextToQueryConfig options that EasySetupConfig passes through (see TextToQueryConfig). */
const GENERATOR_OPTIONS = [
  'examples',
  'instructions',
  'identifierCheck',
  'maxCorrectionAttempts',
  'logger',
  'userContext',
] as const;

type EasySetupLLMOptions = Pick<LLMConfig, (typeof LLM_OPTIONS)[number]>;
type EasySetupGeneratorOptions = Pick<TextToQueryConfig, (typeof GENERATOR_OPTIONS)[number]>;

/**
 * Easy setup configuration. Besides the 0.0.1 fields it accepts the LLMConfig
 * options (temperature, maxTokens, baseURL, timeout, maxRetries,
 * defaultHeaders, reasoningEffort, effort, tokenLimitParam, fallbacks,
 * promptCaching) and the generator options (examples, instructions,
 * identifierCheck, maxCorrectionAttempts, logger, userContext), all optional.
 */
export interface EasySetupConfig extends EasySetupLLMOptions, EasySetupGeneratorOptions {
  llmProvider: LLMProvider;
  apiKey: string;
  model?: string;
  security?: SecurityConfig;
  debug?: boolean;
  /**
   * createChatbotFrom*() only: how many times ChatbotHelper asks the model to
   * repair a SELECT the database rejected (see ChatbotHelperOptions). Default 0.
   */
  repairAttempts?: number;
}

/** The `keys` of `source` whose value is not undefined. */
function pickDefined<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const picked: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return picked;
}

/**
 * The generator configuration for an easy-setup config and a schema. Only
 * options that are set are copied, so the generator and provider defaults
 * apply to the rest.
 */
function toGeneratorConfig(config: EasySetupConfig, schema: DatabaseSchema): TextToQueryConfig {
  return {
    llm: {
      provider: config.llmProvider,
      apiKey: config.apiKey,
      model: config.model,
      ...pickDefined(config, LLM_OPTIONS),
    },
    database: schema,
    security: config.security,
    debug: config.debug,
    ...pickDefined(config, GENERATOR_OPTIONS),
  };
}

/**
 * Create a query generator from Prisma client
 *
 * @example
 * ```typescript
 * const generator = await createFromPrisma(prisma, 'postgres', {
 *   llmProvider: 'claude',
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 * });
 * ```
 */
export async function createFromPrisma(
  prismaClient: any,
  databaseType: 'postgres' | 'mysql' | 'sqlite' | 'mssql',
  config: EasySetupConfig,
  options?: SchemaExtractionOptions
): Promise<QueryGenerator> {
  const adapter = new PrismaAdapter(prismaClient, databaseType, options);
  const schema = await adapter.extractSchema();

  return new QueryGenerator(toGeneratorConfig(config, schema));
}

/**
 * Create a query generator from direct database connection
 *
 * @example
 * ```typescript
 * import pg from 'pg';
 *
 * const pool = new pg.Pool({ ... });
 * const generator = await createFromDatabase(pool, 'postgres', {
 *   llmProvider: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY!,
 * });
 * ```
 */
export async function createFromDatabase(
  connection: any,
  databaseType: 'postgres' | 'mysql' | 'sqlite' | 'mssql',
  config: EasySetupConfig,
  options?: SchemaExtractionOptions
): Promise<QueryGenerator> {
  const adapter = new DatabaseIntrospectionAdapter(connection, databaseType, options);
  const schema = await adapter.extractSchema();

  return new QueryGenerator(toGeneratorConfig(config, schema));
}

/**
 * Options for ChatbotHelper.
 */
export interface ChatbotHelperOptions {
  /**
   * How many times to ask the model to repair a SELECT that the database
   * rejected with a schema or syntax error (unknown column or table, syntax
   * error, ...), executing each repaired query. Default 0 (off), because the
   * database error text is sent to the LLM.
   */
  repairAttempts?: number;
}

/**
 * Database errors worth a repair: unknown columns, tables and functions,
 * syntax errors, ambiguous names and grouping mistakes. Permission,
 * connection, timeout and data errors are not.
 */
const REPAIRABLE_CODES: ReadonlySet<string> = new Set([
  // Postgres SQLSTATE (pg `code`, Prisma `meta.code`)
  '42703', '42P01', '42601', '42883', '42702', '42803', '42804', '42P10',
  // mysql2 `code`
  'ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_PARSE_ERROR', 'ER_NON_UNIQ_ERROR',
  'ER_WRONG_FIELD_WITH_GROUP', 'ER_SP_DOES_NOT_EXIST', 'ER_FUNC_INEXISTENT_NAME_COLLISION',
]);
/** mysql2 `errno` values of the codes above. */
const REPAIRABLE_MYSQL_ERRNOS: ReadonlySet<number> = new Set([1054, 1146, 1064, 1052, 1055, 1305, 1630]);
/** SQL Server error numbers (mssql `number`). */
const REPAIRABLE_MSSQL_NUMBERS: ReadonlySet<number> = new Set([102, 156, 195, 207, 208, 209, 4104, 8120]);

const REPAIRABLE_MESSAGE = new RegExp(
  [
    'column .{1,200} does not exist',
    'relation .{1,200} does not exist',
    'function .{1,200} does not exist',
    'syntax error',
    'no such (?:column|table|function)',
    'ambiguous column',
    'column reference .{1,200} is ambiguous',
    'must appear in the GROUP BY clause',
    'misuse of aggregate',
    'unknown column',
    "table '.{1,200}' doesn't exist",
    'you have an error in your sql syntax',
    'invalid (?:column|object) name',
    'incorrect syntax near',
    'could not be bound',
    'is not a recognized built-in function',
    'is invalid in the select list',
    'missing from-clause entry',
  ].join('|'),
  'i'
);

/** Whether a database error is a schema or syntax error the model may be able to fix. */
function isRepairableError(error: any): boolean {
  if (!error) return false;
  for (const code of [error.code, error.sqlState, error.meta?.code]) {
    if (typeof code === 'string' && REPAIRABLE_CODES.has(code)) return true;
  }
  if (REPAIRABLE_MYSQL_ERRNOS.has(error.errno) || REPAIRABLE_MSSQL_NUMBERS.has(error.number)) return true;
  return REPAIRABLE_MESSAGE.test(String(error.message ?? error));
}

/** The text of a database error, with the driver's hint when it gives one. */
function errorText(error: any): string {
  const message = String(error?.message ?? error);
  return error?.hint ? `${message} (hint: ${error.hint})` : message;
}

/**
 * Create a complete chatbot with automatic query execution
 */
export class ChatbotHelper {
  private generator: QueryGenerator;
  private adapter: PrismaAdapter | DatabaseIntrospectionAdapter;
  private repairAttempts: number;

  /**
   * @param generator - Generates the queries
   * @param adapter - Executes them
   * @param options - Execution repair (off by default)
   */
  constructor(
    generator: QueryGenerator,
    adapter: PrismaAdapter | DatabaseIntrospectionAdapter,
    options: ChatbotHelperOptions = {}
  ) {
    this.generator = generator;
    this.adapter = adapter;
    const attempts = options.repairAttempts;
    this.repairAttempts = attempts !== undefined && Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0;
  }

  /**
   * Ask a question and get results
   */
  async ask(
    question: string,
    userContext?: UserContext
  ): Promise<{
    question: string;
    query: string;
    results: any[];
    metadata?: any;
    warnings?: string[];
  }> {
    // Generate query
    const queryResult = await this.generator.generateQuery(question, userContext);

    // Execute query (repairing it if that is enabled and it fails)
    const { result, results } = await this.execute(question, queryResult, userContext);

    return {
      question,
      query: result.query,
      results: Array.isArray(results) ? results : [results],
      metadata: result.metadata,
      warnings: result.warnings,
    };
  }

  /**
   * Ask with explanation
   */
  async askWithExplanation(
    question: string,
    userContext?: UserContext
  ): Promise<{
    question: string;
    query: string;
    explanation: string;
    results: any[];
    metadata?: any;
    warnings?: string[];
  }> {
    // Generate query with explanation
    const queryResult = await this.generator.generateQueryWithExplanation(
      question,
      userContext
    );

    // Execute query (repairing it if that is enabled and it fails)
    const { result, results } = await this.execute(question, queryResult, userContext);
    let explanation = queryResult.explanation || '';
    if (result !== queryResult) {
      // The query was repaired: explain the one that ran.
      explanation = await this.generator.explainQuery(result.query);
    }

    return {
      question,
      query: result.query,
      explanation,
      results: Array.isArray(results) ? results : [results],
      metadata: result.metadata,
      warnings: result.warnings,
    };
  }

  /**
   * Execute a generated query. With `repairAttempts`, a SELECT that fails with
   * a schema or syntax error is sent back to the model with the error and the
   * repaired query is executed instead. When a repair cannot be generated, the
   * database error is thrown.
   */
  private async execute(
    question: string,
    queryResult: QueryResult,
    userContext?: UserContext
  ): Promise<{ result: QueryResult; results: any }> {
    let result = queryResult;
    for (let attempt = 0; ; attempt++) {
      try {
        return { result, results: await this.adapter.executeQuery(result.query, result.parameters) };
      } catch (error: any) {
        const canRepair =
          attempt < this.repairAttempts &&
          result.metadata?.operation === 'SELECT' &&
          isRepairableError(error);
        if (!canRepair) throw error;
        try {
          result = await this.generator.repairQuery(question, result.query, errorText(error), userContext);
        } catch {
          throw error;
        }
      }
    }
  }
}

/**
 * Create a complete chatbot helper from Prisma
 */
export async function createChatbotFromPrisma(
  prismaClient: any,
  databaseType: 'postgres' | 'mysql' | 'sqlite' | 'mssql',
  config: EasySetupConfig,
  options?: SchemaExtractionOptions
): Promise<ChatbotHelper> {
  const adapter = new PrismaAdapter(prismaClient, databaseType, options);
  const schema = await adapter.extractSchema();

  const generator = new QueryGenerator(toGeneratorConfig(config, schema));
  return new ChatbotHelper(generator, adapter, { repairAttempts: config.repairAttempts });
}

/**
 * Create a complete chatbot helper from database connection
 */
export async function createChatbotFromDatabase(
  connection: any,
  databaseType: 'postgres' | 'mysql' | 'sqlite' | 'mssql',
  config: EasySetupConfig,
  options?: SchemaExtractionOptions
): Promise<ChatbotHelper> {
  const adapter = new DatabaseIntrospectionAdapter(connection, databaseType, options);
  const schema = await adapter.extractSchema();

  const generator = new QueryGenerator(toGeneratorConfig(config, schema));
  return new ChatbotHelper(generator, adapter, { repairAttempts: config.repairAttempts });
}
