/**
 * Row-level security must filter every read of a table that holds user rows,
 * not just the main table: subqueries, CTE bodies, derived tables, extra joins,
 * self-joins and the source of INSERT ... SELECT included.
 *
 * Checked by meaning on SQLite: addRowLevelSecurity(q) run on the full
 * database must return the same rows as q itself run on a copy that holds
 * only user 1's rows. With a schema the rewritten query must also run and
 * pass validation; without one, failing to run is the accepted safe outcome.
 */
import { SecurityValidator } from '../../src/security';
import type { DatabaseSchema, SecurityConfig } from '../../src/types';

function loadSqlite3(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('sqlite3');
  } catch {
    return undefined;
  }
}
const sqlite3 = loadSqlite3();
const describeSqlite = sqlite3 ? describe : describe.skip;

const TABLES = [
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, product_id INTEGER, total INTEGER)',
  'CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, order_id INTEGER, body TEXT)',
  'CREATE TABLE accounts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email TEXT, password TEXT)',
  'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT)',
  'CREATE TABLE archive (id INTEGER, user_id INTEGER, total INTEGER)',
];
const USER_ROWS = {
  orders: [
    [1, 1, 1, 10],
    [2, 1, 2, 30],
    [3, 2, 1, 500],
    [4, 2, 2, 700],
  ],
  notes: [
    [1, 1, 1, 'mine'],
    [2, 2, 3, 'theirs'],
    [3, 2, 4, 'theirs too'],
  ],
  accounts: [
    [1, 1, 'me@example.com', 'secret1'],
    [2, 2, 'you@example.com', 'secret2'],
  ],
};
const PRODUCTS = [
  [1, 'apple'],
  [2, 'pear'],
];

const SCHEMA: DatabaseSchema = {
  databaseType: 'sqlite',
  tables: [
    { name: 'orders', columns: ['id', 'user_id', 'product_id', 'total'].map((name) => ({ name, type: 'number' })) },
    { name: 'notes', columns: ['id', 'user_id', 'order_id', 'body'].map((name) => ({ name, type: 'string' })) },
    {
      name: 'accounts',
      columns: [
        { name: 'id', type: 'number' },
        { name: 'user_id', type: 'number' },
        { name: 'email', type: 'string' },
        { name: 'password', type: 'string', sensitive: true },
      ],
    },
    { name: 'products', columns: [{ name: 'id', type: 'number' }, { name: 'name', type: 'string' }] },
    { name: 'archive', columns: ['id', 'user_id', 'total'].map((name) => ({ name, type: 'number' })) },
  ],
};

const CONFIG: SecurityConfig = {
  enableRowLevelSecurity: true,
  requireUserContext: false,
  allowUnion: true,
  allowedOperations: ['SELECT', 'INSERT'],
  restrictedColumns: ['password'],
  maxRowLimit: 1000,
};
const USER = { userId: 1, role: 'user' };

/** Reads that 0.0.1, and a main-table-only filter, leave open. */
const LEAKS = [
  ['scalar subquery in the select list', 'SELECT id, (SELECT SUM(total) FROM orders) AS everything FROM orders'],
  ['subquery in WHERE', 'SELECT id FROM orders WHERE total < (SELECT MAX(total) FROM orders)'],
  ['EXISTS over the same table', 'SELECT id FROM orders o WHERE EXISTS (SELECT 1 FROM orders x WHERE x.user_id = 2)'],
  ['CTE body', 'WITH t AS (SELECT * FROM orders) SELECT id, user_id, total FROM t'],
  ['derived table', 'SELECT x.id, x.user_id FROM (SELECT * FROM orders) x'],
  ['self-join', 'SELECT o2.id, o2.user_id FROM orders o1 JOIN orders o2 ON 1 = 1'],
  ['join of two user tables', 'SELECT n.id, n.body FROM orders o JOIN notes n ON 1 = 1'],
  ['comma join of two user tables', 'SELECT n.id, n.body FROM orders o, notes n'],
  ['join without aliases', 'SELECT notes.id, notes.body FROM orders JOIN notes ON notes.order_id = orders.id OR 1 = 1'],
  ['subquery in a UNION branch', 'SELECT id FROM orders UNION SELECT id FROM notes WHERE id IN (SELECT id FROM notes)'],
] as const;

/** Queries whose meaning must survive the rewrite unchanged for user 1. */
const KEEPS_MEANING = [
  ['LEFT JOIN keeps orders without notes', 'SELECT o.id, n.id AS note_id FROM orders o LEFT JOIN notes n ON n.order_id = o.id'],
  ['lookup table in a correlated subquery', 'SELECT o.id, (SELECT name FROM products p WHERE p.id = o.product_id) AS product FROM orders o'],
  ['join with a lookup table', 'SELECT o.id, p.name FROM orders o JOIN products p ON p.id = o.product_id'],
  ['protected table joined in, sensitive column left out', 'SELECT a.email FROM orders o JOIN accounts a ON a.user_id = o.user_id'],
  ['plain filter', "SELECT id, total FROM orders WHERE total > 5"],
] as const;

