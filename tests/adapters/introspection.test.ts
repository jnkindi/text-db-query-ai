/**
 * Tests for the shared introspection core, with fake executors that record
 * every query.
 */

import {
  introspectSchema,
  normalizeDataType,
  normalizeRows,
  INTROSPECTION_SQL,
  SQLITE_FALLBACK_SQL,
} from '../../src/adapters/introspection';
import { DatabaseIntrospectionAdapter, PrismaAdapter } from '../../src/adapters';
import { IntrospectionExecutor } from '../../src/adapters/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('text-db-query-ai-legacy');

type Rows = Record<string, unknown>[];
type Handler = (params?: unknown[]) => Rows;
type Dialect = keyof typeof INTROSPECTION_SQL;

interface Call {
  sql: string;
  params?: unknown[];
}

/** Executor that answers known SQL with canned rows and records every call. */
function fakeExecutor(handlers: Record<string, Handler>): { execute: IntrospectionExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const bySql = new Map(Object.entries(handlers));
  const execute: IntrospectionExecutor = async (sql, params) => {
    calls.push({ sql, params });
    const handler = bySql.get(sql);
    if (!handler) throw new Error(`unexpected SQL: ${sql}`);
    return handler(params);
  };
  return { execute, calls };
}

const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `t${i}`);

// ---------------------------------------------------------------------------
// Fake catalogs: table t<i> has id (PK), label, parent_id -> t<i-1>.id, status (enum)
// ---------------------------------------------------------------------------

function postgresCatalog(count: number): Record<string, Handler> {
  const sql = INTROSPECTION_SQL.postgres;
  const tables = names(count);
  return {
    [sql.tables]: () => tables.map((t) => ({ table_name: t, description: t === 't1' ? ' Second\n  table ' : null })),
    [sql.columns]: () =>
      tables.flatMap((t) => [
        { table_name: t, column_name: 'id', data_type: 'integer', native_type: 'integer', enum_schema: null, enum_name: null, is_nullable: 'NO', description: null },
        { table_name: t, column_name: 'label', data_type: 'character varying', native_type: 'character varying(50)', enum_schema: null, enum_name: null, is_nullable: 'YES', description: 'Shown to users' },
        { table_name: t, column_name: 'parent_id', data_type: 'integer', native_type: 'integer', enum_schema: null, enum_name: null, is_nullable: 'YES', description: null },
        { table_name: t, column_name: 'status', data_type: 'USER-DEFINED', native_type: 'status', enum_schema: 'public', enum_name: 'status', is_nullable: 'NO', description: null },
      ]),
    [sql.primaryKeys]: () => tables.map((t) => ({ table_name: t, column_name: 'id', position: 1 })),
    [sql.foreignKeys]: () =>
      tables.slice(1).map((t, i) => ({
        table_name: t,
        constraint_name: `${t}_parent_id_fkey`,
        position: 1,
        column_name: 'parent_id',
        referenced_schema: 'public',
        referenced_table: tables[i],
        referenced_column: 'id',
      })),
    [sql.enums]: () => [
      { enum_schema: 'public', enum_name: 'status', label: 'on' },
      { enum_schema: 'public', enum_name: 'status', label: 'off' },
    ],
  };
}

/**
 * MySQL rows with upper-case keys, as MySQL 8 returns unaliased information_schema
 * columns. The adapter aliases every column to its lower-case name, so these read
 * the same as aliased rows.
 */
function mysqlCatalog(count: number): Record<string, Handler> {
  const sql = INTROSPECTION_SQL.mysql;
  const tables = names(count);
  return {
    [sql.tables]: () =>
      tables.map((t) => ({ TABLE_SCHEMA: 'app', TABLE_NAME: t, TABLE_TYPE: 'BASE TABLE', TABLE_COMMENT: t === 't1' ? 'Second table' : '' })),
    [sql.columns]: () =>
      tables.flatMap((t) => [
        { TABLE_NAME: t, COLUMN_NAME: 'id', DATA_TYPE: 'int', COLUMN_TYPE: 'int unsigned', IS_NULLABLE: 'NO', COLUMN_COMMENT: '' },
        { TABLE_NAME: t, COLUMN_NAME: 'label', DATA_TYPE: 'varchar', COLUMN_TYPE: 'varchar(50)', IS_NULLABLE: 'YES', COLUMN_COMMENT: 'Shown to users' },
        { TABLE_NAME: t, COLUMN_NAME: 'parent_id', DATA_TYPE: 'int', COLUMN_TYPE: 'int unsigned', IS_NULLABLE: 'YES', COLUMN_COMMENT: '' },
        { TABLE_NAME: t, COLUMN_NAME: 'status', DATA_TYPE: 'enum', COLUMN_TYPE: "enum('on','off')", IS_NULLABLE: 'NO', COLUMN_COMMENT: '' },
      ]),
    [sql.keys]: () => [
      ...tables.map((t) => ({ TABLE_SCHEMA: 'app', TABLE_NAME: t, CONSTRAINT_NAME: 'PRIMARY', COLUMN_NAME: 'id', ORDINAL_POSITION: 1, REFERENCED_TABLE_SCHEMA: null, REFERENCED_TABLE_NAME: null, REFERENCED_COLUMN_NAME: null })),
      ...tables.slice(1).map((t, i) => ({ TABLE_SCHEMA: 'app', TABLE_NAME: t, CONSTRAINT_NAME: `${t}_ibfk_1`, COLUMN_NAME: 'parent_id', ORDINAL_POSITION: 1, REFERENCED_TABLE_SCHEMA: 'app', REFERENCED_TABLE_NAME: tables[i], REFERENCED_COLUMN_NAME: 'id' })),
    ],
  };
}

