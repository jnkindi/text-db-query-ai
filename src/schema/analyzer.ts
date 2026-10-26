import { DatabaseSchema, TableSchema, ColumnSchema, DatabaseType } from '../types';
import { formatIdentifier, SqlDialect, toSqlDialect } from '../sql';

/**
 * Options for SchemaAnalyzer.renderForModel().
 */
export interface SchemaRenderOptions {
  /** Dialect used to quote identifiers. Default: from the schema's databaseType. */
  dialect?: SqlDialect;
  /** Include table and column descriptions. Default: true. */
  descriptions?: boolean;
  /** Include `sampleValues` (never for sensitive columns). Default: true. */
  sampleValues?: boolean;
}

/** Schema that unqualified names resolve to, per dialect; tables elsewhere are shown qualified. */
const DEFAULT_SCHEMAS: Partial<Record<SqlDialect, string>> = { postgres: 'public', mssql: 'dbo', sqlite: 'main' };
/** Most enum values listed per column. */
const MAX_ENUM_VALUES = 50;
/** Most sample values listed per column. */
const MAX_SAMPLE_VALUES = 10;
const WHITESPACE = /\s+/g;
/** A closing tag inside schema text, which could end the prompt's <schema> block early. */
const CLOSING_TAG = /<\/(?=[A-Za-z_])/g;
const SINGLE_QUOTE = /'/g;

/**
 * Per-dialect rules for the model: quoting, row limits, date functions,
 * string concatenation, case-insensitive matching and booleans.
 */
const DIALECT_RULES: Record<SqlDialect, string> = {
  postgres: [
    'PostgreSQL rules:',
    '- Unquoted names are folded to lower case, so write a name in double quotes whenever the schema shows it quoted, also after an alias: t."createdAt".',
    '- Limit rows with LIMIT n, page with LIMIT n OFFSET m.',
    "- Dates: NOW(), CURRENT_DATE, date_trunc('month', col), col >= NOW() - INTERVAL '7 days', EXTRACT(YEAR FROM col).",
    "- Concatenate strings with ||. Match case-insensitively with ILIKE ('%x%').",
    '- Booleans are TRUE and FALSE. String literals use single quotes.',
    '- CTEs (WITH), RETURNING and JSON operators (->, ->>) are available.',
  ].join('\n'),
  mysql: [
    'MySQL rules:',
    '- Quote names with backticks when the schema shows them quoted (`order`). Double quotes are string literals, not identifiers.',
    '- Limit rows with LIMIT n, page with LIMIT n OFFSET m.',
    "- Dates: NOW(), CURDATE(), DATE_SUB(NOW(), INTERVAL 7 DAY), DATE_FORMAT(col, '%Y-%m'), YEAR(col).",
    '- Concatenate strings with CONCAT(a, b); || is not concatenation. LIKE is case-insensitive with the default collations.',
    '- Booleans are TRUE and FALSE (stored as 1 and 0). There is no FULL OUTER JOIN.',
  ].join('\n'),
  sqlite: [
    'SQLite rules:',
    '- Quote names with double quotes when the schema shows them quoted ("order").',
    '- Limit rows with LIMIT n, page with LIMIT n OFFSET m.',
    "- Dates are stored as text or numbers: date('now', '-7 days'), datetime('now'), strftime('%Y-%m', col), julianday(col).",
    "- Concatenate strings with ||. LIKE is case-insensitive for ASCII letters; use LOWER(col) for other text.",
    '- Booleans are stored as 1 and 0. String literals use single quotes; never use double quotes for strings.',
  ].join('\n'),
  mssql: [
    'SQL Server (T-SQL) rules:',
    '- Quote names with square brackets when the schema shows them quoted ([Order], [User]).',
    '- There is no LIMIT. Limit rows with SELECT TOP (n) ...; page with ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.',
    "- Dates: GETDATE(), CAST(GETDATE() AS date), DATEADD(day, -7, GETDATE()), DATEDIFF(day, a, b), YEAR(col), FORMAT(col, 'yyyy-MM').",
    "- Concatenate strings with + or CONCAT(a, b). Use N'...' for Unicode strings. Matching is usually case-insensitive (collation); use LOWER() to be sure.",
    '- There are no boolean literals: bit columns use 1 and 0.',
  ].join('\n'),
  generic: [
    'SQL rules:',
    '- Use standard SQL. Quote names with double quotes when the schema shows them quoted.',
    '- Limit rows with LIMIT n. Dates: CURRENT_DATE, CURRENT_TIMESTAMP. Concatenate strings with ||.',
    '- Match case-insensitively with LOWER(col) LIKE LOWER(...). Booleans are TRUE and FALSE.',
  ].join('\n'),
};

