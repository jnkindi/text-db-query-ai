import { DatabaseSchema, TableSchema, DatabaseType } from '../types';

/**
 * Database schema analyzer and formatter
 */
export class SchemaAnalyzer {
  private schema: DatabaseSchema;

  constructor(schema: DatabaseSchema) {
    this.schema = schema;
  }

  /**
   * Generate a human-readable schema description for the LLM
   */
  generateSchemaPrompt(): string {
    const { databaseType, tables } = this.schema;

    let prompt = `Database Type: ${databaseType.toUpperCase()}\n\n`;
    prompt += 'Available Tables:\n\n';

    for (const table of tables) {
      prompt += this.formatTableSchema(table);
      prompt += '\n';
    }

    return prompt;
  }

  /**
   * Format a single table schema
   */
  private formatTableSchema(table: TableSchema): string {
    let formatted = `Table: ${table.name}\n`;

    if (table.description) {
      formatted += `Description: ${table.description}\n`;
    }

    formatted += 'Columns:\n';
    for (const column of table.columns) {
      const nullable = column.nullable ? ' (nullable)' : ' (required)';
      const description = column.description ? ` - ${column.description}` : '';
      const sensitive = column.sensitive ? ' [SENSITIVE - DO NOT EXPOSE]' : '';
      formatted += `  - ${column.name}: ${column.type}${nullable}${description}${sensitive}\n`;
    }

    if (table.primaryKey) {
      formatted += `Primary Key: ${table.primaryKey}\n`;
    }

    if (table.foreignKeys && table.foreignKeys.length > 0) {
      formatted += 'Foreign Keys:\n';
      for (const fk of table.foreignKeys) {
        formatted += `  - ${fk.column} -> ${fk.referencedTable}.${fk.referencedColumn}\n`;
      }
    }

    return formatted;
  }

  /**
   * Find a table by name
   */
  findTable(tableName: string): TableSchema | undefined {
    return this.schema.tables.find(
      (t) => t.name.toLowerCase() === tableName.toLowerCase()
    );
  }

  /**
   * Get all table names
   */
  getTableNames(): string[] {
    return this.schema.tables.map((t) => t.name);
  }

  /**
   * Get sensitive columns across all tables
   */
  getSensitiveColumns(): { table: string; column: string }[] {
    const sensitive: { table: string; column: string }[] = [];

    for (const table of this.schema.tables) {
      for (const column of table.columns) {
        if (column.sensitive) {
          sensitive.push({ table: table.name, column: column.name });
        }
      }
    }

    return sensitive;
  }

  /**
   * Generate example queries for the schema
   */
  generateExampleQueries(): string[] {
    const examples: string[] = [];

    for (const table of this.schema.tables) {
      // Basic SELECT example
      const columns = table.columns
        .filter((c) => !c.sensitive)
        .map((c) => c.name)
        .slice(0, 3)
        .join(', ');

      if (columns) {
        examples.push(`SELECT ${columns} FROM ${table.name} LIMIT 10`);
      }

      // JOIN example if foreign keys exist
      if (table.foreignKeys && table.foreignKeys.length > 0) {
        const fk = table.foreignKeys[0];
        examples.push(
          `SELECT ${table.name}.* FROM ${table.name} JOIN ${fk.referencedTable} ON ${table.name}.${fk.column} = ${fk.referencedTable}.${fk.referencedColumn}`
        );
      }
    }

    return examples;
  }

  /**
   * Validate that tables exist in the schema
   */
  validateTables(tableNames: string[]): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    const schemaTableNames = this.getTableNames().map((t) => t.toLowerCase());

    for (const tableName of tableNames) {
      if (!schemaTableNames.includes(tableName.toLowerCase())) {
        missing.push(tableName);
      }
    }

    return {
      valid: missing.length === 0,
      missing,
    };
  }

  /**
   * Get the database type
   */
  getDatabaseType(): DatabaseType {
    return this.schema.databaseType;
  }

  /**
   * Generate database-specific query hints
   */
  getDatabaseHints(): string {
    switch (this.schema.databaseType) {
      case 'postgres':
        return 'Use PostgreSQL syntax. Support for RETURNING clause, JSON operators, and CTEs.';
      case 'mysql':
        return 'Use MySQL syntax. Backticks for identifiers, LIMIT syntax.';
      case 'sqlite':
        return 'Use SQLite syntax. Limited JOIN support, no RIGHT JOIN.';
      case 'mongodb':
        return 'Generate MongoDB aggregation pipeline or query syntax.';
      case 'mssql':
        return 'Use T-SQL syntax. Support for TOP, OFFSET-FETCH.';
      default:
        return 'Use standard SQL syntax.';
    }
  }
}
