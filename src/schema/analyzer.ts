import { DatabaseSchema, TableSchema, ColumnSchema, DatabaseType, QueryOperation, SecurityConfig } from '../types';
import { formatIdentifier, SqlDialect, toSqlDialect } from '../sql';
import { RestrictedColumns } from '../security/columns';

/**
 * Options for SchemaAnalyzer.renderForModel().
 */
export interface SchemaRenderOptions {
  /** Dialect used to quote identifiers. Default: from the schema's databaseType. */
  dialect?: SqlDialect;
  /** Include table and column descriptions. Default: true. */
  descriptions?: boolean;
  /** Include `sampleValues` (never for sensitive or restricted columns). Default: true. */
  sampleValues?: boolean;
  /**
   * Render the schema for these security settings, matched the way the
   * validator matches them. With `allowedTables`, only the tables it allows
   * are shown (case-insensitive; an unqualified entry names a table without a
   * schema or in the dialect's default schema, `schema.table` names that
   * table), and foreign keys to other tables are left out. Columns that
   * `restrictedColumns` covers are marked RESTRICTED. Default: every table,
   * no RESTRICTED markers.
   */
  security?: Pick<SecurityConfig, 'allowedTables' | 'restrictedColumns' | 'restrictedColumnsMatch'>;
}

/**
 * A table as the model sees it.
 * @internal
 */
