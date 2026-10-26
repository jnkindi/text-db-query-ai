/**
 * SQLite introspection against real in-memory databases: the sqlite3 package,
 * and node:sqlite when the Node version has it.
 */

import { DatabaseIntrospectionAdapter } from '../../src/adapters';
import { TableSchema } from '../../src/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('text-db-query-ai-legacy');

function load(name: string): { module?: any; error?: string } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return { module: require(name) };
  } catch (error: any) {
    return { error: String(error?.message ?? error).split('\n')[0] };
  }
}

const DDL = `
  CREATE TABLE "Group" (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE "order" (
    id INTEGER PRIMARY KEY,
    group_id INTEGER REFERENCES "group",
    total REAL,
    placed_at DATETIME NOT NULL,
    note
  );
  CREATE TABLE membership (
    user_id INTEGER NOT NULL,
    group_id INTEGER NOT NULL REFERENCES "Group"(id),
    role VARCHAR(20) DEFAULT 'member',
    PRIMARY KEY (user_id, group_id)
  ) WITHOUT ROWID;
  CREATE TABLE "line item" (
    order_id INTEGER,
    line_no INTEGER,
    qty INT NOT NULL,
    PRIMARY KEY (order_id, line_no),
    FOREIGN KEY (order_id) REFERENCES "order"(id)
  );
  CREATE TABLE audit (
    m_user INTEGER,
    m_group INTEGER,
    FOREIGN KEY (m_user, m_group) REFERENCES membership(user_id, group_id)
  );
  CREATE VIEW group_names AS SELECT name FROM "Group";
  CREATE INDEX order_group ON "order"(group_id);
  INSERT INTO "Group" (name) VALUES ('admins'), ('users');
`;

const column = (name: string, type: string, nullable: boolean, nativeType?: string) => {
  const result: Record<string, unknown> = { name, type, nullable, sensitive: false };
  if (nativeType) result.nativeType = nativeType;
  return result;
};

/** Sorted by name as SQLite sorts (BINARY): upper case first. */
const EXPECTED: TableSchema[] = [
  {
    name: 'Group',
    columns: [column('id', 'integer', false, 'INTEGER'), column('name', 'text', false, 'TEXT')] as any,
    primaryKey: 'id',
    primaryKeyColumns: ['id'],
    foreignKeys: undefined,
  },
  {
    name: 'audit',
    columns: [column('m_user', 'integer', true, 'INTEGER'), column('m_group', 'integer', true, 'INTEGER')] as any,
    primaryKey: undefined,
    // A composite FK gives one entry per column pair.
    foreignKeys: [
      { column: 'm_user', referencedTable: 'membership', referencedColumn: 'user_id' },
      { column: 'm_group', referencedTable: 'membership', referencedColumn: 'group_id' },
    ],
  },
  {
    name: 'line item',
    columns: [
      column('order_id', 'integer', false, 'INTEGER'),
      column('line_no', 'integer', false, 'INTEGER'),
      column('qty', 'integer', false, 'INT'),
    ] as any,
    primaryKey: 'order_id, line_no',
    primaryKeyColumns: ['order_id', 'line_no'],
    foreignKeys: [{ column: 'order_id', referencedTable: 'order', referencedColumn: 'id' }],
  },
  {
    name: 'membership',
    columns: [
      column('user_id', 'integer', false, 'INTEGER'),
      column('group_id', 'integer', false, 'INTEGER'),
      column('role', 'varchar', true, 'VARCHAR(20)'),
    ] as any,
    primaryKey: 'user_id, group_id',
    primaryKeyColumns: ['user_id', 'group_id'],
    foreignKeys: [{ column: 'group_id', referencedTable: 'Group', referencedColumn: 'id' }],
  },
  {
    name: 'order',
    columns: [
      column('id', 'integer', false, 'INTEGER'),
      column('group_id', 'integer', true, 'INTEGER'),
      column('total', 'varchar', true, 'REAL'), // the 0.0.1 mapping is kept; nativeType has the real type
      column('placed_at', 'timestamp', false, 'DATETIME'),
      column('note', 'varchar', true),
    ] as any,
    primaryKey: 'id',
    primaryKeyColumns: ['id'],
    // `REFERENCES "group"` (no column, other case) resolves to "Group".id.
    foreignKeys: [{ column: 'group_id', referencedTable: 'Group', referencedColumn: 'id' }],
  },
];

const sqlite3 = load('sqlite3');
const describeSqlite3 = sqlite3.module ? describe : describe.skip;
const sqlite3Title = sqlite3.module
  ? 'sqlite3 (in-memory)'
  : `sqlite3 (skipped: the sqlite3 native module could not be loaded, e.g. installed with --ignore-scripts: ${sqlite3.error})`;

describeSqlite3(sqlite3Title, () => {
  let db: any;

  beforeAll(async () => {
    db = new sqlite3.module.Database(':memory:');
    await new Promise<void>((resolve, reject) => db.exec(DDL, (err: Error | null) => (err ? reject(err) : resolve())));
  });

  afterAll(() => new Promise<void>((resolve) => db.close(() => resolve())));

  it('extracts reserved and quoted table names, composite keys and FKs in 2 queries', async () => {
    const all = jest.spyOn(db, 'all');
    try {
      const schema = await new DatabaseIntrospectionAdapter(db, 'sqlite').extractSchema();
      expect(schema).toEqual({ databaseType: 'sqlite', tables: EXPECTED });
      expect(all).toHaveBeenCalledTimes(2);
    } finally {
      all.mockRestore();
    }
  });

  it('works where 0.0.1 failed on the reserved table names', async () => {
    await expect(new legacy.DatabaseIntrospectionAdapter(db, 'sqlite').extractSchema()).rejects.toThrow(/syntax error/);
  });

  it('applies includeTables and markSensitiveColumns', async () => {
    const schema = await new DatabaseIntrospectionAdapter(db, 'sqlite', {
      includeTables: ['order', 'Group'],
      markSensitiveColumns: ['NAME'],
    }).extractSchema();
    expect(schema.tables.map((t) => t.name)).toEqual(['Group', 'order']);
    expect(schema.tables[0].columns.map((c) => c.sensitive)).toEqual([false, true]);
  });

  it('executes queries with bound parameters against a reserved table name', async () => {
    const adapter = new DatabaseIntrospectionAdapter(db, 'sqlite');
    await expect(adapter.executeQuery('SELECT name FROM "Group" WHERE id = ?', [2])).resolves.toEqual([{ name: 'users' }]);
  });
});

const nodeSqlite = load('node:sqlite');
const describeNodeSqlite = nodeSqlite.module?.DatabaseSync ? describe : describe.skip;

describeNodeSqlite('node:sqlite (in-memory)', () => {
  it('extracts the same schema through prepare()', async () => {
    const db = new nodeSqlite.module.DatabaseSync(':memory:');
    try {
      db.exec(DDL);
      const schema = await new DatabaseIntrospectionAdapter(db, 'sqlite').extractSchema();
      expect(schema).toEqual({ databaseType: 'sqlite', tables: EXPECTED });
    } finally {
      db.close();
    }
  });
});
