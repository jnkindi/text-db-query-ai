/**
 * Easy setup helpers for common use cases
 */

import { QueryGenerator } from '../generator';
import { TextToQueryConfig, LLMProvider, SecurityConfig } from '../types';
import {
  SequelizeAdapter,
  PrismaAdapter,
  DatabaseIntrospectionAdapter,
  SchemaExtractionOptions,
} from '../adapters';

/**
 * Easy setup configuration
 */
export interface EasySetupConfig {
  llmProvider: LLMProvider;
  apiKey: string;
  model?: string;
  security?: SecurityConfig;
  debug?: boolean;
}

/**
 * Create a query generator from Sequelize models
 *
 * @example
 * ```typescript
 * const generator = await createFromSequelize(sequelize, {
 *   llmProvider: 'openai',
 *   apiKey: process.env.OPENAI_API_KEY!,
 * });
 * ```
 */
export async function createFromSequelize(
  sequelize: any,
  config: EasySetupConfig,
  options?: SchemaExtractionOptions
): Promise<QueryGenerator> {
  const adapter = new SequelizeAdapter(sequelize, options);
  const schema = await adapter.extractSchema();

  const generatorConfig: TextToQueryConfig = {
    llm: {
      provider: config.llmProvider,
      apiKey: config.apiKey,
      model: config.model,
    },
    database: schema,
    security: config.security,
    debug: config.debug,
  };

  return new QueryGenerator(generatorConfig);
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

  const generatorConfig: TextToQueryConfig = {
    llm: {
      provider: config.llmProvider,
      apiKey: config.apiKey,
      model: config.model,
    },
    database: schema,
    security: config.security,
    debug: config.debug,
  };

  return new QueryGenerator(generatorConfig);
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

  const generatorConfig: TextToQueryConfig = {
    llm: {
      provider: config.llmProvider,
      apiKey: config.apiKey,
      model: config.model,
    },
    database: schema,
    security: config.security,
    debug: config.debug,
  };

  return new QueryGenerator(generatorConfig);
}

/**
 * Create a complete chatbot with automatic query execution
 */
export class ChatbotHelper {
  private generator: QueryGenerator;
  private adapter: SequelizeAdapter | PrismaAdapter | DatabaseIntrospectionAdapter;

  constructor(
    generator: QueryGenerator,
    adapter: SequelizeAdapter | PrismaAdapter | DatabaseIntrospectionAdapter
  ) {
    this.generator = generator;
    this.adapter = adapter;
  }

  /**
   * Ask a question and get results
   */
  async ask(
    question: string,
    userContext?: { userId: string | number; role: string }
  ): Promise<{
    question: string;
    query: string;
    results: any[];
    metadata?: any;
    warnings?: string[];
  }> {
    // Generate query
    const queryResult = await this.generator.generateQuery(question, userContext);

    // Execute query
    const results = await this.adapter.executeQuery(queryResult.query, queryResult.parameters);

    return {
      question,
      query: queryResult.query,
      results: Array.isArray(results) ? results : [results],
      metadata: queryResult.metadata,
      warnings: queryResult.warnings,
    };
  }

  /**
   * Ask with explanation
   */
  async askWithExplanation(
    question: string,
    userContext?: { userId: string | number; role: string }
  ): Promise<{
    question: string;
    query: string;
    explanation: string;
    results: any[];
  }> {
    // Generate query with explanation
    const queryResult = await this.generator.generateQueryWithExplanation(
      question,
      userContext
    );

    // Execute query
    const results = await this.adapter.executeQuery(queryResult.query, queryResult.parameters);

    return {
      question,
      query: queryResult.query,
      explanation: queryResult.explanation || '',
      results: Array.isArray(results) ? results : [results],
    };
  }
}

/**
 * Create a complete chatbot helper from Sequelize
 */
export async function createChatbotFromSequelize(
  sequelize: any,
  config: EasySetupConfig,
  options?: SchemaExtractionOptions
): Promise<ChatbotHelper> {
  const adapter = new SequelizeAdapter(sequelize, options);
  const schema = await adapter.extractSchema();

  const generatorConfig: TextToQueryConfig = {
    llm: {
      provider: config.llmProvider,
      apiKey: config.apiKey,
      model: config.model,
    },
    database: schema,
    security: config.security,
    debug: config.debug,
  };

  const generator = new QueryGenerator(generatorConfig);
  return new ChatbotHelper(generator, adapter);
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

  const generatorConfig: TextToQueryConfig = {
    llm: {
      provider: config.llmProvider,
      apiKey: config.apiKey,
      model: config.model,
    },
    database: schema,
    security: config.security,
    debug: config.debug,
  };

  const generator = new QueryGenerator(generatorConfig);
  return new ChatbotHelper(generator, adapter);
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

  const generatorConfig: TextToQueryConfig = {
    llm: {
      provider: config.llmProvider,
      apiKey: config.apiKey,
      model: config.model,
    },
    database: schema,
    security: config.security,
    debug: config.debug,
  };

  const generator = new QueryGenerator(generatorConfig);
  return new ChatbotHelper(generator, adapter);
}