function sqliteCatalog(count: number): Record<string, Handler> {
  const sql = INTROSPECTION_SQL.sqlite;
  const tables = names(count);
  return {
    [sql.columns]: () =>
      tables.flatMap((t) => [
        { table_name: t, cid: 0, column_name: 'id', data_type: 'INTEGER', not_null: 0, pk: 1 },
        { table_name: t, cid: 1, column_name: 'label', data_type: 'VARCHAR(50)', not_null: 0, pk: 0 },
        { table_name: t, cid: 2, column_name: 'parent_id', data_type: 'INTEGER', not_null: 0, pk: 0 },
        { table_name: t, cid: 3, column_name: 'status', data_type: 'TEXT', not_null: 1, pk: 0 },
      ]),
    // REFERENCES T<i-1> without a column list: resolved to that table's primary key.
    [sql.foreignKeys]: () =>
      tables.slice(1).map((t, i) => ({
        table_name: t, fk_id: 0, seq: 0, referenced_table: tables[i].toUpperCase(), column_name: 'parent_id', referenced_column: null,
      })),
  };
}

function mssqlCatalog(count: number): Record<string, Handler> {
  const sql = INTROSPECTION_SQL.mssql;
  const tables = names(count);
  const column = (t: string, name: string, type: string, length: number | null, precision: number | null, nullable: string) => ({
    table_name: t, column_name: name, data_type: type, character_maximum_length: length,
    numeric_precision: precision, numeric_scale: precision === null ? null : 0, is_nullable: nullable,
  });
  return {
    [sql.tables]: () => tables.map((t) => ({ table_schema: 'dbo', table_name: t })),
    [sql.columns]: () =>
      tables.flatMap((t) => [
        column(t, 'id', 'int', null, 10, 'NO'),
        column(t, 'label', 'nvarchar', 50, null, 'YES'),
        column(t, 'parent_id', 'int', null, 10, 'YES'),
        column(t, 'status', 'nvarchar', -1, null, 'NO'),
      ]),
    [sql.primaryKeys]: () => tables.map((t) => ({ table_name: t, column_name: 'id', ordinal_position: 1 })),
    [sql.foreignKeys]: () =>
      tables.slice(1).map((t, i) => ({
        table_name: t, constraint_name: `FK_${t}_parent`, position: 1, column_name: 'parent_id', referenced_schema: 'dbo', referenced_table: tables[i], referenced_column: 'id',
      })),
    [sql.descriptions]: () => [
      { table_name: 't1', column_name: null, description: 'Second table' },
      ...tables.map((t) => ({ table_name: t, column_name: 'label', description: 'Shown to users' })),
    ],
  };
}

const CATALOGS = {
  postgres: { build: postgresCatalog, queries: 5, params: ['public'] },
  mysql: { build: mysqlCatalog, queries: 3, params: [null] },
  sqlite: { build: sqliteCatalog, queries: 2, params: undefined },
  mssql: { build: mssqlCatalog, queries: 5, params: ['dbo'] },
} as const;

const DIALECTS = Object.keys(CATALOGS) as Dialect[];

/** Text between SELECT and the first top-level FROM, split on top-level commas. */
function selectList(sql: string): string[] {
  const start = sql.search(/\bSELECT\b/i) + 'SELECT'.length;
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && /^\s+FROM\b/i.test(sql.slice(i))) break;
    if (depth === 0 && ch === ',') {
      items.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current.trim());
  return items;
}

