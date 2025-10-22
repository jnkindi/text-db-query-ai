/**
 * Text to Database Query AI
 *
 * A secure, intelligent text-to-database query converter with LLM integration
 * for building AI-powered chatbots and natural language database interfaces.
 *
 * @packageDocumentation
 */

import { QueryGenerator as QG } from './generator';
import { SecurityValidator as SV, QuerySanitizer as QS } from './security';
import { SchemaAnalyzer as SA } from './schema';
import { createLLMProvider as createProvider } from './providers';

// Core exports
export { QueryGenerator } from './generator';
export { SecurityValidator, QuerySanitizer } from './security';
export { SchemaAnalyzer } from './schema';
export { createLLMProvider, BaseLLMProvider, OpenAIProvider, ClaudeProvider } from './providers';

// ORM Adapters
export {
  SequelizeAdapter,
  createSequelizeAdapter,
  PrismaAdapter,
  createPrismaAdapter,
  parsePrismaSchema,
  DatabaseIntrospectionAdapter,
  createDatabaseAdapter,
} from './adapters';

export type { ORMAdapter, SchemaExtractionOptions } from './adapters';

// Easy setup helpers
export {
  createFromSequelize,
  createFromPrisma,
  createFromDatabase,
  createChatbotFromSequelize,
  createChatbotFromPrisma,
  createChatbotFromDatabase,
  ChatbotHelper,
} from './helpers';

export type { EasySetupConfig } from './helpers';

// Types
export {
  LLMProvider,
  DatabaseType,
  QueryOperation,
  UserContext,
  TableSchema,
  ColumnSchema,
  ForeignKeySchema,
  DatabaseSchema,
  SecurityConfig,
  LLMConfig,
  TextToQueryConfig,
  QueryResult,
  TextToQueryError,
} from './types';

/**
 * Create a new query generator instance
 *
 * @param config - Configuration for the query generator
 * @returns A new QueryGenerator instance
 *
 * @example
 * ```typescript
 * import { createQueryGenerator } from 'text-db-query-ai';
 *
 * const generator = createQueryGenerator({
 *   llm: {
 *     provider: 'openai',
 *     apiKey: process.env.OPENAI_API_KEY!,
 *   },
 *   database: {
 *     databaseType: 'postgres',
 *     tables: [...],
 *   },
 *   security: {
 *     allowedOperations: ['SELECT'],
 *     maxRowLimit: 100,
 *   },
 * });
 * ```
 */
export function createQueryGenerator(config: import('./types').TextToQueryConfig) {
  return new QG(config);
}

// Default export
export default {
  QueryGenerator: QG,
  createQueryGenerator,
  SecurityValidator: SV,
  QuerySanitizer: QS,
  SchemaAnalyzer: SA,
  createLLMProvider: createProvider,
};