/**
 * Database schema analyzer and formatter
 */
export class SchemaAnalyzer {
  private schema: DatabaseSchema;

  constructor(schema: DatabaseSchema) {
    this.schema = schema;
  }

  /**
   * Generate a human-readable schema description for the LLM.
   *
   * The output is the same as in 0.0.1 (names unquoted, new schema fields not
   * shown), because callers may store or compare it. The generator sends the
   * model renderForModel() instead.
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
   * Render the schema for the model: compact, one line per column, with every
   * name written the way the dialect needs it (`"User"`, `` `order` ``,
   * `[Order]`), the native type, primary and foreign keys, enum values,
   * sample values, descriptions and sensitive markers.
   *
   * @example
   * ```text
   * TABLE "User" -- Registered users
   *   id integer PK
   *   "createdAt" timestamp(3)
   *   role "Role" values: 'ADMIN', 'USER'
   *   "teamId" integer FK -> "Team".id
   *   password text SENSITIVE
   * ```
   */
  renderForModel(options: SchemaRenderOptions = {}): string {
    const dialect = options.dialect ?? toSqlDialect(this.schema.databaseType);
    const withDescriptions = options.descriptions !== false;
    const withSamples = options.sampleValues !== false;
    const tables = this.schema.tables || [];
    if (tables.length === 0) return '(no tables)';

    const qualify = this.qualifyTables(dialect);
    const name = (n: string) => renderName(n, dialect, this.schema.exactNames === true);
    const blocks: string[] = [];

    for (const table of tables) {
      const tableName = (qualify(table.schema) ? `${name(table.schema!)}.` : '') + name(table.name);
      let block = `TABLE ${tableName}`;
      if (withDescriptions && table.description) block += ` -- ${inlineText(table.description)}`;

      const pk = new Set(primaryKeyColumns(table));
      const fks = new Map<string, string>();
      for (const fk of table.foreignKeys || []) {
        if (fks.has(fk.column)) continue;
        const refSchema = fk.referencedSchema !== undefined ? fk.referencedSchema : undefined;
        const refTable = (refSchema && qualify(refSchema) ? `${name(refSchema)}.` : '') + name(fk.referencedTable);
        fks.set(fk.column, fk.referencedColumn ? `${refTable}.${name(fk.referencedColumn)}` : refTable);
      }

      for (const column of table.columns || []) {
        block += `\n  ${this.renderColumn(column, dialect, pk.has(column.name), fks.get(column.name), withDescriptions, withSamples)}`;
      }
      blocks.push(block);
    }

    return blocks.join('\n\n');
  }

  private renderColumn(
    column: ColumnSchema,
    dialect: SqlDialect,
    isPrimaryKey: boolean,
    reference: string | undefined,
    withDescriptions: boolean,
    withSamples: boolean
  ): string {
    let line = `${renderName(column.name, dialect, this.schema.exactNames === true)} ${inlineText(column.nativeType || column.type || 'unknown')}`;
    if (isPrimaryKey) line += ' PK';
    if (reference) line += ` FK -> ${reference}`;
    if (column.enumValues && column.enumValues.length > 0) {
      const shown = column.enumValues.slice(0, MAX_ENUM_VALUES).map(sqlLiteral).join(', ');
      const more = column.enumValues.length - MAX_ENUM_VALUES;
      line += ` values: ${shown}${more > 0 ? `, ... (${more} more)` : ''}`;
    }
    if (column.sensitive) {
      line += ' SENSITIVE';
    } else if (withSamples && column.sampleValues && column.sampleValues.length > 0) {
      line += ` e.g. ${column.sampleValues.slice(0, MAX_SAMPLE_VALUES).map(sqlLiteral).join(', ')}`;
    }
    if (withDescriptions && column.description) line += ` -- ${inlineText(column.description)}`;
    return line;
  }

