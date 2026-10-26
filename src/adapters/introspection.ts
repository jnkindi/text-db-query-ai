/**
 * Shared schema introspection
 *
 * DatabaseIntrospectionAdapter and PrismaAdapter both read the schema through
 * this module. Each dialect runs a fixed set of set-based catalog queries
 * (tables, columns, primary keys, foreign keys, enums), whatever the number of
 * tables, and the rows are grouped per table in memory.
 */

import {
  DatabaseSchema,
  DatabaseType,
  TableSchema,
  ColumnSchema,
  ForeignKeySchema,
} from '../types';
import { IntrospectionExecutor, SchemaExtractionOptions } from './types';

type Row = Record<string, unknown>;

/** A table as read from the catalog, before filtering. */
interface RawTable {
  name: string;
  schema?: string;
  description?: string;
}

/** A column as read from the catalog. `dataType` feeds the 0.0.1 type mapping. */
interface RawColumn {
  table: string;
  name: string;
  dataType: string;
  nativeType?: string;
  nullable: boolean;
  description?: string;
  enumValues?: string[];
}

interface RawPrimaryKey {
  table: string;
  column: string;
  position: number;
}

interface RawForeignKey {
  table: string;
  /** Groups the column pairs of one constraint. Rows of one constraint are adjacent, in key order. */
  constraint: string;
  column: string;
  referencedSchema?: string;
  referencedTable: string;
  /** Missing when SQLite references the parent's primary key implicitly. */
  referencedColumn?: string;
}

interface RawSchema {
  tables: RawTable[];
  columns: RawColumn[];
  primaryKeys: RawPrimaryKey[];
  foreignKeys: RawForeignKey[];
}

type RowRunner = (sql: string, params?: unknown[]) => Promise<Row[]>;

/**
 * Introspection SQL per dialect. Exported for tests; not part of the public API.
 *
 * Every result column is aliased to the lower-case form of its source name, so
 * rows read the same whether a server keeps the alias (MySQL 8 returns
 * information_schema labels in upper case unless aliased) or not.
 */
