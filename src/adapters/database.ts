/**
 * Direct Database Introspection Adapter
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
 * Database connection configuration
 */
export interface DatabaseConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  type: DatabaseType;
}

/**
 * Direct database introspection adapter
 * Works with any database connection without requiring an ORM
 */
export class DatabaseIntrospectionAdapter implements ORMAdapter {
  private connection: any;
  private databaseType: DatabaseType;
  private options: SchemaExtractionOptions;

  constructor(
    connection: any,
    databaseType: DatabaseType,
    options: SchemaExtractionOptions = {}
  ) {
    this.connection = connection;
    this.databaseType = databaseType;
    this.options = options;
  }

  /**
   * Extract schema from database by introspection
   */
  async extractSchema(): Promise<DatabaseSchema> {
    const tables: TableSchema[] = [];

    try {
      const tableNames = await this.getTableNames();

      for (const tableName of tableNames) {
        if (this.options.includeTables && !this.options.includeTables.includes(tableName)) {
          continue;
        }

        if (this.options.excludeTables && this.options.excludeTables.includes(tableName)) {
          continue;
        }

        const columns = await this.getTableColumns(tableName);
        const foreignKeys = await this.getForeignKeys(tableName);
        const primaryKey = await this.getPrimaryKey(tableName);

        tables.push({
          name: tableName,
          columns,
          primaryKey,
          foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
        });
      }
    } catch (error: any) {
      throw new Error(`Failed to introspect database: ${error.message}`);
    }

    return {
      databaseType: this.databaseType,
      tables,
    };
  }