  /** Whether tables in `schema` must be shown schema-qualified. */
  private qualifyTables(dialect: SqlDialect): (schema: string | undefined) => boolean {
    const schemas = new Set<string>();
    for (const table of this.schema.tables || []) if (table.schema) schemas.add(table.schema);
    const several = schemas.size > 1;
    const fallback = DEFAULT_SCHEMAS[dialect];
    return (schema) => {
      if (!schema) return false;
      if (several) return true;
      return fallback !== undefined && schema.toLowerCase() !== fallback;
    };
  }

  /**
   * Rules for writing SQL in this schema's dialect: quoting, LIMIT or TOP,
   * date functions, string concatenation, case-insensitive matching and
   * booleans.
   */
  getDialectRules(): string {
    return DIALECT_RULES[toSqlDialect(this.schema.databaseType)];
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
   * Generate example queries for the schema.
   *
   * Names are quoted where the dialect needs it, and SQL Server queries use
   * TOP instead of LIMIT. For plain names in other dialects the output is the
   * same as in 0.0.1.
   */
  generateExampleQueries(): string[] {
    const examples: string[] = [];
    const dialect = toSqlDialect(this.schema.databaseType);
    const name = (n: string) => renderName(n, dialect, this.schema.exactNames === true);

    for (const table of this.schema.tables) {
      const tableName = name(table.name);
      // Basic SELECT example
      const columns = table.columns
        .filter((c) => !c.sensitive)
        .map((c) => name(c.name))
        .slice(0, 3)
        .join(', ');

      if (columns) {
        examples.push(
          dialect === 'mssql'
            ? `SELECT TOP 10 ${columns} FROM ${tableName}`
            : `SELECT ${columns} FROM ${tableName} LIMIT 10`
        );
      }

      // JOIN example if foreign keys exist
      if (table.foreignKeys && table.foreignKeys.length > 0) {
        const fk = table.foreignKeys[0];
        const refTable = name(fk.referencedTable);
        examples.push(
          `SELECT ${tableName}.* FROM ${tableName} JOIN ${refTable} ON ${tableName}.${name(fk.column)} = ${refTable}.${name(fk.referencedColumn)}`
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
   * Generate database-specific query hints (one line). getDialectRules()
   * gives the fuller rules the generator sends to the model.
   */
  getDatabaseHints(): string {
    switch (this.schema.databaseType) {
      case 'postgres':
        return 'Use PostgreSQL syntax. Support for RETURNING clause, JSON operators, and CTEs.';
      case 'mysql':
        return 'Use MySQL syntax. Backticks for identifiers, LIMIT syntax.';
      case 'sqlite':
        return 'Use SQLite syntax. Double quotes for identifiers, LIMIT syntax, date() and strftime() for dates.';
      case 'mongodb':
        return 'MongoDB is not supported: use standard SQL syntax.';
      case 'mssql':
        return 'Use T-SQL syntax. Support for TOP, OFFSET-FETCH.';
      default:
        return 'Use standard SQL syntax.';
    }
  }
}

/** A name as it must be written in `dialect`: quoted only when needed (see DatabaseSchema.exactNames). */
function renderName(name: string, dialect: SqlDialect, exactCase: boolean): string {
  return formatIdentifier(name, dialect, exactCase);
}

/** Primary key columns: primaryKeyColumns, or the 0.0.1 primaryKey string ("a, b" for composite keys). */
function primaryKeyColumns(table: TableSchema): string[] {
  if (table.primaryKeyColumns && table.primaryKeyColumns.length > 0) return table.primaryKeyColumns;
  if (!table.primaryKey) return [];
  return table.primaryKey.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
}

/** Text on one line, with closing tags defused so it cannot end a prompt block. */
function inlineText(text: string): string {
  return String(text).replace(WHITESPACE, ' ').trim().replace(CLOSING_TAG, '< /');
}

/** A value as a SQL literal: strings single-quoted with `'` doubled. */
function sqlLiteral(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : `'${value}'`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${inlineText(String(value)).replace(SINGLE_QUOTE, "''")}'`;
}
