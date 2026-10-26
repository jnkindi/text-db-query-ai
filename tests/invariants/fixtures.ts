/**
 * Shared data for the data-access invariant tests: the same tables on SQLite
 * and Postgres, a "full" copy with two users' rows and an "own" copy with
 * only user 1's rows.
 */
import { DatabaseSchema, DatabaseType, SecurityConfig, UserContext } from '../../src/types';

export const USER: UserContext = { userId: 1, role: 'user' };

const TABLES = [
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, product_id INTEGER, total INTEGER)',
  'CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, order_id INTEGER, body TEXT)',
  'CREATE TABLE accounts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email TEXT, password TEXT)',
  'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT)',
  'CREATE TABLE secrets (id INTEGER PRIMARY KEY, user_id INTEGER, token TEXT)',
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
    [4, 1, 99, 'orphan mine'],
  ],
  accounts: [
    [1, 1, 'me@x', 'secret1'],
    [2, 2, 'you@x', 'secret2'],
  ],
  secrets: [
    [1, 1, 'tok1'],
    [2, 2, 'tok2'],
  ],
};

/** CREATE and INSERT statements, optionally with one user's rows only. */
export function setupStatements(onlyUser?: number): string[] {
  const out = [...TABLES];
  for (const [table, rows] of Object.entries(USER_ROWS)) {
    for (const row of rows) {
      if (onlyUser !== undefined && row[1] !== onlyUser) continue;
      out.push(`INSERT INTO ${table} VALUES (${row.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ')})`);
    }
  }
  out.push("INSERT INTO products VALUES (1, 'apple'), (2, 'pear'), (3, 'plum')");
  return out;
}

const cols = (names: string[]) => names.map((name) => ({ name, type: 'string' }));

export function fullSchema(databaseType: DatabaseType): DatabaseSchema {
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
      { name: 'secrets', columns: cols(['id', 'user_id', 'token']) },
    ],
  };
}

/** A hand-written schema that lists only some tables and leaves out a column. */
export function partialSchema(databaseType: DatabaseType): DatabaseSchema {
  return {
    databaseType,
    tables: [
      { name: 'orders', columns: cols(['id', 'user_id', 'total']) },
      { name: 'products', columns: cols(['id', 'name']) },
    ],
  };
}

export const RLS_CONFIG: SecurityConfig = {
  enableRowLevelSecurity: true,
  requireUserContext: false,
  allowUnion: true,
  allowedOperations: ['SELECT'],
  maxRowLimit: 1000,
};

/** Rows as order-independent strings (BigInt counts included). */
export const sortedRows = (rows: Array<Record<string, unknown>>): string[] =>
  rows.map((r) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).sort();

/** Ordinary SELECTs over the syntax families row-level security depends on (portable to SQLite and Postgres). */
export const PORTABLE_SELECTS: Array<readonly [string, string]> = [
  ['single table', 'SELECT id, total FROM orders'],
  ['top-level OR', 'SELECT id FROM orders WHERE total > 100 OR total < 50'],
  ['other user id in WHERE', 'SELECT id FROM orders WHERE user_id = 2'],
  ['double-quoted names', 'SELECT "id" FROM "orders" WHERE "total" > 0'],
  ['schema-qualified main table', 'SELECT id FROM orders o WHERE o.total > 0'],
  ['scalar subquery in select list', 'SELECT id, (SELECT SUM(total) FROM orders) AS s FROM orders'],
  ['subquery in WHERE', 'SELECT id FROM orders WHERE total < (SELECT MAX(total) FROM orders)'],
  ['subquery in HAVING', 'SELECT product_id, COUNT(*) AS n FROM orders GROUP BY product_id HAVING COUNT(*) <= (SELECT COUNT(*) FROM notes)'],
  ['subquery in ORDER BY', 'SELECT id FROM orders ORDER BY (SELECT COUNT(*) FROM notes), id'],
  ['EXISTS', 'SELECT id FROM orders o WHERE EX