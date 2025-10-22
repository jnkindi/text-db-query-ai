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
  includeTables?: string[];
  excludeTables?: string[];
  markSensitiveColumns?: string[];
  includeDescriptions?: boolean;
}
