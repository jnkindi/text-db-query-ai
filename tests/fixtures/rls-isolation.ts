/**
 * Row-level security checked by the rows the rewritten SQL returns, shared by
 * the SQLite tests (tests/security) and the Postgres tests
 * (tests/integration/pglite.test.ts, which owns the one PGlite process).
 */
import { SecurityValidator } from '../../src/security/validator';
import { DatabaseSchema, DatabaseType, SecurityConfig, UserContext } from '../../src/types';

export interface Executor {
  run(sql: string): Promise<Array<Record<string, unknown>>>;
}

const user = (userId: unknown): UserContext => ({ userId: userId as string | number, role: 'user' });

// ---------------------------------------------------------------------------
// Isolation: every filtered query returns only user 1's rows

export const ISOLATION_SETUP = [
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, status TEXT, total REAL, note TEXT)',
  "INSERT INTO orders VALUES (1, 1, 'paid', 10, NULL), (2, 2, 'paid', 20, NULL), (3, 2, 'refunded', 5, 'user_id = 1'), (4, 1, 'new', 0, 'user_id = 1')",
  'CREATE TABLE docs (id INTEGER PRIMARY KEY, owner TEXT NOT NULL)',
  "INSERT INTO docs VALUES (1, 'O''Brien'), (2, 'x'), (3, 'someone')",
];

/** Queries a model might produce; each must return only the current user's rows once filtered. */
const ISOLATION_QUERIES = [
  'SELECT * FROM orders',
  "SELECT * FROM orders WHERE status = 'paid' OR status = 'refunded'",
  'SELECT * FROM orders WHERE user_id = 2',
  'SELECT * FROM orders WHERE user_id = 1 OR 1=1',
  'SELECT * FROM orders WHERE total > 0 OR user_id = 1',
  'SELECT * FROM orders WHERE user_id IS NOT NULL',
  "SELECT * FROM orders WHERE note = 'user_id = 1'",
  'SELECT user_id, status, COUNT(*) AS n FROM orders GROUP BY user_id, status HAVING COUNT(*) > 0 ORDER BY status',
  'SELECT user_id, id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM orders ORDER BY id LIMIT 10',
  'SELECT user_id FROM orders UNION ALL SELECT user_id FROM orders',
  'SELECT * FROM (SELECT * FROM orders) o',
  'WITH x AS (SELECT * FROM orders WHERE user_id = 2) SELECT * FROM x',
  'SELECT * FROM orders WHERE id IN (SELECT id FROM orders WHERE user_id = 1)',
];

export async function expectIsolation(db: Executor, databaseType: DatabaseType): Promise<void> {
  const v = new SecurityValidator({ enableRowLevelSecurity: true }, { databaseType });
  for (const q of ISOLATION_QUERIES) {
    const filtered = v.addRowLevelSecurity(q, user(1));
    const rows = await db.run(filtered);
    const others = rows.map((r) => Number(r.user_id)).filter((id) => id !== 1);
    expect({ q, filtered, others }).toEqual({ q, filtered, others: [] });
  }
  // The unfiltered query does see the other user, so the checks above are meaningful
  expect((await db.run('SELECT * FROM orders')).some((r) => Number(r.user_id) === 2)).toBe(true);
  expect((await db.run(v.addRowLevelSecurity("SELECT * FROM orders WHERE status = 'paid' OR status = 'refunded'", user(1)))).length).toBe(1);
  // String ids: quotes are escaped, so the injection attempt matches nothing
  const s = new SecurityValidator({ enableRowLevelSecurity: true, rowLevelSecurityColumn: 'owner' }, { databaseType });
  expect(await db.run(s.addRowLevelSecurity('SELECT * FROM docs', user("x' OR '1'='1")))).toEqual([]);
  const mine = await db.run(s.addRowLevelSecurity('SELECT * FROM docs ORDER BY id', user("O'Brien")));
  expect(mine.map((r) => r.owner)).toEqual(["O'Brien"]);
}

// ---------------------------------------------------------------------------
// Coverage: every read of a user table is filtered, judged by meaning.
// addRowLevelSecurity(q) on the full data must return what q itself returns
// on a copy that holds only user 1's rows.