export const INTROSPECTION_SQL = {
  postgres: {
    // Same relation kinds as pg_tables, which 0.0.1 read: ordinary and partitioned tables.
    tables: `
      SELECT c.relname::text AS table_name,
             obj_description(c.oid, 'pg_class') AS description
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
    // data_type, is_nullable and the privilege filter reproduce information_schema.columns,
    // which 0.0.1 read: the normalized type mapping and the visible columns stay the same.
    columns: `
      SELECT c.relname::text AS table_name,
             a.attname::text AS column_name,
             CASE
               WHEN t.typtype = 'd' THEN
                 CASE
                   WHEN bt.typelem <> 0 AND bt.typlen = -1 THEN 'ARRAY'
                   WHEN btn.nspname = 'pg_catalog' THEN format_type(t.typbasetype, NULL)
                   ELSE 'USER-DEFINED'
                 END
               WHEN t.typelem <> 0 AND t.typlen = -1 THEN 'ARRAY'
               WHEN tn.nspname = 'pg_catalog' THEN format_type(a.atttypid, NULL)
               ELSE 'USER-DEFINED'
             END AS data_type,
             format_type(a.atttypid, a.atttypmod) AS native_type,
             CASE WHEN t.typtype = 'e' THEN tn.nspname::text ELSE etn.nspname::text END AS enum_schema,
             CASE WHEN t.typtype = 'e' THEN t.typname::text ELSE et.typname::text END AS enum_name,
             CASE WHEN a.attnotnull OR (t.typtype = 'd' AND t.typnotnull) THEN 'NO' ELSE 'YES' END AS is_nullable,
             col_description(c.oid, a.attnum) AS description
      FROM pg_catalog.pg_attribute AS a
      JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
      JOIN pg_catalog.pg_namespace AS tn ON tn.oid = t.typnamespace
      LEFT JOIN pg_catalog.pg_type AS bt ON t.typtype = 'd' AND bt.oid = t.typbasetype
      LEFT JOIN pg_catalog.pg_namespace AS btn ON btn.oid = bt.typnamespace
      LEFT JOIN pg_catalog.pg_type AS et ON t.typlen = -1 AND et.oid = t.typelem AND et.typtype = 'e'
      LEFT JOIN pg_catalog.pg_namespace AS etn ON etn.oid = et.typnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND (pg_has_role(c.relowner, 'USAGE')
             OR has_column_privilege(c.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES'))
      ORDER BY c.relname, a.attnum`,
    // pg_constraint keeps the real (mixed-case) names, unlike a ::regclass cast.
    primaryKeys: `
      SELECT c.relname::text AS table_name,
             a.attname::text AS column_name,
             k.ord::int AS position
      FROM pg_catalog.pg_constraint AS con
      JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute AS a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      WHERE n.nspname = $1
        AND con.contype = 'p'
      ORDER BY c.relname, k.ord`,
    // Pairs conkey/confkey by position, so a composite FK yields one row per column pair.
    // The NOT EXISTS drops the per-partition copies PG adds when the referenced table is partitioned.
    foreignKeys: `
      SELECT c.relname::text AS table_name,
             con.conname::text AS constraint_name,
             k.ord::int AS position,
             a.attname::text AS column_name,
             rn.nspname::text AS referenced_schema,
             rc.relname::text AS referenced_table,
             ra.attname::text AS referenced_column
      FROM pg_catalog.pg_constraint AS con
      JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      JOIN pg_catalog.pg_class AS rc ON rc.oid = con.confrelid
      JOIN pg_catalog.pg_namespace AS rn ON rn.oid = rc.relnamespace
      CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
      JOIN pg_catalog.pg_attribute AS a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      JOIN pg_catalog.pg_attribute AS ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refattnum
      WHERE n.nspname = $1
        AND con.contype = 'f'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint AS pc
          WHERE pc.oid = con.conparentid AND pc.conrelid = con.conrelid
        )
      ORDER BY c.relname, con.conname, k.ord`,
    // Labels of the enum types (and enum array element types) used by the schema's tables.
    enums: `
      WITH used AS (
        SELECT DISTINCT a.atttypid AS typid
        FROM pg_catalog.pg_attribute AS a
        JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relkind IN ('r', 'p')
          AND a.attnum > 0
          AND NOT a.attisdropped
      )
      SELECT tn.nspname::text AS enum_schema,
             t.typname::text AS enum_name,
             e.enumlabel::text AS label
      FROM pg_catalog.pg_enum AS e
      JOIN pg_catalog.pg_type AS t ON t.oid = e.enumtypid
      JOIN pg_catalog.pg_namespace AS tn ON tn.oid = t.typnamespace
      WHERE e.enumtypid IN (SELECT typid FROM used)
         OR e.enumtypid IN (
           SELECT at.typelem FROM pg_catalog.pg_type AS at JOIN used ON used.typid = at.oid
         )
      ORDER BY tn.nspname, t.typname, e.enumsortorder`,
  },
  mysql: {
    // Views are included, as in 0.0.1. A NULL parameter falls back to DATABASE().
    tables: `
      SELECT TABLE_SCHEMA AS table_schema,
             TABLE_NAME AS table_name,
             TABLE_TYPE AS table_type,
             TABLE_COMMENT AS table_comment
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
      ORDER BY TABLE_NAME`,
    columns: `
      SELECT TABLE_NAME AS table_name,
             COLUMN_NAME AS column_name,
             DATA_TYPE AS data_type,
             COLUMN_TYPE AS column_type,
             IS_NULLABLE AS is_nullable,
             COLUMN_COMMENT AS column_comment
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    // Primary keys and foreign keys in one pass; each FK row is already one column pair.
    keys: `
      SELECT TABLE_SCHEMA AS table_schema,
             TABLE_NAME AS table_name,
             CONSTRAINT_NAME AS constraint_name,
             COLUMN_NAME AS column_name,
             ORDINAL_POSITION AS ordinal_position,
             REFERENCED_TABLE_SCHEMA AS referenced_table_schema,
             REFERENCED_TABLE_NAME AS referenced_table_name,
             REFERENCED_COLUMN_NAME AS referenced_column_name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
        AND (CONSTRAINT_NAME = 'PRIMARY' OR REFERENCED_TABLE_NAME IS NOT NULL)
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
  },
  sqlite: {
    // Tables and columns in one statement (table-valued pragmas need SQLite 3.16+).
    // The table name is passed by the join, so reserved names such as "order" need no quoting.
    columns: `
      SELECT m.name AS table_name,
             p.cid AS cid,
             p.name AS column_name,
             p.type AS data_type,
             p."notnull" AS not_null,
             p.pk AS pk
      FROM sqlite_master AS m
      JOIN pragma_table_info(m.name) AS p
      WHERE m.type = 'table'
        AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
      ORDER BY m.name, p.cid`,
    foreignKeys: `
      SELECT m.name AS table_name,
             f.id AS fk_id,
             f.seq AS seq,
             f."table" AS referenced_table,
             f."from" AS column_name,
             f."to" AS referenced_column
      FROM sqlite_master AS m
      JOIN pragma_foreign_key_list(m.name) AS f
      WHERE m.type = 'table'
        AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
      ORDER BY m.name, f.id, f.seq`,
  },
  mssql: {
    tables: `
      SELECT TABLE_SCHEMA AS table_schema,
             TABLE_NAME AS table_name
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_TYPE = 'BASE TABLE'
        AND TABLE_SCHEMA = @P1
      ORDER BY TABLE_NAME`,
    columns: `
      SELECT TABLE_NAME AS table_name,
             COLUMN_NAME AS column_name,
             DATA_TYPE AS data_type,
             CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
             NUMERIC_PRECISION AS numeric_precision,
             NUMERIC_SCALE AS numeric_scale,
             IS_NULLABLE AS is_nullable
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @P1
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    primaryKeys: `
      SELECT kcu.TABLE_NAME AS table_name,
             kcu.COLUMN_NAME AS column_name,
             kcu.ORDINAL_POSITION AS ordinal_position
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS AS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS kcu
        ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
       AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
       AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
       AND kcu.TABLE_NAME = tc.TABLE_NAME
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND tc.TABLE_SCHEMA = @P1
      ORDER BY kcu.TABLE_NAME, kcu.ORDINAL_POSITION`,
    // sys.foreign_key_columns pairs each FK column with its referenced column exactly.
    foreignKeys: `
      SELECT pt.name AS table_name,
             fk.name AS constraint_name,
             fkc.constraint_column_id AS position,
             pc.name AS column_name,
             rs.name AS referenced_schema,
             rt.name AS referenced_table,
             rc.name AS referenced_column
      FROM sys.foreign_key_columns AS fkc
      JOIN sys.foreign_keys AS fk ON fk.object_id = fkc.constraint_object_id
      JOIN sys.tables AS pt ON pt.object_id = fkc.parent_object_id
      JOIN sys.schemas AS ps ON ps.schema_id = pt.schema_id
      JOIN sys.columns AS pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.tables AS rt ON rt.object_id = fkc.referenced_object_id
      JOIN sys.schemas AS rs ON rs.schema_id = rt.schema_id
      JOIN sys.columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE ps.name = @P1
      ORDER BY pt.name, fk.name, fkc.constraint_column_id`,
    // MS_Description of tables (minor_id 0) and of their columns, in one query.
    descriptions: `
      SELECT OBJECT_NAME(ep.major_id) AS table_name,
             COL_NAME(ep.major_id, ep.minor_id) AS column_name,
             CAST(ep.value AS nvarchar(4000)) AS description
      FROM sys.extended_properties AS ep
      WHERE ep.class = 1
        AND ep.name = N'MS_Description'
        AND OBJECT_SCHEMA_NAME(ep.major_id) = @P1`,
  },
} as const;

/**
 * SQLite statements for the per-table fallback, used only when the bulk query
 * fails: SQLite before 3.16 (no table-valued pragmas), or a virtual table whose
 * module is not loaded, which makes the joined pragma fail for every table.
 */
export const SQLITE_FALLBACK_SQL = {
  tables: `
      SELECT name AS table_name
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
      ORDER BY name`,
  tableInfo: (table: string): string => `PRAGMA table_info(${quoteSqliteIdentifier(table)})`,
  foreignKeyList: (table: string): string => `PRAGMA foreign_key_list(${quoteSqliteIdentifier(table)})`,
};

const DOUBLE_QUOTE = /"/g;

function quoteSqliteIdentifier(name: string): string {
  return `"${name.replace(DOUBLE_QUOTE, '""')}"`;
}

/**
 * Map a database type name to the normalized type exposed as `ColumnSchema.type`.
 *
 * This is exactly the 0.0.1 mapping and must not change: prompts and user code
 * compare these strings. The real type is exposed separately as `nativeType`.
 */
export function normalizeDataType(type: string): string {
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

/**
 * Read the schema of a database through `execute`.
 *
 * Runs a constant number of queries, whatever the number of tables: 5 for
 * postgres (4 with `includeEnumValues: false`), 3 for mysql, 2 for sqlite, and
 * 5 for mssql (4 with `includeDescriptions: false`). The table and column
 * queries must succeed. The key, enum and description queries are best effort,
 * as in 0.0.1: if one fails, that information is left out.
 *
 * @param execute - Runs one query and resolves to its rows (keys in any case)
 * @param databaseType - Dialect of the SQL to send
 * @param options - Table filters, schema and what to read
 */
export async function introspectSchema(
  execute: IntrospectionExecutor,
  databaseType: DatabaseType,
  options: SchemaExtractionOptions = {}
): Promise<DatabaseSchema> {
  const run: RowRunner = async (sql, params) => normalizeRows(await execute(sql, params));

  let raw: RawSchema;
  switch (databaseType) {
    case 'postgres':
      raw = await readPostgres(run, options);
      break;
    case 'mysql':
      raw = await readMysql(run, options);
      break;
    case 'sqlite':
      raw = await readSqlite(run);
      break;
    case 'mssql':
      raw = await readMssql(run, options);
      break;
    default:
      throw new Error(`Unsupported database type: ${databaseType}`);
  }

  return {
    databaseType,
    tables: buildTables(raw, options),
  };
}

/** Resolve to [] instead of rejecting, for the best-effort queries. */
function bestEffort(rows: Promise<Row[]>): Promise<Row[]> {
  return rows.catch(() => []);
}

const NO_ROWS: Promise<Row[]> = Promise.resolve([]);

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

async function readPostgres(run: RowRunner, options: SchemaExtractionOptions): Promise<RawSchema> {
  const sql = INTROSPECTION_SQL.postgres;
  const schema = options.schema ?? 'public';
  const params = [schema];

  const [tableRows, columnRows, pkRows, fkRows, enumRows] = await Promise.all([
    run(sql.tables, params),
    run(sql.columns, params),
    bestEffort(run(sql.primaryKeys, params)),
    bestEffort(run(sql.foreignKeys, params)),
    options.includeEnumValues !== false ? bestEffort(run(sql.enums, params)) : NO_ROWS,
  ]);

  // "schema.type" -> labels in enumsortorder
  const enumLabels = new Map<string, string[]>();
  for (const row of enumRows) {
    const key = `${text(row.enum_schema)}.${text(row.enum_name)}`;
    let labels = enumLabels.get(key);
    if (!labels) enumLabels.set(key, (labels = []));
    labels.push(text(row.label));
  }

  const columns: RawColumn[] = columnRows.map((row) => {
    const dataType = text(row.data_type);
    const enumName = optionalName(row.enum_name);
    let nativeType = optionalName(row.native_type);
    let enumValues: string[] | undefined;
    if (enumName) {
      // Enum (or enum array) column: the plain type name, schema-qualified only when foreign.
      const enumSchema = text(row.enum_schema);
      const qualified = enumSchema !== schema ? `${enumSchema}.${enumName}` : enumName;
      nativeType = dataType === 'ARRAY' ? `${qualified}[]` : qualified;
      enumValues = enumLabels.get(`${enumSchema}.${enumName}`);
    } else if (nativeType) {
      nativeType = shortenPostgresType(nativeType);
    }
    return {
      table: text(row.table_name),
      name: text(row.column_name),
      dataType,
      nativeType,
      nullable: text(row.is_nullable) === 'YES',
      description: optionalText(row.description),
      enumValues,
    };
  });

  return {
    tables: tableRows.map((row) => ({
      name: text(row.table_name),
      schema,
      description: optionalText(row.description),
    })),
    columns,
    primaryKeys: pkRows.map((row) => ({
      table: text(row.table_name),
      column: text(row.column_name),
      position: Number(row.position),
    })),
    foreignKeys: fkRows.map((row) => {
      const referencedSchema = optionalName(row.referenced_schema);
      return {
        table: text(row.table_name),
        constraint: text(row.constraint_name),
        column: text(row.column_name),
        referencedSchema: referencedSchema !== schema ? referencedSchema : undefined,
        referencedTable: text(row.referenced_table),
        referencedColumn: optionalName(row.referenced_column),
      };
    }),
  };
}

// format_type() spells built-in types out; use the short names people write.
const PG_LONG_TYPE = /^(character varying|character|bit varying|timestamp|time)(\(\d+\))?( with time zone| without time zone)?(?=\[|$)/;
const PG_SHORT_BASE: Record<string, string> = {
  'character varying': 'varchar',
  character: 'char',
  'bit varying': 'varbit',
};

/** "character varying(255)" -> "varchar(255)", "timestamp(3) with time zone" -> "timestamptz(3)". */
function shortenPostgresType(type: string): string {
  return type.replace(PG_LONG_TYPE, (_match, base: string, modifier = '', zone = '') => {
    const short = PG_SHORT_BASE[base] ?? base;
    return (zone === ' with time zone' ? `${short}tz` : short) + modifier;
  });
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

async function readMysql(run: RowRunner, options: SchemaExtractionOptions): Promise<RawSchema> {
  const sql = INTROSPECTION_SQL.mysql;
  const params = [options.schema ?? null];
  const wantEnums = options.includeEnumValues !== false;

  const [tableRows, columnRows, keyRows] = await Promise.all([
    run(sql.tables, params),
    run(sql.columns, params),
    bestEffort(run(sql.keys, params)),
  ]);

  const tables: RawTable[] = tableRows.map((row) => ({
    name: text(row.table_name),
    schema: optionalName(row.table_schema),
    // MySQL reports the comment of every view as "VIEW".
    description: text(row.table_type) === 'VIEW' ? undefined : optionalText(row.table_comment),
  }));

  const columns: RawColumn[] = columnRows.map((row) => {
    const dataType = text(row.data_type);
    const columnType = optionalName(row.column_type);
    return {
      table: text(row.table_name),
      name: text(row.column_name),
      dataType,
      nativeType: columnType,
      nullable: text(row.is_nullable) === 'YES',
      description: optionalText(row.column_comment),
      enumValues:
        wantEnums && columnType && dataType.toLowerCase() === 'enum'
          ? parseMysqlEnumValues(columnType)
          : undefined,
    };
  });

  const primaryKeys: RawPrimaryKey[] = [];
  const foreignKeys: RawForeignKey[] = [];
  for (const row of keyRows) {
    const table = text(row.table_name);
    const constraint = text(row.constraint_name);
    if (constraint === 'PRIMARY') {
      primaryKeys.push({ table, column: text(row.column_name), position: Number(row.ordinal_position) });
      continue;
    }
    const referencedSchema = optionalName(row.referenced_table_schema);
    foreignKeys.push({
      table,
      constraint,
      column: text(row.column_name),
      referencedSchema: referencedSchema !== optionalName(row.table_schema) ? referencedSchema : undefined,
      referencedTable: text(row.referenced_table_name),
      referencedColumn: optionalName(row.referenced_column_name),
    });
  }

  return { tables, columns, primaryKeys, foreignKeys };
}

// COLUMN_TYPE quotes each value, doubles embedded quotes and backslash-escapes
// backslashes and some control characters (checked on MySQL 9.4: `\\`, `\n`).
const MYSQL_ENUM_VALUE = /'((?:[^'\\]|''|\\.)*)'/g;
const MYSQL_ESCAPE = /''|\\(.)/g;
const MYSQL_ESCAPES: Record<string, string> = { '0': '\0', n: '\n', r: '\r', t: '\t', Z: '\x1a' };

/** enum('a','it''s','back\\slash') -> ['a', "it's", 'back\slash'] */
function parseMysqlEnumValues(columnType: string): string[] {
  const values: string[] = [];
  for (const match of columnType.matchAll(MYSQL_ENUM_VALUE)) {
    values.push(
      match[1].replace(MYSQL_ESCAPE, (_escape, ch?: string) =>
        ch === undefined ? "'" : MYSQL_ESCAPES[ch] ?? ch
      )
    );
  }
  return values;
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async function readSqlite(run: RowRunner): Promise<RawSchema> {
  const sql = INTROSPECTION_SQL.sqlite;
  let columnRows: Row[];
  let fkRows: Row[];
  try {
    [columnRows, fkRows] = await Promise.all([run(sql.columns), bestEffort(run(sql.foreignKeys))]);
  } catch (error) {
    // Report the bulk query's error if the fallback cannot even list the tables.
    ({ columnRows, fkRows } = await readSqliteFallback(run).catch(() => Promise.reject(error)));
  }

  const tables: RawTable[] = [];
  const columns: RawColumn[] = [];
  const primaryKeys: RawPrimaryKey[] = [];
  let previous: string | undefined;

  for (const row of columnRows) {
    const table = text(row.table_name);
    if (table !== previous) {
      tables.push({ name: table });
      previous = table;
    }
    if (row.column_name === undefined) continue; // fallback row for a table without readable columns
    const name = text(row.column_name);
    const declared = text(row.data_type);
    const pk = Number(row.pk) || 0;
    if (pk > 0) primaryKeys.push({ table, column: name, position: pk });
    columns.push({
      table,
      name,
      dataType: declared,
      nativeType: declared || undefined,
      // SQLite reports notnull = 0 for primary key columns; describe them as required.
      nullable: Number(row.not_null) === 0 && pk === 0,
    });
  }

  return {
    tables,
    columns,
    primaryKeys,
    foreignKeys: fkRows.map((row) => ({
      table: text(row.table_name),
      constraint: text(row.fk_id),
      column: text(row.column_name),
      referencedTable: text(row.referenced_table),
      referencedColumn: optionalName(row.referenced_column),
    })),
  };
}

/**
 * Per-table PRAGMA statements with quoted names, shaped like the bulk rows.
 * A table whose pragma fails is kept with no columns instead of failing the
 * whole extraction.
 */
async function readSqliteFallback(run: RowRunner): Promise<{ columnRows: Row[]; fkRows: Row[] }> {
  const tableNames = (await run(SQLITE_FALLBACK_SQL.tables)).map((row) => text(row.table_name));
  const perTable = await Promise.all(
    tableNames.map((table) =>
      Promise.all([
        run(SQLITE_FALLBACK_SQL.tableInfo(table)).catch((): Row[] | undefined => undefined),
        bestEffort(run(SQLITE_FALLBACK_SQL.foreignKeyList(table))),
      ])
    )
  );

  const columnRows: Row[] = [];
  const fkRows: Row[] = [];
  perTable.forEach(([info, fks], index) => {
    const table = tableNames[index];
    if (!info || info.length === 0) {
      columnRows.push({ table_name: table });
    } else {
      for (const row of info) {
        columnRows.push({
          table_name: table,
          column_name: row.name,
          data_type: row.type,
          not_null: row.notnull,
          pk: row.pk,
        });
      }
    }
    for (const row of fks) {
      fkRows.push({
        table_name: table,
        fk_id: row.id,
        column_name: row.from,
        referenced_table: row.table,
        referenced_column: row.to,
      });
    }
  });

  return { columnRows, fkRows };
}

// ---------------------------------------------------------------------------
// MSSQL
// ---------------------------------------------------------------------------

const MSSQL_LENGTH_TYPES = new Set(['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary']);
const MSSQL_PRECISION_TYPES = new Set(['decimal', 'numeric']);

async function readMssql(run: RowRunner, options: SchemaExtractionOptions): Promise<RawSchema> {
  const sql = INTROSPECTION_SQL.mssql;
  const schema = options.schema ?? 'dbo';
  const params = [schema];

  const [tableRows, columnRows, pkRows, fkRows, descriptionRows] = await Promise.all([
    run(sql.tables, params),
    run(sql.columns, params),
    bestEffort(run(sql.primaryKeys, params)),
    bestEffort(run(sql.foreignKeys, params)),
    options.includeDescriptions !== false ? bestEffort(run(sql.descriptions, params)) : NO_ROWS,
  ]);

  // "table" -> table description, "table\0column" -> column description
  const descriptions = new Map<string, string>();
  for (const row of descriptionRows) {
    const description = optionalText(row.description);
    if (!description) continue;
    const column = optionalName(row.column_name);
    const table = text(row.table_name);
    descriptions.set(column ? `${table}\0${column}` : table, description);
  }

  return {
    tables: tableRows.map((row) => {
      const name = text(row.table_name);
      return { name, schema, description: descriptions.get(name) };
    }),
    columns: columnRows.map((row) => {
      const table = text(row.table_name);
      const name = text(row.column_name);
      const dataType = text(row.data_type);
      return {
        table,
        name,
        dataType,
        nativeType: mssqlNativeType(dataType, row),
        nullable: text(row.is_nullable) === 'YES',
        description: descriptions.get(`${table}\0${name}`),
      };
    }),
    primaryKeys: pkRows.map((row) => ({
      table: text(row.table_name),
      column: text(row.column_name),
      position: Number(row.ordinal_position),
    })),
    foreignKeys: fkRows.map((row) => {
      const referencedSchema = optionalName(row.referenced_schema);
      return {
        table: text(row.table_name),
        constraint: text(row.constraint_name),
        column: text(row.column_name),
        referencedSchema: referencedSchema !== schema ? referencedSchema : undefined,
        referencedTable: text(row.referenced_table),
        referencedColumn: optionalName(row.referenced_column),
      };
    }),
  };
}

/** nvarchar + 255 -> "nvarchar(255)", -1 -> "nvarchar(max)", decimal -> "decimal(10,2)". */
function mssqlNativeType(dataType: string, row: Row): string | undefined {
  if (!dataType) return undefined;
  const lower = dataType.toLowerCase();
  const length = row.character_maximum_length;
  if (MSSQL_LENGTH_TYPES.has(lower) && length !== null && length !== undefined) {
    return `${dataType}(${Number(length) === -1 ? 'max' : Number(length)})`;
  }
  const precision = row.numeric_precision;
  if (MSSQL_PRECISION_TYPES.has(lower) && precision !== null && precision !== undefined) {
    return `${dataType}(${Number(precision)},${Number(row.numeric_scale ?? 0)})`;
  }
  return dataType;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

interface TableParts {
  raw: RawTable;
  columns: RawColumn[];
  primaryKey: RawPrimaryKey[];
  /** Primary key columns in key order, filled once all rows are grouped. */
  primaryKeyColumns: string[];
  foreignKeys: RawForeignKey[];
}

/** Group the catalog rows per table and apply the extraction options. */
function buildTables(raw: RawSchema, options: SchemaExtractionOptions): TableSchema[] {
  const parts = new Map<string, TableParts>();
  for (const table of raw.tables) {
    if (!parts.has(table.name)) {
      parts.set(table.name, { raw: table, columns: [], primaryKey: [], primaryKeyColumns: [], foreignKeys: [] });
    }
  }
  for (const column of raw.columns) parts.get(column.table)?.columns.push(column);
  for (const key of raw.primaryKeys) parts.get(key.table)?.primaryKey.push(key);
  for (const fk of raw.foreignKeys) parts.get(fk.table)?.foreignKeys.push(fk);

  // SQLite and MySQL (lower_case_table_names) may spell an FK target in another case.
  const byLowerName = new Map<string, TableParts>();
  for (const [name, part] of parts) {
    part.primaryKeyColumns = part.primaryKey
      .sort((a, b) => a.position - b.position)
      .map((key) => key.column);
    const lower = name.toLowerCase();
    if (!byLowerName.has(lower)) byLowerName.set(lower, part);
  }
  const findTable = (name: string): TableParts | undefined =>
    parts.get(name) ?? byLowerName.get(name.toLowerCase());

  const include = options.includeTables ? new Set(options.includeTables) : undefined;
  const exclude = options.excludeTables ? new Set(options.excludeTables) : undefined;
  const sensitivePatterns = (options.markSensitiveColumns ?? []).map((p) => p.toLowerCase());
  const withDescriptions = options.includeDescriptions !== false;
  const withEnums = options.includeEnumValues !== false;

  const tables: TableSchema[] = [];
  for (const [name, part] of parts) {
    if (include && !include.has(name)) continue;
    if (exclude && exclude.has(name)) continue;

    const columns = part.columns.map((column) => {
      const lowerName = column.name.toLowerCase();
      // Same fields, in the same order, as 0.0.1; new fields only when they have a value.
      const result: ColumnSchema = {
        name: column.name,
        type: normalizeDataType(column.dataType),
        nullable: column.nullable,
        sensitive: sensitivePatterns.some((pattern) => lowerName.includes(pattern)),
      };
      if (column.nativeType) result.nativeType = column.nativeType;
      if (withEnums && column.enumValues && column.enumValues.length > 0) {
        result.enumValues = column.enumValues;
      }
      if (withDescriptions && column.description) result.description = column.description;
      return result;
    });

    const { primaryKeyColumns } = part;
    const foreignKeys = resolveForeignKeys(part.foreignKeys, findTable);

    const table: TableSchema = {
      name,
      columns,
      primaryKey: primaryKeyColumns.length > 0 ? primaryKeyColumns.join(', ') : undefined,
      foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
    };
    if (primaryKeyColumns.length > 0) table.primaryKeyColumns = primaryKeyColumns;
    if (withDescriptions && part.raw.description) table.description = part.raw.description;
    if (part.raw.schema) table.schema = part.raw.schema;
    tables.push(table);
  }

  return tables;
}

/**
 * Turn FK rows into one ForeignKeySchema per column pair. A missing referenced
 * column (SQLite `REFERENCES parent` without a column list) resolves to the
 * parent's primary key column at the same position; unresolvable pairs are
 * dropped rather than shown as "parent.null".
 */
function resolveForeignKeys(
  rows: RawForeignKey[],
  findTable: (name: string) => TableParts | undefined
): ForeignKeySchema[] {
  const result: ForeignKeySchema[] = [];
  let constraint: string | undefined;
  let position = 0;

  for (const row of rows) {
    position = row.constraint === constraint ? position + 1 : 0;
    constraint = row.constraint;

    let referencedTable = row.referencedTable;
    let referencedColumn = row.referencedColumn;
    if (!row.referencedSchema) {
      const target = findTable(referencedTable);
      if (target) {
        referencedTable = target.raw.name;
        referencedColumn ??= target.primaryKeyColumns[position];
      }
    }
    if (!referencedColumn) continue;

    const fk: ForeignKeySchema = { column: row.column, referencedTable, referencedColumn };
    if (row.referencedSchema) fk.referencedSchema = row.referencedSchema;
    result.push(fk);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/**
 * Lower-case every key and turn driver-specific values into plain ones: BigInt
 * (Prisma, better-sqlite3 safeIntegers) into a number, or a string when it is
 * not a safe integer, and byte buffers (some MySQL information_schema columns)
 * into UTF-8 text.
 */
export function normalizeRows(rows: unknown): Row[] {
  if (!Array.isArray(rows)) {
    throw new Error('Introspection query did not return an array of rows');
  }
  const result: Row[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const source = rows[i] as Row;
    const row: Row = {};
    for (const key of Object.keys(source)) {
      row[key.toLowerCase()] = normalizeValue(source[key]);
    }
    result[i] = row;
  }
  return result;
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8');
  }
  return value;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/** An identifier or type name as stored (never trimmed), or undefined when empty. */
function optionalName(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const result = String(value);
  return result === '' ? undefined : result;
}

const WHITESPACE_RUN = /\s+/g;

/** A comment on one line (whitespace runs collapsed), or undefined when empty. */
function optionalText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const result = String(value).replace(WHITESPACE_RUN, ' ').trim();
  return result === '' ? undefined : result;
}
