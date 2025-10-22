/**
 * Sequelize ORM Adapter
 */

import {
  DatabaseSchema,
  TableSchema,
  ColumnSchema,
  ForeignKeySchema,
  DatabaseType,
} from '../types';
import { ORMAdapter, SchemaExtractionOptions } from './types';

/**
 * Sequelize adapter for automatic schema extraction and query execution
 */
export class SequelizeAdapter implements ORMAdapter {
  private sequelize: any;
  private options: SchemaExtractionOptions;

  constructor(sequelize: any, options: SchemaExtractionOptions = {}) {
    this.sequelize = sequelize;
    this.options = options;
  }

  /**
   * Extract schema from Sequelize models
   */
  async extractSchema(): Promise<DatabaseSchema> {
    const models = this.sequelize.models;
    const tables: TableSchema[] = [];

    for (const modelName in models) {
      const model = models[modelName];

      // Check if table should be included
      if (this.options.includeTables && !this.options.includeTables.includes(model.tableName)) {
        continue;
      }

      if (this.options.excludeTables && this.options.excludeTables.includes(model.tableName)) {
        continue;
      }

      const columns: ColumnSchema[] = [];
      const foreignKeys: ForeignKeySchema[] = [];
      let primaryKey: string | undefined;

      // Extract columns from model attributes
      const attributes = model.rawAttributes;

      for (const attrName in attributes) {
        const attr = attributes[attrName];

        // Determine if column is sensitive
        const isSensitive = this.options.markSensitiveColumns?.some((pattern) =>
          attrName.toLowerCase().includes(pattern.toLowerCase())
        ) || false;

        columns.push({
          name: attr.field || attrName,
          type: this.mapSequelizeType(attr.type),
          nullable: attr.allowNull !== false,
          description: attr.comment || (this.options.includeDescriptions ? attrName : undefined),
          sensitive: isSensitive,
        });

        // Check if primary key
        if (attr.primaryKey) {
          primaryKey = attr.field || attrName;
        }

        // Check for foreign keys
        if (attr.references) {
          foreignKeys.push({
            column: attr.field || attrName,
            referencedTable: attr.references.model,
            referencedColumn: attr.references.key,
          });
        }
      }

      tables.push({
        name: model.tableName,
        columns,
        primaryKey,
        foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
        description: model.options.comment || undefined,
      });
    }

    return {
      databaseType: this.mapDatabaseType(this.sequelize.getDialect()),
      tables,
    };
  }

  /**
   * Execute a query using Sequelize
   */
  async executeQuery(query: string, parameters?: any[]): Promise<any> {
    const results = await this.sequelize.query(query, {
      replacements: parameters,
      type: this.sequelize.QueryTypes.SELECT,
    });
    return results;
  }

  /**
   * Get the database type
   */
  getDatabaseType(): string {
    return this.sequelize.getDialect();
  }

  /**
   * Map Sequelize data types to standard SQL types
   */
  private mapSequelizeType(type: any): string {
    const typeString = type.toString().toLowerCase();

    if (typeString.includes('integer') || typeString.includes('bigint')) return 'integer';
    if (typeString.includes('string') || typeString.includes('char')) return 'varchar';
    if (typeString.includes('text')) return 'text';
    if (typeString.includes('boolean')) return 'boolean';
    if (typeString.includes('date')) return 'timestamp';
    if (typeString.includes('decimal') || typeString.includes('float')) return 'decimal';
    if (typeString.includes('json')) return 'json';
    if (typeString.includes('blob')) return 'blob';

    return 'varchar'; // Default fallback
  }

  /**
   * Map Sequelize dialect to DatabaseType
   */
  private mapDatabaseType(dialect: string): DatabaseType {
    switch (dialect) {
      case 'postgres':
        return 'postgres';
      case 'mysql':
      case 'mariadb':
        return 'mysql';
      case 'sqlite':
        return 'sqlite';
      case 'mssql':
        return 'mssql';
      default:
        return 'postgres';
    }
  }
}

/**
 * Helper function to create a Sequelize adapter
 */
export function createSequelizeAdapter(
  sequelize: any,
  options?: SchemaExtractionOptions
): SequelizeAdapter {
  return new SequelizeAdapter(sequelize, options);
}