export interface ModelTable {
  table: TableSchema;
  /** The name as renderForModel() writes it: quoted where needed, schema-qualified where needed. */
  name: string;
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

/** Postgres features line; RETURNING is added only when the model may write (see getDialectRules). */
const POSTGRES_FEATURES = '- CTEs (WITH) and JSON operators (->, ->>) are available.';
const POSTGRES_FEATURES_WITH_WRITES = '- CTEs (WITH), RETURNING and JSON operators (->, ->>) are available.';
/** Postgres, SQLite and SQL Server truncate integer division; MySQL's / does not. */
const INTEGER_DIVISION = '- Dividing two integers truncates (7 / 2 = 3); multiply by 1.0 to keep the fraction.';
const WRITE_OPERATIONS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE']);

/**
 * Per-dialect rules for the model: quoting, row limits, date functions,
 * string concatenation, case-insensitive matching, booleans and the most
 * common runtime errors.
 */
const DIALECT_RULES: Record<SqlDialect, string[]> = {
  postgres: [
    'PostgreSQL rules:',
    '- Unquoted names are folded to lower case, so write a name in double quotes whenever the schema shows it quoted, also after an alias: t."createdAt".',
    '- Limit rows with LIMIT n, page with LIMIT n OFFSET m.',
    "- Dates: NOW(), CURRENT_DATE, date_trunc('month', col), col >= NOW() - INTERVAL '7 days', EXTRACT(YEAR FROM col).",
    "- Concatenate strings with ||. Match case-insensitively with ILIKE ('%x%').",
    '- Booleans are TRUE and FALSE. String literals use single quotes.',
    INTEGER_DIVISION,
    '- ROUND(x, n) needs a numeric x: ROUND(x::numeric, 2).',
    '- A select-list alias cannot be used in WHERE or HAVING; repeat the expression.',
    POSTGRES_FEATURES,
  ],
  mysql: [
    'MySQL rules:',
    '- Quote names with backticks when the schema shows them quoted (`order`). Double quotes are string literals, not identifiers.',
    '- Limit rows with LIMIT n, page with LIMIT n OFFSET m.',
    "- Dates: NOW(), CURDATE(), DATE_SUB(NOW(), INTERVAL 7 DAY), DATE_FORMAT(col, '%Y-%m'), YEAR(col).",
    '- Concatenate strings with CONCAT(a, b); || is not concatenation. LIKE is case-insensitive with the default collations.',
    '- Booleans are TRUE and FALSE (stored as 1 and 0). There is no FULL OUTER JOIN.',
    '- A select-list alias cannot be used in WHERE; repeat the expression.',
  ],
  sqlite: [
    'SQLite rules:',
    '- Quote names with double quotes when the schema shows them quoted ("order").',
    '- Limit rows with LIMIT n, page with LIMIT n OFFSET m.',
    "- Dates are stored as text or numbers: date('now', '-7 days'), datetime('now'), strftime('%Y-%m', col), julianday(col).",
    // The built-in lower() and upper() are ASCII-only too (without the ICU extension).
    '- Concatenate strings with ||. LIKE and LOWER()/UPPER() fold case for ASCII letters only; for other letters compare the exact value or both spellings.',
    '- Booleans are stored as 1 and 0. String literals use single quotes; never use double quotes for strings.',
    INTEGER_DIVISION,
  ],
  mssql: [
    'SQL Server (T-SQL) rules:',
    '- Quote names with square brackets when the schema shows them quoted ([Order], [User]).',
    '- There is no LIMIT. Limit rows with SELECT TOP (n) ...; page with ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY.',
    "- Dates: GETDATE(), CAST(GETDATE() AS date), DATEADD(day, -7, GETDATE()), DATEDIFF(day, a, b), YEAR(col), FORMAT(col, 'yyyy-MM').",
    "- Concatenate strings with + or CONCAT(a, b). Use N'...' for Unicode strings. Matching is usually case-insensitive (collation); use LOWER() to be sure.",
    '- There are no boolean literals: bit columns use 1 and 0.',
    INTEGER_DIVISION,
    '- ORDER BY is not allowed in a subquery or CTE without TOP or OFFSET.',
    '- A select-list alias can be used only in ORDER BY; GROUP BY must repeat the expression.',
  ],
  generic: [
    'SQL rules:',
    '- Use standard SQL. Quote names with double quotes when the schema shows them quoted.',
    '- Limit rows with LIMIT n. Dates: CURRENT_DATE, CURRENT_TIMESTAMP. Concatenate strings with ||.',
    '- Match case-insensitively with LOWER(col) LIKE LOWER(...). Booleans are TRUE and FALSE.',
  ],
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
    const allowed = allowedTableFilter(options.security?.allowedTables, dialect);
    const tables = this.modelTables(options);
    if (tables.length === 0) return '(no tables)';

    const qualify = qualifyTables(tables.map((t) => t.table), dialect);
    const restricted = new RestrictedColumns(options.security ?? {});
    const name = (n: string) => renderName(n, dialect, this.schema.exactNames === true);
    const blocks: string[] = [];

    for (const { table, name: tableName } of tables) {
      let block = `TABLE ${tableName}`;
      if (withDescriptions && table.description) block += ` -- ${inlineText(table.description)}`;

      const pk = new Set(primaryKeyColumns(table));
      const fks = new Map<string, string>();
      for (const fk of table.foreignKeys || []) {
        if (fks.has(fk.column)) continue;
        // referencedSchema is set only when it differs from the table's own (ForeignKeySchema).
        const refSchema = fk.referencedSchema ?? table.schema;
        // A key to a table the model may not query only invites a query the validator rejects.
        if (allowed && !allowed(fk.referencedTable, refSchema)) continue;
        const refTable = (qualify(refSchema) ? `${name(refSchema!)}.` : '') + name(fk.referencedTable);
        fks.set(fk.column, fk.referencedColumn ? `${refTable}.${name(fk.referencedColumn)}` : refTable);
      }

      for (const column of table.columns || []) {
        const isRestricted = !restricted.isEmpty && restricted.match(column.name, table.name, table.schema) !== undefined;
        const line = this.renderColumn(
          column,
          dialect,
          pk.has(column.name),
          fks.get(column.name),
          isRestricted,
          withDescriptions,
          withSamples
        );
        block += `\n  ${line}`;
      }
      blocks.push(block);
    }

    return blocks.join('\n\n');
  }

