/**
 * ORM adapter types
 */

import { DatabaseSchema } from '../types';

/**
 * Base interface for ORM adapters
 */
export interface ORMAdapter {
  /**
   * Extract database schema from the ORM
   */
  extractSchema(): Promise<DatabaseSchema>;

  /**
   * Execute a raw SQL query using the ORM
   */
  executeQuery(query: string, parameters?: any[]): Promise<any>;

  /**
   * Get the database type
   */
  getDatabaseType(): string;
}

/**
 * Options for schema extraction
 */
export interface SchemaExtractionOptions {
  /** Only extract these tables (exact, case-sensitive names). */
  includeTables?: string[];
  /** Skip these tables (exact, case-sensitive names). */
  excludeTables?: string[];
  /** Mark columns whose name contains one of these strings (case-insensitive) as sensitive. */
  markSensitiveColumns?: string[];
  /** Copy table and column comments into `description`. Default: true. */
  includeDescriptions?: boolean;
  /**
   * Schema (namespace) to read. Default: "public" for postgres, "dbo" for mssql,
   * the current database (`DATABASE()`) for mysql. Ignored for sqlite.
   */
  schema?: string;
  /** Read the allowed values of enum columns into `enumValues`. Default: true. */
  includeEnumValues?: boolean;
}

/**
 * Runs one introspection query and resolves to its rows.
 *
 * Placeholders follow the database: `$1` for postgres, `?` for mysql and sqlite,
 * `@P1` for mssql. Row keys may come back in any case.
 */
export type IntrospectionExecutor = (
  sql: string,
  params?: unknown[]
) => Promise<Record<string, unknown>[]>;