describeSqlite('row-level security covers every read (SQLite)', () => {
  let full: any;
  let own: any;
  const run = (db: any, sql: string): Promise<any[]> =>
    new Promise((resolve, reject) => db.all(sql, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows))));
  const sorted = (rows: any[]) => rows.map((r) => JSON.stringify(r)).sort();

  async function load(db: any, onlyUser?: number): Promise<void> {
    for (const s of TABLES) await run(db, s);
    for (const [table, rows] of Object.entries(USER_ROWS)) {
      for (const row of rows) {
        if (onlyUser !== undefined && row[1] !== onlyUser) continue;
        const values = row.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ');
        await run(db, `INSERT INTO ${table} VALUES (${values})`);
      }
    }
    for (const [id, name] of PRODUCTS) await run(db, `INSERT INTO products VALUES (${id}, '${name}')`);
  }

  beforeAll(async () => {
    full = new sqlite3.Database(':memory:');
    own = new sqlite3.Database(':memory:');
    await load(full);
    await load(own, 1);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => full.close(() => resolve()));
    await new Promise<void>((resolve) => own.close(() => resolve()));
  });

  describe('with a schema', () => {
    const validator = new SecurityValidator(CONFIG, { databaseType: 'sqlite', schema: SCHEMA });

    it.each([...LEAKS, ...KEEPS_MEANING])('%s', async (_name, sql) => {
      const filtered = validator.addRowLevelSecurity(sql, USER);
      expect(sorted(await run(full, filtered))).toEqual(sorted(await run(own, sql)));
      const check = await validator.validate(filtered, USER);
      expect(check.errors).toEqual([]);
    });

    it('filters the source of INSERT ... SELECT but not the INSERT target', async () => {
      const sql = 'INSERT INTO archive SELECT id, user_id, total FROM orders';
      const filtered = validator.addRowLevelSecurity(sql, USER);
      await run(full, 'DELETE FROM archive');
      await run(full, filtered);
      expect(await run(full, 'SELECT DISTINCT user_id FROM archive')).toEqual([{ user_id: 1 }]);
      await run(full, 'DELETE FROM archive');
      expect(validator.addRowLevelSecurity('INSERT INTO archive (id, user_id, total) VALUES (9, 1, 1)', USER)).toBe(
        'INSERT INTO archive (id, user_id, total) VALUES (9, 1, 1)',
      );
    });

    it('keeps the 0.0.1 text for a single table', () => {
      expect(validator.addRowLevelSecurity('SELECT * FROM orders', USER)).toBe('SELECT * FROM orders WHERE user_id = 1');
      expect(validator.addRowLevelSecurity('SELECT * FROM orders WHERE user_id = 1', USER)).toBe(
        'SELECT * FROM orders WHERE user_id = 1',
      );
    });

    it('filters a table before a column-renaming alias (Postgres syntax)', () => {
      const pg = new SecurityValidator(CONFIG, { databaseType: 'postgres', schema: { ...SCHEMA, databaseType: 'postgres' } });
      // An unqualified filter inside the subquery would bind to the outer orders, since o renames user_id away.
      expect(pg.addRowLevelSecurity('SELECT id, (SELECT SUM(t) FROM orders AS o(a, b, c, t)) AS s FROM orders', USER)).toBe(
        'SELECT id, (SELECT SUM(t) FROM (SELECT id, user_id, product_id, total FROM orders AS __rls WHERE __rls.user_id = 1) AS o(a, b, c, t)) AS s FROM orders WHERE user_id = 1',
      );
    });

    it('leaves lookup tables alone', () => {
      const sql = 'SELECT o.id, p.name FROM orders o JOIN products p ON p.id = o.product_id';
      expect(validator.addRowLevelSecurity(sql, USER)).toBe(`${sql} WHERE o.user_id = 1`);
    });
  });

  describe('without a schema', () => {
    const validator = new SecurityValidator(CONFIG, { databaseType: 'sqlite' });

    it.each(LEAKS)('%s', async (_name, sql) => {
      const filtered = validator.addRowLevelSecurity(sql, USER);
      let rows: any[] | undefined;
      try {
        rows = await run(full, filtered);
      } catch {
        return; // failing to run is safe: no rows leave the database
      }
      expect(sorted(rows)).toEqual(sorted(await run(own, sql)));
    });

    it('keeps the unqualified 0.0.1 filter for a join, which a second user table makes ambiguous', async () => {
      const sql = 'SELECT o.id, p.name FROM orders o JOIN products p ON p.id = o.product_id';
      expect(validator.addRowLevelSecurity(sql, USER)).toBe(`${sql} WHERE user_id = 1`);
      await expect(run(full, validator.addRowLevelSecurity('SELECT o.id FROM orders o JOIN notes n ON 1 = 1', USER))).rejects.toThrow(
        /ambiguous/,
      );
    });

    it('does not count a filter on one table of a join as covering the others', () => {
      const out = validator.addRowLevelSecurity('SELECT n.body FROM orders o, notes n WHERE o.user_id = 1', USER);
      expect(out).toBe('SELECT n.body FROM orders o, notes n WHERE o.user_id = 1 AND user_id = 1');
    });
  });
});