describe('introspectSchema', () => {
  describe.each(DIALECTS)('%s', (dialect) => {
    const { build, queries, params } = CATALOGS[dialect];

    it('uses the same number of queries for 1 and 50 tables', async () => {
      const one = fakeExecutor(build(1));
      const fifty = fakeExecutor(build(50));

      const small = await introspectSchema(one.execute, dialect);
      const large = await introspectSchema(fifty.execute, dialect);

      expect(small.tables).toHaveLength(1);
      expect(large.tables).toHaveLength(50);
      expect(one.calls).toHaveLength(queries);
      expect(fifty.calls).toHaveLength(queries);
    });

    it('sends only fixed SQL with the schema bound as a parameter', async () => {
      const { execute, calls } = fakeExecutor(build(50));
      await introspectSchema(execute, dialect);

      const known = Object.values(INTROSPECTION_SQL[dialect]) as string[];
      for (const call of calls) {
        expect(known).toContain(call.sql);
        expect(call.sql).not.toMatch(/\bt\d+\b/); // no table name is ever interpolated
        expect(call.params).toEqual(params);
      }
      expect(new Set(calls.map((c) => c.sql)).size).toBe(calls.length);
    });

    it('aliases every selected column to a lower-case name', () => {
      for (const sql of Object.values(INTROSPECTION_SQL[dialect]) as string[]) {
        for (const item of selectList(sql)) {
          expect(item).toMatch(/\sAS [a-z_]+$/);
        }
      }
    });

    it('groups columns, keys and foreign keys per table', async () => {
      const { execute } = fakeExecutor(build(3));
      const schema = await introspectSchema(execute, dialect);
      const t1 = schema.tables[1];

      expect(schema.databaseType).toBe(dialect);
      expect(t1.name).toBe('t1');
      expect(t1.columns.map((c) => [c.name, c.type, c.nullable, c.sensitive])).toEqual([
        ['id', 'integer', false, false],
        ['label', 'varchar', true, false],
        ['parent_id', 'integer', true, false],
        ['status', dialect === 'sqlite' ? 'text' : 'varchar', false, false],
      ]);
      expect(t1.primaryKey).toBe('id');
      expect(t1.primaryKeyColumns).toEqual(['id']);
      expect(t1.foreignKeys).toEqual([{ column: 'parent_id', referencedTable: 't0', referencedColumn: 'id' }]);
      expect(schema.tables[0].foreignKeys).toBeUndefined();
    });
  });

  describe('SQL shape', () => {
    const pg = INTROSPECTION_SQL.postgres;
    const mysql = INTROSPECTION_SQL.mysql;
    const sqlite = INTROSPECTION_SQL.sqlite;
    const mssql = INTROSPECTION_SQL.mssql;

    it('postgres reads pg_catalog with the schema bound as $1', () => {
      for (const sql of Object.values(pg)) {
        expect(sql).toContain('n.nspname = $1');
        expect(sql).not.toMatch(/regclass|information_schema/i);
      }
      // Same table kinds as pg_tables in 0.0.1, and the information_schema privilege filter.
      expect(pg.tables).toContain("c.relkind IN ('r', 'p')");
      expect(pg.columns).toContain("has_column_privilege(c.oid, a.attnum, 'SELECT, INSERT, UPDATE, REFERENCES')");
      expect(pg.columns).toContain('format_type(a.atttypid, a.atttypmod) AS native_type');
      expect(pg.columns).toContain('col_description(c.oid, a.attnum)');
      expect(pg.tables).toContain("obj_description(c.oid, 'pg_class')");
      // Composite FKs are paired by position, never cross-joined.
      expect(pg.foreignKeys).toContain('unnest(con.conkey, con.confkey) WITH ORDINALITY');
      expect(pg.primaryKeys).toContain("con.contype = 'p'");
      expect(pg.enums).toContain('ORDER BY tn.nspname, t.typname, e.enumsortorder');
    });

    it('mysql reads information_schema for one schema, keys ordered by ORDINAL_POSITION', () => {
      for (const sql of Object.values(mysql)) {
        expect(sql).toContain('TABLE_SCHEMA = COALESCE(?, DATABASE())');
      }
      expect(mysql.columns).toContain('COLUMN_TYPE AS column_type');
      expect(mysql.columns).toContain('COLUMN_COMMENT AS column_comment');
      expect(mysql.tables).toContain('TABLE_COMMENT AS table_comment');
      expect(mysql.keys).toContain('FROM information_schema.KEY_COLUMN_USAGE');
      expect(mysql.keys).toMatch(/ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION$/);
    });

    it('sqlite joins sqlite_master with the table-valued pragmas and skips sqlite_ tables', () => {
      expect(sqlite.columns).toContain('JOIN pragma_table_info(m.name) AS p');
      expect(sqlite.foreignKeys).toContain('JOIN pragma_foreign_key_list(m.name) AS f');
      for (const sql of Object.values(sqlite)) {
        expect(sql).toContain("m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'");
      }
    });

    it('mssql binds the schema as @P1 and reads MS_Description', () => {
      for (const sql of Object.values(mssql)) {
        expect(sql).toContain('@P1');
        expect(sql).not.toContain('@tableName');
      }
      expect(mssql.tables).toContain("TABLE_TYPE = 'BASE TABLE'");
      expect(mssql.descriptions).toContain("ep.name = N'MS_Description'");
    });
  });

  it('reads postgres native types, enum labels and descriptions', async () => {
    const { execute } = fakeExecutor(postgresCatalog(2));
    const { tables } = await introspectSchema(execute, 'postgres');

    expect(tables[1]).toEqual({
      name: 't1',
      schema: 'public',
      description: 'Second table',
      columns: [
        { name: 'id', type: 'integer', nullable: false, sensitive: false, nativeType: 'integer' },
        { name: 'label', type: 'varchar', nullable: true, sensitive: false, nativeType: 'varchar(50)', description: 'Shown to users' },
        { name: 'parent_id', type: 'integer', nullable: true, sensitive: false, nativeType: 'integer' },
        { name: 'status', type: 'varchar', nullable: false, sensitive: false, nativeType: 'status', enumValues: ['on', 'off'] },
      ],
      primaryKey: 'id',
      primaryKeyColumns: ['id'],
      foreignKeys: [{ column: 'parent_id', referencedTable: 't0', referencedColumn: 'id' }],
    });
  });

  it('reads MySQL rows whatever the case of their keys', async () => {
    const { execute } = fakeExecutor(mysqlCatalog(2));
    const { tables } = await introspectSchema(execute, 'mysql');

    expect(tables[1]).toEqual({
      name: 't1',
      schema: 'app',
      description: 'Second table',
      columns: [
        { name: 'id', type: 'integer', nullable: false, sensitive: false, nativeType: 'int unsigned' },
        { name: 'label', type: 'varchar', nullable: true, sensitive: false, nativeType: 'varchar(50)', description: 'Shown to users' },
        { name: 'parent_id', type: 'integer', nullable: true, sensitive: false, nativeType: 'int unsigned' },
        { name: 'status', type: 'varchar', nullable: false, sensitive: false, nativeType: "enum('on','off')", enumValues: ['on', 'off'] },
      ],
      primaryKey: 'id',
      primaryKeyColumns: ['id'],
      foreignKeys: [{ column: 'parent_id', referencedTable: 't0', referencedColumn: 'id' }],
    });
  });

  it('decodes MySQL enum literals as COLUMN_TYPE escapes them', async () => {
    const catalog = mysqlCatalog(1);
    catalog[INTROSPECTION_SQL.mysql.columns] = () => [
      // Values: x, it's, back\slash, new<LF>line, a,b
      { table_name: 't0', column_name: 'e', data_type: 'enum', column_type: "enum('x','it''s','back\\\\slash','new\\nline','a,b')", is_nullable: 'YES', column_comment: '' },
    ];
    const { tables } = await introspectSchema(fakeExecutor(catalog).execute, 'mysql');
    expect(tables[0].columns[0].enumValues).toEqual(['x', "it's", 'back\\slash', 'new\nline', 'a,b']);
  });

  it('passes the MySQL schema option instead of DATABASE()', async () => {
    const { execute, calls } = fakeExecutor(mysqlCatalog(1));
    await introspectSchema(execute, 'mysql', { schema: 'reporting' });
    expect(calls.map((c) => c.params)).toEqual([['reporting'], ['reporting'], ['reporting']]);
  });

  it('marks MySQL foreign keys to another database with referencedSchema', async () => {
    const catalog = mysqlCatalog(1);
    catalog[INTROSPECTION_SQL.mysql.keys] = () => [
      { table_schema: 'app', table_name: 't0', constraint_name: 'fk_x', column_name: 'parent_id', ordinal_position: 1, referenced_table_schema: 'shared', referenced_table_name: 'parents', referenced_column_name: 'id' },
    ];
    const { tables } = await introspectSchema(fakeExecutor(catalog).execute, 'mysql');
    expect(tables[0].foreignKeys).toEqual([
      { column: 'parent_id', referencedTable: 'parents', referencedColumn: 'id', referencedSchema: 'shared' },
    ]);
  });

  it('resolves SQLite implicit FK targets to the parent primary key, matching names case-insensitively', async () => {
    const { execute } = fakeExecutor(sqliteCatalog(2));
    const { tables } = await introspectSchema(execute, 'sqlite');

    expect(tables[1]).toEqual({
      name: 't1',
      columns: [
        { name: 'id', type: 'integer', nullable: false, sensitive: false, nativeType: 'INTEGER' },
        { name: 'label', type: 'varchar', nullable: true, sensitive: false, nativeType: 'VARCHAR(50)' },
        { name: 'parent_id', type: 'integer', nullable: true, sensitive: false, nativeType: 'INTEGER' },
        { name: 'status', type: 'text', nullable: false, sensitive: false, nativeType: 'TEXT' },
      ],
      primaryKey: 'id',
      primaryKeyColumns: ['id'],
      foreignKeys: [{ column: 'parent_id', referencedTable: 't0', referencedColumn: 'id' }],
    });
  });

  it('drops a SQLite FK whose implicit target has no primary key instead of printing "null"', async () => {
    const catalog = sqliteCatalog(2);
    catalog[INTROSPECTION_SQL.sqlite.foreignKeys] = () => [
      { table_name: 't1', fk_id: 0, seq: 0, referenced_table: 'missing', column_name: 'parent_id', referenced_column: null },
    ];
    const { tables } = await introspectSchema(fakeExecutor(catalog).execute, 'sqlite');
    expect(tables[1].foreignKeys).toBeUndefined();
  });

  describe('SQLite without table-valued pragmas', () => {
    /** Answers the per-table PRAGMA statements; the bulk query fails as on SQLite < 3.16. */
    function oldSqlite(count: number, broken: string[] = []): Record<string, Handler> {
      const tables = [...names(count), 'order'];
      const handlers: Record<string, Handler> = {
        [INTROSPECTION_SQL.sqlite.columns]: () => { throw new Error('SQLITE_ERROR: no such table: pragma_table_info'); },
        [INTROSPECTION_SQL.sqlite.foreignKeys]: () => { throw new Error('SQLITE_ERROR: no such table: pragma_foreign_key_list'); },
        [SQLITE_FALLBACK_SQL.tables]: () => tables.map((t) => ({ table_name: t })),
      };
      for (const t of tables) {
        handlers[SQLITE_FALLBACK_SQL.tableInfo(t)] = () => {
          if (broken.includes(t)) throw new Error('SQLITE_ERROR: no such module: fts5');
          return [
            { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
            { cid: 1, name: 'ref', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
          ];
        };
        handlers[SQLITE_FALLBACK_SQL.foreignKeyList(t)] = () =>
          t === 'order' ? [{ id: 0, seq: 0, table: 't0', from: 'ref', to: null }] : [];
      }
      return handlers;
    }

    it('falls back to quoted per-table PRAGMA statements', async () => {
      const { execute, calls } = fakeExecutor(oldSqlite(2));
      const { tables } = await introspectSchema(execute, 'sqlite');

      expect(SQLITE_FALLBACK_SQL.tableInfo('order')).toBe('PRAGMA table_info("order")');
      expect(SQLITE_FALLBACK_SQL.tableInfo('a"b')).toBe('PRAGMA table_info("a""b")');
      expect(calls).toHaveLength(2 + 1 + 3 * 2);
      expect(tables.map((t) => t.name)).toEqual(['t0', 't1', 'order']);
      expect(tables[2]).toEqual({
        name: 'order',
        columns: [
          { name: 'id', type: 'integer', nullable: false, sensitive: false, nativeType: 'INTEGER' },
          { name: 'ref', type: 'integer', nullable: false, sensitive: false, nativeType: 'INTEGER' },
        ],
        primaryKey: 'id',
        primaryKeyColumns: ['id'],
        foreignKeys: [{ column: 'ref', referencedTable: 't0', referencedColumn: 'id' }],
      });
    });

    it('keeps a table whose pragma fails, without columns', async () => {
      const { execute } = fakeExecutor(oldSqlite(2, ['t1']));
      const { tables } = await introspectSchema(execute, 'sqlite');
      expect(tables.map((t) => [t.name, t.columns.length])).toEqual([['t0', 2], ['t1', 0], ['order', 2]]);
    });

    it('reports the bulk query error when the fallback fails too', async () => {
      const catalog = sqliteCatalog(1);
      catalog[INTROSPECTION_SQL.sqlite.columns] = () => { throw new Error('SQLITE_CORRUPT: database disk image is malformed'); };
      await expect(introspectSchema(fakeExecutor(catalog).execute, 'sqlite')).rejects.toThrow('SQLITE_CORRUPT');
    });
  });

  it('reads MSSQL lengths, precision and MS_Description', async () => {
    const { execute } = fakeExecutor(mssqlCatalog(2));
    const { tables } = await introspectSchema(execute, 'mssql');

    expect(tables[1]).toEqual({
      name: 't1',
      schema: 'dbo',
      description: 'Second table',
      columns: [
        { name: 'id', type: 'integer', nullable: false, sensitive: false, nativeType: 'int' },
        { name: 'label', type: 'varchar', nullable: true, sensitive: false, nativeType: 'nvarchar(50)', description: 'Shown to users' },
        { name: 'parent_id', type: 'integer', nullable: true, sensitive: false, nativeType: 'int' },
        { name: 'status', type: 'varchar', nullable: false, sensitive: false, nativeType: 'nvarchar(max)' },
      ],
      primaryKey: 'id',
      primaryKeyColumns: ['id'],
      foreignKeys: [{ column: 'parent_id', referencedTable: 't0', referencedColumn: 'id' }],
    });
  });

  it('uses the mssql schema option', async () => {
    const { execute, calls } = fakeExecutor(mssqlCatalog(1));
    const { tables } = await introspectSchema(execute, 'mssql', { schema: 'sales' });
    expect(calls.every((c) => JSON.stringify(c.params) === '["sales"]')).toBe(true);
    expect(tables[0].schema).toBe('sales');
  });

  it('formats MSSQL decimal precision', async () => {
    const catalog = mssqlCatalog(1);
    catalog[INTROSPECTION_SQL.mssql.columns] = () => [
      { table_name: 't0', column_name: 'amount', data_type: 'decimal', character_maximum_length: null, numeric_precision: 10, numeric_scale: 2, is_nullable: 'NO' },
    ];
    const { tables } = await introspectSchema(fakeExecutor(catalog).execute, 'mssql');
    expect(tables[0].columns[0]).toMatchObject({ type: 'decimal', nativeType: 'decimal(10,2)' });
  });

  it('shortens Postgres type names without touching user-defined ones', async () => {
    const catalog = postgresCatalog(1);
    const column = (name: string, dataType: string, nativeType: string) => ({
      table_name: 't0', column_name: name, data_type: dataType, native_type: nativeType,
      enum_schema: null, enum_name: null, is_nullable: 'YES', description: null,
    });
    catalog[INTROSPECTION_SQL.postgres.columns] = () => [
      column('a', 'timestamp with time zone', 'timestamp(3) with time zone'),
      column('b', 'timestamp without time zone', 'timestamp without time zone'),
      column('c', 'ARRAY', 'character varying(255)[]'),
      column('d', 'time with time zone', 'time with time zone'),
      column('e', 'character', 'character(2)'),
      column('f', 'USER-DEFINED', 'time_slot'),
      column('g', 'bit varying', 'bit varying(8)'),
      column('h', 'uuid', 'uuid'),
      column('i', 'jsonb', 'jsonb'),
      column('j', 'numeric', 'numeric(10,2)'),
    ];
    const { tables } = await introspectSchema(fakeExecutor(catalog).execute, 'postgres');

    expect(tables[0].columns.map((c) => [c.type, c.nativeType])).toEqual([
      ['timestamp', 'timestamptz(3)'],
      ['timestamp', 'timestamp'],
      ['varchar', 'varchar(255)[]'],
      ['varchar', 'timetz'],
      ['varchar', 'char(2)'],
      ['varchar', 'time_slot'],
      ['varchar', 'varbit(8)'],
      ['varchar', 'uuid'],
      ['json', 'jsonb'],
      ['decimal', 'numeric(10,2)'],
    ]);
  });

  it('qualifies a Postgres enum from another schema and keeps enum arrays', async () => {
    const catalog = postgresCatalog(1);
    catalog[INTROSPECTION_SQL.postgres.columns] = () => [
      { table_name: 't0', column_name: 'kind', data_type: 'USER-DEFINED', native_type: 'shared.kind', enum_schema: 'shared', enum_name: 'kind', is_nullable: 'YES', description: null },
      { table_name: 't0', column_name: 'kinds', data_type: 'ARRAY', native_type: 'shared.kind[]', enum_schema: 'shared', enum_name: 'kind', is_nullable: 'YES', description: null },
      { table_name: 't0', column_name: 'role', data_type: 'USER-DEFINED', native_type: '"Role"', enum_schema: 'public', enum_name: 'Role', is_nullable: 'YES', description: null },
    ];
    catalog[INTROSPECTION_SQL.postgres.enums] = () => [
      { enum_schema: 'shared', enum_name: 'kind', label: 'a' },
      { enum_schema: 'shared', enum_name: 'kind', label: 'b' },
      { enum_schema: 'public', enum_name: 'Role', label: 'USER' },
    ];
    const { tables } = await introspectSchema(fakeExecutor(catalog).execute, 'postgres');

    expect(tables[0].columns.map((c) => [c.nativeType, c.enumValues])).toEqual([
      ['shared.kind', ['a', 'b']],
      ['shared.kind[]', ['a', 'b']],
      ['Role', ['USER']],
    ]);
  });

  it('pairs composite foreign keys by position and marks other schemas', async () => {
    const catalog = postgresCatalog(2);
    catalog[INTROSPECTION_SQL.postgres.foreignKeys] = () => [
      { table_name: 't1', constraint_name: 'a_fk', position: 1, column_name: 'x', referenced_schema: 'public', referenced_table: 't0', referenced_column: 'a' },
      { table_name: 't1', constraint_name: 'a_fk', position: 2, column_name: 'y', referenced_schema: 'public', referenced_table: 't0', referenced_column: 'b' },
      { table_name: 't1', constraint_name: 'b_fk', position: 1, column_name: 'z', referenced_schema: 'billing', referenced_table: 'invoice', referenced_column: 'id' },
    ];
    const { tables } = await introspectSchema(fakeExecutor(catalog).execute, 'postgres');

    expect(tables[1].foreignKeys).toEqual([
      { column: 'x', referencedTable: 't0', referencedColumn: 'a' },
      { column: 'y', referencedTable: 't0', referencedColumn: 'b' },
      { column: 'z', referencedTable: 'invoice', referencedColumn: 'id', referencedSchema: 'billing' },
    ]);
  });

  it('joins composite primary keys in key order', async () => {
    const catalog = postgresCatalog(1);
    catalog[INTROSPECTION_SQL.postgres.primaryKeys] = () => [
      { table_name: 't0', column_name: 'label', position: 2 },
      { table_name: 't0', column_name: 'id', position: 1 },
    ];
    const { tables } = await introspectSchema(fakeExecutor(catalog).execute, 'postgres');
    expect(tables[0].primaryKey).toBe('id, label');
    expect(tables[0].primaryKeyColumns).toEqual(['id', 'label']);
  });

  describe('options', () => {
    it('filters tables with includeTables and excludeTables (exact names, as in 0.0.1)', async () => {
      const { execute, calls } = fakeExecutor(postgresCatalog(5));
      const included = await introspectSchema(execute, 'postgres', { includeTables: ['t1', 't3', 'T4'] });
      expect(included.tables.map((t) => t.name)).toEqual(['t1', 't3']);

      const excluded = await introspectSchema(execute, 'postgres', { excludeTables: ['t0', 't2'] });
      expect(excluded.tables.map((t) => t.name)).toEqual(['t1', 't3', 't4']);
      expect(calls).toHaveLength(10);
    });

    it('marks sensitive columns by case-insensitive substring', async () => {
      const { execute } = fakeExecutor(postgresCatalog(1));
      const { tables } = await introspectSchema(execute, 'postgres', { markSensitiveColumns: ['LAB', 'parent'] });
      expect(tables[0].columns.map((c) => c.sensitive)).toEqual([false, true, true, false]);
    });

    it('leaves out descriptions with includeDescriptions: false', async () => {
      for (const dialect of ['postgres', 'mysql', 'mssql'] as const) {
        const { execute, calls } = fakeExecutor(CATALOGS[dialect].build(2));
        const { tables } = await introspectSchema(execute, dialect, { includeDescriptions: false });
        expect(tables[1].description).toBeUndefined();
        expect(tables[1].columns.every((c) => c.description === undefined)).toBe(true);
        if (dialect === 'mssql') expect(calls).toHaveLength(4);
      }
    });

    it('leaves out enum values with includeEnumValues: false, skipping the enum query', async () => {
      const { execute, calls } = fakeExecutor(postgresCatalog(1));
      const { tables } = await introspectSchema(execute, 'postgres', { includeEnumValues: false });
      expect(calls).toHaveLength(4);
      expect(calls.map((c) => c.sql)).not.toContain(INTROSPECTION_SQL.postgres.enums);
      expect(tables[0].columns[3]).toEqual({ name: 'status', type: 'varchar', nullable: false, sensitive: false, nativeType: 'status' });

      const mysql = fakeExecutor(mysqlCatalog(1));
      const result = await introspectSchema(mysql.execute, 'mysql', { includeEnumValues: false });
      expect(result.tables[0].columns[3].enumValues).toBeUndefined();
    });

    it('uses the postgres schema option', async () => {
      const { execute, calls } = fakeExecutor(postgresCatalog(1));
      const { tables } = await introspectSchema(execute, 'postgres', { schema: 'billing' });
      expect(calls.every((c) => (c.params as unknown[])[0] === 'billing')).toBe(true);
      expect(tables[0].schema).toBe('billing');
    });
  });

  describe('failures', () => {
    it('keeps going without keys when the key queries fail, as 0.0.1 did', async () => {
      const sql = INTROSPECTION_SQL.postgres;
      const catalog = postgresCatalog(2);
      catalog[sql.primaryKeys] = () => { throw new Error('permission denied'); };
      catalog[sql.foreignKeys] = () => { throw new Error('permission denied'); };
      catalog[sql.enums] = () => { throw new Error('permission denied'); };
      const { tables } = await introspectSchema(fakeExecutor(catalog).execute, 'postgres');

      expect(tables).toHaveLength(2);
      expect(tables[1].primaryKey).toBeUndefined();
      expect(tables[1].foreignKeys).toBeUndefined();
      expect(tables[1].columns[3].enumValues).toBeUndefined();
    });

    it('rejects when the table or column query fails', async () => {
      for (const dialect of ['postgres', 'mysql', 'mssql'] as const) {
        const catalog = CATALOGS[dialect].build(1);
        catalog[INTROSPECTION_SQL[dialect].columns] = () => { throw new Error('boom'); };
        await expect(introspectSchema(fakeExecutor(catalog).execute, dialect)).rejects.toThrow('boom');
      }
    });

    it('rejects a result that is not a row array', async () => {
      const execute: IntrospectionExecutor = async () => ({ rows: [] }) as any;
      await expect(introspectSchema(execute, 'postgres')).rejects.toThrow('did not return an array of rows');
    });

    it('rejects unsupported database types with the 0.0.1 message', async () => {
      await expect(introspectSchema(async () => [], 'mongodb')).rejects.toThrow('Unsupported database type: mongodb');
    });
  });
});

describe('adapters use the shared core', () => {
  it('DatabaseIntrospectionAdapter: 50 tables in 5 round trips over a pg-style connection', async () => {
    const { execute, calls } = fakeExecutor(postgresCatalog(50));
    const connection = { query: async (sql: string, params?: unknown[]) => ({ rows: await execute(sql, params) }) };

    const schema = await new DatabaseIntrospectionAdapter(connection, 'postgres').extractSchema();
    expect(schema.tables).toHaveLength(50);
    expect(calls).toHaveLength(5);
  });

  it('DatabaseIntrospectionAdapter keeps the 0.0.1 error prefix', async () => {
    const connection = { query: async () => { throw new Error('connection refused'); } };
    await expect(new DatabaseIntrospectionAdapter(connection, 'postgres').extractSchema()).rejects.toThrow(
      'Failed to introspect database: connection refused'
    );
  });

  it('PrismaAdapter: spreads parameters into $queryRawUnsafe and converts BigInt', async () => {
    const { execute, calls } = fakeExecutor(mysqlCatalog(50));
    const toBigInt = (rows: Rows) =>
      rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) out[key] = typeof value === 'number' ? BigInt(value) : value;
        return out;
      });
    const prisma = {
      $queryRawUnsafe: jest.fn(async (sql: string, ...params: unknown[]) => toBigInt(await execute(sql, params))),
    };

    const schema = await new PrismaAdapter(prisma, 'mysql').extractSchema();
    expect(schema.tables).toHaveLength(50);
    expect(schema.tables[3].primaryKeyColumns).toEqual(['id']);
    expect(schema.tables[3].foreignKeys).toEqual([{ column: 'parent_id', referencedTable: 't2', referencedColumn: 'id' }]);
    expect(calls).toHaveLength(3);
    for (const call of prisma.$queryRawUnsafe.mock.calls) {
      expect(call).toHaveLength(2);
      expect(call[1]).toBeNull();
    }
  });

  it('PrismaAdapter keeps the 0.0.1 error prefix', async () => {
    const prisma = { $queryRawUnsafe: async () => { throw new Error('P1001'); } };
    await expect(new PrismaAdapter(prisma).extractSchema()).rejects.toThrow('Failed to extract Prisma schema: P1001');
  });
});

