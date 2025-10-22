/**
 * Supported LLM providers
 */
export type LLMProvider = 'openai' | 'claude';

/**
 * Supported database types
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
  primaryKey?: string;
  foreignKeys?: ForeignKeySchema[];
  description?: string;
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
}

/**
 * Foreign key relationship
 */
export interface ForeignKeySchema {
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

/**
 * Database schema
 */
export interface DatabaseSchema {
  tables: TableSchema[];
  databaseType: DatabaseType;
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
}

/**
 * LLM configuration
 */
export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Main configuration
 */
export interface TextToQueryConfig {
  llm: LLMConfig;
  database: DatabaseSchema;
  security?: SecurityConfig;
  userContext?: UserContext;
  debug?: boolean;
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
