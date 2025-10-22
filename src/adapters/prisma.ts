/**
 * Prisma ORM Adapter
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
 * Prisma adapter for automatic schema extraction and query execution
 */
export class PrismaAdapter implements ORMAdapter {
  private prisma: any;
  private databaseType: DatabaseType;
  private options: SchemaExtractionOptions;

  constructor(
    prisma: any,
    databaseType: DatabaseType = 'postgres',
    options: SchemaExtractionOptions = {}
  ) {
    this.prisma = prisma;
    this.databaseType = databaseType;
    this.options = options;
  }

  /**
   * Extract schema from Prisma by introspecting the database
   */
  async extractSchema(): Promise<DatabaseSchema> {
    // Use Prisma's introspection capabilities
    const tables: TableSchema[] = [];

    try {
      // Get table information using Prisma's raw query capability
      const tableNames = await this.getTableNames();

      for (const tableName of tableNames) {
        // Check if table should be included
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
      throw new Error(`Failed to extract Prisma schema: ${error.message}`);
    }

    return {
      databaseType: this.databaseType,
      tables,
    };
  }

  /**
   * Execute a raw SQL query using Prisma
   */
  async executeQuery(query: string, parameters?: any[]): Promise<any> {
    try {
      // Use Prisma's $queryRawUnsafe for parameterized queries
      if (parameters && parameters.length > 0) {
        return await this.prisma.$queryRaw`${query}`;
      }
      // Use $queryRawUnsafe for non-parameterized queries
      return await this.prisma.$queryRawUnsafe(query);
    } catch (error: any) {
      throw new Error(`Failed to execute query: ${error.message}`);
    }
  }

  /**
   * Get the database type
   */
  getDatabaseType(): string {
    return this.databaseType;
  }

  /**
   * Get all table names from the database
   */
  private async getTableNames(): Promise<string[]> {
    let query: string;

    switch (this.databaseType) {
      case 'postgres':
        query = `
          SELECT tablename as table_name
          FROM pg_tables
          WHERE schemaname = 'public'
        `;
        break;
      case 'mysql':
        query = `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = DATABASE()
        `;
        break;
      case 'sqlite':
        query = `
          SELECT name as table_name
          FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        `;
        break;
      default:
        query = `
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
        `;
    }

    const result: any[] = await this.prisma.$queryRawUnsafe(query);
    return result.map((row) => row.table_name || row.tablename);
  }

  /**
   * Get columns for a specific table
   */
  private async getTableColumns(tableName: string): Promise<ColumnSchema[]> {
    let query: string;

    switch (this.databaseType) {
      case 'postgres':
        query = `
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = '${tableName}' AND table_schema = 'public'
          ORDER BY ordinal_position
        `;
        break;
      case 'mysql':
        query = `
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = '${tableName}' AND table_schema = DATABASE()
          ORDER BY ordinal_position
        `;
        break;
      case 'sqlite':
        query = `PRAGMA table_info(${tableName})`;
        break;
      default:
        query = `
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_name = '${tableName}'
        `;
    }

    const result: any[] = await this.prisma.$queryRawUnsafe(query);

    return result.map((row) => {
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
   * Get foreign keys for a specific table
   */
  private async getForeignKeys(tableName: string): Promise<ForeignKeySchema[]> {
    let query: string;
    const foreignKeys: ForeignKeySchema[] = [];

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
            JOIN information_schema.constraint_column_usage AS ccu
              ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_name = '${tableName}'
          `;
          break;
        case 'mysql':
          query = `
            SELECT
              column_name,
              referenced_table_name AS referenced_table,
              referenced_column_name AS referenced_column
            FROM information_schema.key_column_usage
            WHERE table_name = '${tableName}'
              AND referenced_table_name IS NOT NULL
              AND table_schema = DATABASE()
          `;
          break;
        case 'sqlite':
          query = `PRAGMA foreign_key_list(${tableName})`;
          break;
        default:
          return foreignKeys;
      }

      const result: any[] = await this.prisma.$queryRawUnsafe(query);

      return result.map((row) => ({
        column: row.column_name || row.from,
        referencedTable: row.referenced_table || row.table,
        referencedColumn: row.referenced_column || row.to,
      }));
    } catch (error) {
      // Foreign keys might not be available, return empty array
      return foreignKeys;
    }
  }

  /**
   * Get primary key for a specific table
   */
  private async getPrimaryKey(tableName: string): Promise<string | undefined> {
    let query: string;

    try {
      switch (this.databaseType) {
        case 'postgres':
          query = `
            SELECT a.attname as column_name
            FROM pg_index i
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = '${tableName}'::regclass AND i.indisprimary
          `;
          break;
        case 'mysql':
          query = `
            SELECT column_name
            FROM information_schema.key_column_usage
            WHERE table_name = '${tableName}'
              AND constraint_name = 'PRIMARY'
              AND table_schema = DATABASE()
          `;
          break;
        case 'sqlite':
          query = `PRAGMA table_info(${tableName})`;
          break;
        default:
          return undefined;
      }

      const result: any[] = await this.prisma.$queryRawUnsafe(query);

      if (this.databaseType === 'sqlite') {
        const pkColumn = result.find((row) => row.pk === 1);
        return pkColumn?.name;
      }

      return result[0]?.column_name;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Normalize data types to standard SQL types
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
 * Helper function to create a Prisma adapter from Prisma schema
 */
export function createPrismaAdapter(
  prismaClient: any,
  databaseType?: DatabaseType,
  options?: SchemaExtractionOptions
): PrismaAdapter {
  return new PrismaAdapter(prismaClient, databaseType, options);
}

/**
 * Helper to extract schema from prisma.schema file
 */
export function parsePrismaSchema(schemaContent: string): DatabaseSchema {
  const tables: TableSchema[] = [];
  let databaseType: DatabaseType = 'postgres';

  // Parse datasource to get database type
  const datasourceMatch = schemaContent.match(/datasource\s+\w+\s+\{[^}]*provider\s*=\s*"(\w+)"/);
  if (datasourceMatch) {
    const provider = datasourceMatch[1];
    if (provider === 'postgresql') databaseType = 'postgres';
    else if (provider === 'mysql') databaseType = 'mysql';
    else if (provider === 'sqlite') databaseType = 'sqlite';
    else if (provider === 'sqlserver') databaseType = 'mssql';
  }

  // Parse models
  const modelRegex = /model\s+(\w+)\s+\{([^}]+)\}/g;
  let modelMatch;

  while ((modelMatch = modelRegex.exec(schemaContent)) !== null) {
    const modelName = modelMatch[1];
    const modelBody = modelMatch[2];
    const columns: ColumnSchema[] = [];
    const foreignKeys: ForeignKeySchema[] = [];
    let primaryKey: string | undefined;

    // Parse fields
    const fieldRegex = /(\w+)\s+(\w+)(\??)/gm;
    let fieldMatch;

    while ((fieldMatch = fieldRegex.exec(modelBody)) !== null) {
      const fieldName = fieldMatch[1];
      const fieldType = fieldMatch[2];
      const isOptional = fieldMatch[3] === '?';

      // Skip relation fields and attributes
      if (fieldName.startsWith('@') || fieldName.startsWith('@@')) continue;

      // Check if it's a primary key
      if (modelBody.includes(`${fieldName}`) && modelBody.includes('@id')) {
        primaryKey = fieldName;
      }

      columns.push({
        name: fieldName,
        type: mapPrismaType(fieldType),
        nullable: isOptional,
      });
    }

    tables.push({
      name: modelName.toLowerCase(),
      columns,
      primaryKey,
      foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
    });
  }

  return {
    databaseType,
    tables,
  };
}

/**
 * Map Prisma types to SQL types
 */
function mapPrismaType(type: string): string {
  switch (type) {
    case 'Int':
    case 'BigInt':
      return 'integer';
    case 'String':
      return 'varchar';
    case 'Boolean':
      return 'boolean';
    case 'DateTime':
      return 'timestamp';
    case 'Float':
    case 'Decimal':
      return 'decimal';
    case 'Json':
      return 'json';
    default:
      return 'varchar';
  }
}