  /**
   * Execute a query
   */
  async executeQuery(query: string, parameters?: any[]): Promise<any> {
    if (this.connection.query) {
      // pg, mysql2
      const result = await this.connection.query(query, parameters);
      return result.rows || result[0]; // pg returns .rows, mysql returns array
    } else if (this.connection.all) {
      // sqlite3
      return new Promise((resolve, reject) => {
        this.connection.all(query, parameters || [], (err: any, rows: any) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    } else {
      throw new Error('Unsupported connection type');
    }
  }

  /**
   * Get database type
   */
  getDatabaseType(): string {
    return this.databaseType;
  }

  /**
   * Get all table names
   */
  private async getTableNames(): Promise<string[]> {
    let query: string;

    switch (this.databaseType) {
      case 'postgres':
        query = `
          SELECT tablename as table_name
          FROM pg_tables
          WHERE schemaname = 'public'
          ORDER BY tablename
        `;
        break;
      case 'mysql':
        query = `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = DATABASE()
          ORDER BY table_name
        `;
        break;
      case 'sqlite':
        query = `
          SELECT name as table_name
          FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `;
        break;
      case 'mssql':
        query = `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_type = 'BASE TABLE'
          ORDER BY table_name
        `;
        break;
      default:
        throw new Error(`Unsupported database type: ${this.databaseType}`);
    }

    const result = await this.executeQuery(query);
    return result.map((row: any) => row.table_name || row.tablename);
  }

  /**
   * Get columns for a table
   */
  private async getTableColumns(tableName: string): Promise<ColumnSchema[]> {
    let query: string;

    switch (this.databaseType) {
      case 'postgres':
        query = `
          SELECT
            column_name,
            data_type,
            is_nullable,
            column_default,
            character_maximum_length
          FROM information_schema.columns
          WHERE table_name = $1
            AND table_schema = 'public'
          ORDER BY ordinal_position
        `;
        break;
      case 'mysql':
        query = `
          SELECT
            column_name,
            data_type,
            is_nullable,
            column_default,
            character_maximum_length
          FROM information_schema.columns
          WHERE table_name = ?
            AND table_schema = DATABASE()
          ORDER BY ordinal_position
        `;
        break;
      case 'sqlite':
        query = `PRAGMA table_info(${tableName})`;
        break;
      case 'mssql':
        query = `
          SELECT
            column_name,
            data_type,
            is_nullable
          FROM information_schema.columns
          WHERE table_name = @tableName
          ORDER BY ordinal_position
        `;
        break;
      default:
        throw new Error(`Unsupported database type: ${this.databaseType}`);
    }

    const result = await this.executeQuery(
      query,
      this.databaseType === 'sqlite' ? [] : [tableName]
    );

    return result.map((row: any) => {
      const columnName = row.column_name || row.name;
      const isSensitive = this.options.markSensitiveColumns?.some((pattern) =>
        columnName.toLowerCase().includes(pattern.toLowerCase())
      ) || false;

      return {
        name: columnName,
        type: this.normalizeDataType(row.data_type || row.type),
        nullable: row.is_nullable === 'YES' || row.notnull === 0,
        sensitive: isSensitive,
      };
    });
  }

  /**
   * Get foreign keys for a table
   */
  private async getForeignKeys(tableName: string): Promise<ForeignKeySchema[]> {
    let query: string;

    try {
      switch (this.databaseType) {
        case 'postgres':
          query = `
            SELECT
              kcu.column_name,
              ccu.table_name AS referenced_table,
              ccu.column_name AS referenced_column
            FROM information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
              ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage AS ccu
              ON ccu.constraint_name = tc.constraint_name
              AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_name = $1
          `;
          break;
        case 'mysql':
          query = `
            SELECT
              column_name,
              referenced_table_name AS referenced_table,
              referenced_column_name AS referenced_column
            FROM information_schema.key_column_usage
            WHERE table_name = ?
              AND referenced_table_name IS NOT NULL
              AND table_schema = DATABASE()
          `;
          break;
        case 'sqlite':
          query = `PRAGMA foreign_key_list(${tableName})`;
          break;
        default:
          return [];
      }

      const result = await this.executeQuery(
        query,
        this.databaseType === 'sqlite' ? [] : [tableName]
      );

      return result.map((row: any) => ({
        column: row.column_name || row.from,
        referencedTable: row.referenced_table || row.table,
        referencedColumn: row.referenced_column || row.to,
      }));
    } catch (error) {
      return [];
    }
  }

  /**
   * Get primary key for a table
   */
  private async getPrimaryKey(tableName: string): Promise<string | undefined> {
    let query: string;

    try {
      switch (this.databaseType) {
        case 'postgres':
          query = `
            SELECT a.attname as column_name
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid
              AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = $1::regclass
              AND i.indisprimary
          `;
          break;
        case 'mysql':
          query = `
            SELECT column_name
            FROM information_schema.key_column_usage
            WHERE table_name = ?
              AND constraint_name = 'PRIMARY'
              AND table_schema = DATABASE()
            LIMIT 1
          `;
          break;
        case 'sqlite':
          query = `PRAGMA table_info(${tableName})`;
          break;
        default:
          return undefined;
      }

      const result = await this.executeQuery(
        query,
        this.databaseType === 'sqlite' ? [] : [tableName]
      );

      if (this.databaseType === 'sqlite') {
        const pkColumn = result.find((row: any) => row.pk === 1);
        return pkColumn?.name;
      }

      return result[0]?.column_name;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Normalize data types
   */
  private normalizeDataType(type: string): string {
    const lowerType = type.toLowerCase();

    if (lowerType.includes('int')) return 'integer';
    if (lowerType.includes('char') || lowerType.includes('varchar')) return 'varchar';
    if (lowerType.includes('text')) return 'text';
    if (lowerType.includes('bool')) return 'boolean';
    if (lowerType.includes('timestamp') || lowerType.includes('datetime')) return 'timestamp';
    if (lowerType.includes('date')) return 'date';
    if (lowerType.includes('decimal') || lowerType.includes('numeric')) return 'decimal';
    if (lowerType.includes('float') || lowerType.includes('double')) return 'decimal';
    if (lowerType.includes('json')) return 'json';

    return 'varchar';
  }
}

/**
 * Create a database introspection adapter
 */
export function createDatabaseAdapter(
  connection: any,
  databaseType: DatabaseType,
  options?: SchemaExtractionOptions
): DatabaseIntrospectionAdapter {
  return new DatabaseIntrospectionAdapter(connection, databaseType, options);
}