const COVERAGE_TABLES = [
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, product_id INTEGER, total INTEGER)',
  'CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, order_id INTEGER, body TEXT)',
  'CREATE TABLE accounts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email TEXT, password TEXT)',
  'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT)',
  'CREATE TABLE archive (id INTEGER, user_id INTEGER, total INTEGER)',
];
const USER_ROWS: Record<string, Array<Array<string | number>>> = {
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

/** CREATE and INSERT statements for the coverage tables, optionally with one user's rows only. */
export function coverageSetup(onlyUser?: number): string[] {
  const out = [...COVERAGE_TABLES];
  for (const [table, rows] of Object.entries(USER_ROWS)) {
    for (const row of rows) {
      if (onlyUser !== undefined && row[1] !== onlyUser) continue;
      out.push(`INSERT INTO ${table} VALUES (${row.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ')})`);
    }
  }
  for (const [id, name] of PRODUCTS) out.push(`INSERT INTO products VALUES (${id}, '${name}')`);
  return out;
}

export function coverageSchema(databaseType: DatabaseType): DatabaseSchema {
  const cols = (names: string[]) => names.map((name) => ({ name, type: 'string' }));
  return {
    databaseType,
    tables: [
      { name: 'orders', columns: cols(['id', 'user_id', 'product_id', 'total']) },
      { name: 'notes', columns: cols(['id', 'user_id', 'order_id', 'body']) },
      {
        name: 'accounts',
        columns: [...cols(['id', 'user_id', 'email']), { name: 'password', type: 'string', sensitive: true }],
      },
      { name: 'products', columns: cols(['id', 'name']) },
      { name: 'archive', columns: cols(['id', 'user_id', 'total']) },
    ],
  };
}

export const COVERAGE_CONFIG: SecurityConfig = {
  enableRowLevelSecurity: true,
  requireUserContext: false,
  allowUnion: true,
  allowedOperations: ['SELECT', 'INSERT'],
  restrictedColumns: ['password'],
  maxRowLimit: 1000,
};
export const COVERAGE_USER = user(1);

/** Reads that 0.0.1, and a main-table-only filter, leave open. */
export const COVERAGE_LEAKS: Array<readonly [string, string]> = [
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
  // `orders` here is the alias of notes: it does not filter the table aliased o
  ["a filter on an alias that is another table's name", 'SELECT o.id AS oid, orders.id AS nid FROM orders o JOIN notes orders ON 1 = 1 WHERE orders.user_id = 1'],
  ['a filter on one joined table', 'SELECT o.id AS oid, x.id AS xid FROM orders o JOIN orders x ON 1 = 1 WHERE x.user_id = 1'],
];

/** Postgres-only syntax: a column-renaming alias and LATERAL. */
export const POSTGRES_COVERAGE_LEAKS: Array<readonly [string, string]> = [
  ['column-renaming alias in a subquery', 'SELECT id, (SELECT SUM(t) FROM orders AS o(a, b, c, t)) AS s FROM orders'],
  ['LATERAL subquery', 'SELECT o.id, l.n FROM orders o CROSS JOIN LATERAL (SELECT COUNT(*) AS n FROM notes x WHERE x.order_id = o.id OR TRUE) l'],
];

/** Queries whose meaning must survive the rewrite unchanged for user 1. */
export const COVERAGE_KEEPS_MEANING: Array<readonly [string, string]> = [
  ['LEFT JOIN keeps orders without notes', 'SELECT o.id, n.id AS note_id FROM orders o LEFT JOIN notes n ON n.order_id = o.id'],
  ['lookup table in a correlated subquery', 'SELECT o.id, (SELECT name FROM products p WHERE p.id = o.product_id) AS product FROM orders o'],
  ['join with a lookup table', 'SELECT o.id, p.name FROM orders o JOIN products p ON p.id = o.product_id'],
  ['protected table joined in, sensitive column left out', 'SELECT a.email FROM orders o JOIN accounts a ON a.user_id = o.user_id'],
  ['plain filter', 'SELECT id, total FROM orders WHERE total > 5'],
  // The level's own table has no user column; the filter must bind to the derived table's
  ['lookup table joined to a per-user aggregate', 'SELECT p.name, t.cnt FROM products p JOIN (SELECT user_id, product_id, COUNT(*) AS cnt FROM orders GROUP BY user_id, product_id) t ON t.product_id = p.id'],
];

/** Rows as order-independent, driver-independent strings (BigInt counts included). */
export const sortedRows = (rows: Array<Record<string, unknown>>): string[] =>
  rows.map((r) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).sort();

/**
 * With a schema the rewritten query must also run and pass validation;
 * without one, failing to run is accepted as safe (no rows leave the database).
 */
export async function expectSameRows(
  validator: SecurityValidator,
  full: Executor,
  own: Executor,
  sql: string,
  mustRun: boolean
): Promise<void> {
  const filtered = validator.addRowLevelSecurity(sql, COVERAGE_USER);
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await full.run(filtered);
  } catch (error) {
    if (mustRun) throw new Error(`${(error as Error).message}\n  in: ${filtered}`);
    return;
  }
  expect({ sql, filtered, rows: sortedRows(rows) }).toEqual({ sql, filtered, rows: sortedRows(await own.run(sql)) });
  if (mustRun) expect((await validator.validate(filtered, COVERAGE_USER)).errors).toEqual([]);
}