  /**
   * The tables renderForModel() shows for these options (all of them, or only
   * the ones `security.allowedTables` allows), in schema order, with their
   * names written as renderForModel() writes them.
   * @internal
   */
  modelTables(options: SchemaRenderOptions = {}): ModelTable[] {
    const dialect = options.dialect ?? toSqlDialect(this.schema.databaseType);
    const allowed = allowedTableFilter(options.security?.allowedTables, dialect);
    const tables = (this.schema.tables || []).filter(
      (t) => !!t && typeof t.name === 'string' && (!allowed || allowed(t.name, t.schema))
    );
    // Qualify only as far as the shown tables need it: with every allowed table in
    // the default schema, `orders` is what the model should write.
    const qualify = qualifyTables(tables, dialect);
    const name = (n: string) => renderName(n, dialect, this.schema.exactNames === true);
    return tables.map((table) => ({
      table,
      name: (qualify(table.schema) ? `${name(table.schema!)}.` : '') + name(table.name),
    }));
  }

  private renderColumn(
    column: ColumnSchema,
    dialect: SqlDialect,
    isPrimaryKey: boolean,
    reference: string | undefined,
    isRestricted: boolean,
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
    if (isRestricted) line += ' RESTRICTED';
    if (column.sensitive) {
      line += ' SENSITIVE';
    } else if (!isRestricted && withSamples && column.sampleValues && column.sampleValues.length > 0) {
      // Never sample values of a column the application keeps from the model.
      line += ` e.g. ${column.sampleValues.slice(0, MAX_SAMPLE_VALUES).map(sqlLiteral).join(', ')}`;
    }
    if (withDescriptions && column.description) line += ` -- ${inlineText(column.description)}`;
    return line;
  }

  /**
   * Rules for writing SQL in this schema's dialect: quoting, LIMIT or TOP,
   * date functions, string concatenation, case-insensitive matching,
   * booleans and common runtime errors.
   *
   * @param options - `allowedOperations`: the statements the model may write
   *   (default: SELECT only); write-only features such as RETURNING are
   *   mentioned only when INSERT, UPDATE or DELETE is allowed
   */
  getDialectRules(options: { allowedOperations?: QueryOperation[] } = {}): string {
    const writes = (options.allowedOperations || []).some((op) => WRITE_OPERATIONS.has(String(op).toUpperCase()));
    const lines = DIALECT_RULES[toSqlDialect(this.schema.databaseType)];
    return lines.map((line) => (writes && line === POSTGRES_FEATURES ? POSTGRES_FEATURES_WITH_WRITES : line)).join('\n');
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

/** Whether tables in a schema must be shown schema-qualified, given the tables shown. */
function qualifyTables(tables: TableSchema[], dialect: SqlDialect): (schema: string | undefined) => boolean {
  const schemas = new Set<string>();
  for (const table of tables) if (table.schema) schemas.add(table.schema);
  const several = schemas.size > 1;
  const fallback = DEFAULT_SCHEMAS[dialect];
  return (schema) => {
    if (!schema) return false;
    if (several) return true;
    return fallback !== undefined && schema.toLowerCase() !== fallback;
  };
}

/**
 * A predicate for the tables `allowedTables` allows, or undefined when every
 * table is allowed (no entries). Matching is case-insensitive. An unqualified
 * entry names a table without a schema or in the dialect's default schema
 * (any schema on MySQL and generic SQL, where the default is whatever the
 * connection uses); `schema.table` names that table, and a schema-less table
 * when `schema` is the default.
 */
function allowedTableFilter(
  entries: string[] | undefined,
  dialect: SqlDialect
): ((name: string, schema: string | undefined) => boolean) | undefined {
  if (!Array.isArray(entries) || entries.length === 0) return undefined;
  const fallback = DEFAULT_SCHEMAS[dialect];
  const parsed: Array<{ table: string; schema?: string }> = [];
  for (const entry of entries) {
    const parts = String(entry).trim().toLowerCase().split('.');
    const table = parts[parts.length - 1];
    if (!table) continue;
    // `db..table` has an empty schema part: it reads like an unqualified entry.
    const schema = parts.length > 1 && parts[parts.length - 2] ? parts[parts.length - 2] : undefined;
    parsed.push({ table, schema });
  }
  return (name, schema) => {
    const table = name.toLowerCase();
    const own = schema ? schema.toLowerCase() : undefined;
    return parsed.some((e) => {
      if (e.table !== table) return false;
      if (e.schema === undefined) return own === undefined || fallback === undefined || own === fallback;
      return own === undefined ? e.schema === fallback : own === e.schema;
    });
  };
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