describe('normalizeRows', () => {
  it('lower-cases keys and converts BigInt and byte values', () => {
    const rows = normalizeRows([
      { TABLE_NAME: 'a', Position: BigInt(3), Huge: BigInt('9007199254740993'), Raw: Buffer.from('varchar(10)') },
    ]);
    expect(rows).toEqual([{ table_name: 'a', position: 3, huge: '9007199254740993', raw: 'varchar(10)' }]);
  });

  it('reads rows without a prototype (node:sqlite)', () => {
    const row = Object.assign(Object.create(null), { NAME: 'x' });
    expect(normalizeRows([row])).toEqual([{ name: 'x' }]);
  });
});

describe('normalizeDataType', () => {
  it('matches the 0.0.1 mapping exactly', () => {
    const legacyAdapter = new legacy.DatabaseIntrospectionAdapter({}, 'postgres');
    const samples = [
      'integer', 'bigint', 'smallint', 'int unsigned', 'INTEGER', 'interval', 'point', 'character varying',
      'varchar', 'nvarchar', 'char', 'text', 'longtext', 'boolean', 'bool', 'tinyint(1)', 'bit',
      'timestamp with time zone', 'datetime', 'datetime2', 'date', 'time', 'numeric', 'decimal', 'real',
      'double precision', 'float', 'json', 'jsonb', 'uuid', 'USER-DEFINED', 'ARRAY', 'bytea', 'BLOB', '',
      'enum', 'set', 'money', 'uniqueidentifier', 'datetimeoffset', 'smalldatetime',
    ];
    for (const sample of samples) {
      expect([sample, normalizeDataType(sample)]).toEqual([sample, legacyAdapter.normalizeDataType(sample)]);
    }
  });
});
