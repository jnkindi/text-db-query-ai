/**
 * Invariant tests for the three documented data-access guarantees:
 *   1. Row-level security (addRowLevelSecurity / generateQuery)
 *   2. allowedTables
 *   3. restrictedColumns / enforceSensitiveColumns
 *
 * Each guarantee is exercised across many SQL-syntax families and, where the
 * guarantee is about rows, the final SQL is executed on a real engine and the
 * rows are compared:
 *   - SQLite in-process (sqlite3)
 *   - Postgres via PGlite in a child process (tests/integration/helpers)
 *
 * Tests named "GUARANTEE HOLDS" document behaviour the library gets right.
 * Tests named "regression" pin inputs that once broke a guarantee (single-quoted
 * SQLite table names, outer joins); each must keep holding.
 */

import { SecurityValidator } from '../../src/security';
import { QueryGenerator } from '../../src/generator/query-generator';
import { BaseLLMProvider } from '../../src/providers/base';
import { DatabaseSchema, DatabaseType, SecurityConfig, UserContext } from '../../src/types';
import { startPGlite, PGliteProcess } from '../integration/helpers/pglite-process';

jest.setTimeout(60000);

// ---------------------------------------------------------------------------
// Shared data: user 1 and user 2 rows, plus a copy holding only user 1's rows.
// ---------------------------------------------------------------------------

const TABLES_SQLITE = [
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, product_id INTEGER, total INTEGER)',
  'CREATE TABLE notes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, order_id INTEGER, body TEXT)',
  'CREATE TABLE accounts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, email TEXT, password TEXT)',
  'CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT)',
  'CREATE TABLE secrets (id INTEGER PRIMARY KEY, user_id INTEGER, token TEXT)',
];

const ROWS: Record<string, Array<Array<string | number>>> = {
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
    [1, 1, 'me@example.com', 'secret1'],
    [2, 2, 'you@example.com', 'secret2'],
  ],
  secrets: [
    [1, 1, 'tok1'],
    [2, 2, 'tok2'],
  ],
};
const PRODUCTS = [
  [1, 'apple'],
  [2, 'pear'],
  [3, 'plum'], // never ordered: exercises LEFT JOIN null-extension
];

function inserts(onlyUser?: number): string[] {
  const out: string[] = [];
  for (const [table, rows] of Object.entries(ROWS)) {
    for (const row of rows) {
      if (onlyUser !== undefined && row[1] !== onlyUser) continue;
      out.push(`INSERT INTO ${table} VALUES (${row.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ')})`);
    }
  }
  for (const [id, name] of PRODUCTS) out.push(`INSERT INTO products VALUES (${id}, '${name}')`);
  return out;
}

const col = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: 'string', ...extra });

/** Full schema; pass undefined for the generic (no databaseType) dialect. */
function schema(databaseType?: DatabaseType): DatabaseSchema {
  return {
    databaseType,
    tables: [
      { name: 'orders', columns: [col('id'), col('user_id'), col('product_id'), col('total')] },
      { name: 'notes', columns: [col('id'), col('user_id'), col('order_id'), col('body')] },
      { name: 'accounts', columns: [col('id'), col('user_id'), col('email'), col('password', { sensitive: true })] },
      { name: 'products', columns: [col('id'), col('name')] },
      { name: 'secrets', columns: [col('id'), col('user_id'), col('token')] },
    ],
  } as DatabaseSchema;
}

const USER: UserContext = { userId: 1, role: 'user' };
const sortRows = (rows: Array<Record<string, unknown>>): string[] =>
  rows.map((r) => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))).sort();

interface Engine {
  run(sql: string): Promise<Array<Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------
// sqlite3 engine
// ---------------------------------------------------------------------------

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

const RLS_CONFIG: SecurityConfig = {
  enableRowLevelSecurity: true,
  requireUserContext: false,
  allowUnion: true,
  allowedOperations: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  restrictedColumns: ['password'],
  maxRowLimit: 1000,
};

describeSqlite('SQLite data-access invariants', () => {
  let full: any;
  let own: any;
  const q = (db: any, sql: string): Promise<Array<Record<string, unknown>>> =>
    new Promise((resolve, reject) => db.all(sql, (e: Error | null, r: any[]) => (e ? reject(e) : resolve(r))));
  const fullEngine: Engine = { run: (sql) => q(full, sql) };
  const ownEngine: Engine = { run: (sql) => q(own, sql) };

  beforeAll(async () => {
    full = new sqlite3.Database(':memory:');
    own = new sqlite3.Database(':memory:');
    for (const s of [...TABLES_SQLITE, ...inserts()]) await q(full, s);
    for (const s of [...TABLES_SQLITE, ...inserts(1)]) await q(own, s);
  });
  afterAll(async () => {
    await new Promise<void>((r) => full.close(() => r()));
    await new Promise<void>((r) => own.close(() => r()));
  });

  // -------------------------------------------------------------------------
  // Guarantee 1: row-level security
  // -------------------------------------------------------------------------
  describe('Guarantee 1: row-level security (SELECT returns exactly the own-copy rows or fails to run, never another user row)', () => {
    const withSchema = () => new SecurityValidator(RLS_CONFIG, { databaseType: 'sqlite', schema: schema('sqlite') });
    const noSchema = () => new SecurityValidator(RLS_CONFIG, { databaseType: 'sqlite' });

    /** Rewritten query on full data must equal original on the user-1-only copy, or fail to run. */
    async function assertSameOrFails(v: SecurityValidator, sql: string, mustRun: boolean): Promise<void> {
      const filtered = v.addRowLevelSecurity(sql, USER);
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await fullEngine.run(filtered);
      } catch (e) {
        if (mustRun) throw new Error(`${(e as Error).message}\n  in: ${filtered}`);
        return; // failed to run: no rows leave the database
      }
      expect({ sql, filtered, rows: sortRows(rows) }).toEqual({ sql, filtered, rows: sortRows(await ownEngine.run(sql)) });
      if (mustRun) expect((await v.validate(filtered, USER)).errors).toEqual([]);
    }

    const HOLDS: Array<[string, string]> = [
      ['plain select', 'SELECT id, total FROM orders'],
      ['where with OR', "SELECT id FROM orders WHERE total > 0 OR user_id = 2"],
      ['already-filtered other user id', 'SELECT id FROM orders WHERE user_id = 2'],
      ['group by / having', 'SELECT user_id, COUNT(*) n FROM orders GROUP BY user_id HAVING COUNT(*) > 0'],
      ['window function', 'SELECT id, user_id, ROW_NUMBER() OVER (ORDER BY id) rn FROM orders'],
      ['order by / limit', 'SELECT id FROM orders ORDER BY id LIMIT 10'],
      ['union all', 'SELECT user_id FROM orders UNION ALL SELECT user_id FROM orders'],
      ['intersect', 'SELECT id FROM orders INTERSECT SELECT order_id FROM notes'],
      ['except', 'SELECT id FROM orders EXCEPT SELECT order_id FROM notes'],
      ['derived table', 'SELECT x.id, x.user_id FROM (SELECT * FROM orders) x'],
      ['cte body', 'WITH t AS (SELECT * FROM orders) SELECT id, user_id FROM t'],
      ['scalar subquery in select list', 'SELECT id, (SELECT SUM(total) FROM orders) s FROM orders'],
      ['subquery in where', 'SELECT id FROM orders WHERE total < (SELECT MAX(total) FROM orders)'],
      ['exists correlated', 'SELECT id FROM orders o WHERE EXISTS (SELECT 1 FROM orders x WHERE x.user_id = 2)'],
      ['self join', 'SELECT o2.id, o2.user_id FROM orders o1 JOIN orders o2 ON 1 = 1'],
      ['join of two user tables', 'SELECT n.id, n.body FROM orders o JOIN notes n ON 1 = 1'],
      ['comma join of two user tables', 'SELECT n.id, n.body FROM orders o, notes n'],
      ['alias named like another table', 'SELECT o.id oid, orders.id nid FROM orders o JOIN notes orders ON 1 = 1 WHERE orders.user_id = 1'],
      ['lookup table joined (left)', 'SELECT o.id, p.name FROM orders o LEFT JOIN products p ON p.id = o.product_id'],
      ['left join keeps own rows without match', 'SELECT o.id, n.id nid FROM orders o LEFT JOIN notes n ON n.order_id = o.id'],
      ['correlated lookup subquery', 'SELECT o.id, (SELECT name FROM products p WHERE p.id = o.product_id) product FROM orders o'],
      ['recursive cte reading a user table', 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < (SELECT COUNT(*) FROM notes)) SELECT o.id, (SELECT MAX(n) FROM r) m FROM orders o'],
      ['double-quoted identifier table', 'SELECT z.id, z.user_id FROM (SELECT * FROM "orders") z'],
      ['backtick identifier table', 'SELECT z.id, z.user_id FROM (SELECT * FROM `orders`) z'],
      ['bracket identifier table', 'SELECT z.id, z.user_id FROM (SELECT * FROM [orders]) z'],
    ];

    describe.each([
      ['with schema', withSchema],
      ['without schema', noSchema],
    ])('%s', (_label, make) => {
      it.each(HOLDS)('GUARANTEE HOLDS: %s', async (_name, sql) => {
        // without a schema, a lookup table in a subquery may legitimately fail to run
        await assertSameOrFails(make(), sql, _label === 'with schema' ? !sql.includes('products') || !/\(SELECT/.test(sql) : false);
      });
    });

    // ---- regression RLS-1: a single-quoted table name in a correlated subquery must be filtered ----
    it('regression (RLS-1, with schema): single-quoted table in a correlated subquery returns another user\'s row', async () => {
      const v = withSchema();
      const sql = "SELECT o.id, (SELECT body FROM 'notes' x WHERE x.user_id = 2 LIMIT 1) AS leak FROM orders o";
      const filtered = v.addRowLevelSecurity(sql, USER);
      expect((await v.validate(filtered, USER)).valid).toBe(true); // passes validation
      const leaked = await fullEngine.run(filtered);
      const bodies = leaked.map((r) => r.leak).filter((b) => b !== null);
      // Guarantee: the rewritten query must never return another user's data.
      expect(bodies).toEqual([]);
    });

    it('regression (RLS-1, without schema): same leak with no schema', async () => {
      const v = noSchema();
      const sql = "SELECT o.id, (SELECT body FROM 'notes' x WHERE x.user_id = 2 LIMIT 1) AS leak FROM orders o";
      const filtered = v.addRowLevelSecurity(sql, USER);
      const leaked = await fullEngine.run(filtered);
      expect(leaked.map((r) => r.leak).filter((b) => b !== null)).toEqual([]);
    });

    it('regression (RLS-1): single-quoted table aggregate leaks other users\' totals', async () => {
      const v = withSchema();
      const sql = "SELECT id, (SELECT SUM(total) FROM 'orders') AS s FROM orders";
      const filtered = v.addRowLevelSecurity(sql, USER);
      const rowsFull = await fullEngine.run(filtered);
      const rowsOwn = await ownEngine.run(sql);
      // Guarantee 1: filtered-on-full must equal original-on-own-copy.
      expect(sortRows(rowsFull)).toEqual(sortRows(rowsOwn));
    });

    // ---- regression RLS-2: a user table on the nullable side of an outer join keeps the user's own rows ----
    it('regression (RLS-2, with schema): LEFT JOIN with the user table on the nullable side drops the user\'s own rows', async () => {
      const v = withSchema();
      const sql = 'SELECT p.id, o.id AS oid FROM products p LEFT JOIN orders o ON o.product_id = p.id';
      const filtered = v.addRowLevelSecurity(sql, USER);
      expect((await v.validate(filtered, USER)).valid).toBe(true);
      const rowsFull = await fullEngine.run(filtered);
      const rowsOwn = await ownEngine.run(sql); // product 3 appears with oid=null
      expect(sortRows(rowsFull)).toEqual(sortRows(rowsOwn));
    });

    it('regression (RLS-2): RIGHT JOIN with the user table wrapped drops the user\'s own unmatched rows', async () => {
      const v = withSchema();
      const sql = 'SELECT o.id, n.id AS nid FROM notes n RIGHT JOIN orders o ON n.order_id = o.id';
      const filtered = v.addRowLevelSecurity(sql, USER);
      const rowsFull = await fullEngine.run(filtered);
      const rowsOwn = await ownEngine.run(sql); // order 2 (no note) appears with nid=null
      expect(sortRows(rowsFull)).toEqual(sortRows(rowsOwn));
    });

    // ---- UPDATE / DELETE write scoping holds ----
    it('GUARANTEE HOLDS: UPDATE only touches the user\'s rows', async () => {
      const v = withSchema();
      const db = new sqlite3.Database(':memory:');
      const r = (s: string) => q(db, s);
      for (const s of [...TABLES_SQLITE, ...inserts()]) await r(s);
      await r(v.addRowLevelSecurity('UPDATE orders SET total = 0 WHERE total > 0 OR user_id = 2', USER));
      const after = await r('SELECT user_id, total FROM orders WHERE user_id = 2 ORDER BY id');
      await new Promise<void>((res) => db.close(() => res()));
      expect(after).toEqual([{ user_id: 2, total: 500 }, { user_id: 2, total: 700 }]); // user 2 untouched
    });

    it('GUARANTEE HOLDS: DELETE only touches the user\'s rows', async () => {
      const v = withSchema();
      const db = new sqlite3.Database(':memory:');
      const r = (s: string) => q(db, s);
      for (const s of [...TABLES_SQLITE, ...inserts()]) await r(s);
      await r(v.addRowLevelSecurity('DELETE FROM orders', USER));
      const after = await r('SELECT user_id FROM orders ORDER BY id');
      await new Promise<void>((res) => db.close(() => res()));
      expect(after).toEqual([{ user_id: 2 }, { user_id: 2 }]); // only user 1 deleted
    });
  });

  // -------------------------------------------------------------------------
  // Guarantee 2: allowedTables
  // -------------------------------------------------------------------------
  describe('Guarantee 2: allowedTables (a query that passes validation reads no table outside the list)', () => {
    const make = (dt?: DatabaseType) =>
      new SecurityValidator(
        { allowedOperations: ['SELECT'], allowedTables: ['orders', 'products'], requireUserContext: false, enableRowLevelSecurity: false, maxRowLimit: 1000, allowUnion: true },
        dt ? { databaseType: dt, schema: schema(dt) } : { schema: schema(undefined) }
      );

    const REJECTED: Array<[string, string]> = [
      ['bare subquery table', 'SELECT id FROM orders WHERE 1 = (SELECT COUNT(*) FROM secrets)'],
      ['backtick table', 'SELECT id FROM orders WHERE 1 = (SELECT COUNT(*) FROM `secrets`)'],
      ['bracket table', 'SELECT id FROM orders WHERE 1 = (SELECT COUNT(*) FROM [secrets])'],
      ['double-quote identifier', 'SELECT id FROM orders WHERE 1 = (SELECT COUNT(*) FROM "secrets")'],
      ['comma join', 'SELECT o.id FROM orders o, secrets s'],
      ['union branch', 'SELECT id FROM orders UNION SELECT token FROM secrets'],
      ['schema-qualified', 'SELECT id FROM orders WHERE 1 = (SELECT COUNT(*) FROM main.secrets)'],
    ];

    it.each(REJECTED)('GUARANTEE HOLDS (sqlite): rejects unauthorized table via %s', async (_n, sql) => {
      const r = await make('sqlite').validate(sql, USER);
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/unauthorized tables/);
    });

    it('regression (AT-1, sqlite): single-quoted table name reads an unauthorized table but passes validation', async () => {
      const v = make('sqlite');
      const sql = "SELECT (SELECT token FROM 'secrets' LIMIT 1) AS t, id FROM orders";
      const r = await v.validate(sql, USER);
      expect(r.valid).toBe(false);
      // The rejection matters: run unvalidated, the query does read the unauthorized table
      const rows = await fullEngine.run(sql);
      expect(rows.some((row) => row.t === 'tok1' || row.t === 'tok2')).toBe(true);
    });

    it('regression (AT-1, generic dialect / 0.0.1-style): single-quoted unauthorized table passes validation', async () => {
      const v = make(undefined); // no databaseType
      const r = await v.validate("SELECT * FROM 'secrets'", USER);
      expect(r.valid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Guarantee 3: restrictedColumns / enforceSensitiveColumns
  // -------------------------------------------------------------------------
  describe('Guarantee 3: restrictedColumns (a query that passes validation returns no restricted/sensitive column value)', () => {
    const make = (dt?: DatabaseType) =>
      new SecurityValidator(
        { allowedOperations: ['SELECT'], restrictedColumns: ['password'], enforceSensitiveColumns: true, requireUserContext: false, enableRowLevelSecurity: false, maxRowLimit: 1000, allowUnion: true },
        dt ? { databaseType: dt, schema: schema(dt) } : { schema: schema(undefined) }
      );

    const REJECTED: Array<[string, string]> = [
      ['explicit column', 'SELECT password FROM accounts'],
      ['aliased column', 'SELECT a.password FROM accounts a'],
      ['bare star', 'SELECT * FROM accounts'],
      ['qualified star', 'SELECT a.* FROM accounts a'],
      ['backtick table star', 'SELECT * FROM `accounts`'],
      ['subquery', 'SELECT (SELECT password FROM accounts LIMIT 1) AS p, id FROM orders'],
      ['union branch', 'SELECT id FROM orders UNION SELECT password FROM accounts'],
    ];

    it.each(REJECTED)('GUARANTEE HOLDS (sqlite): rejects restricted column via %s', async (_n, sql) => {
      const r = await make('sqlite').validate(sql, USER);
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/restricted columns/);
    });

    it('regression (RC-1, sqlite): single-quoted table + star returns the restricted column but passes validation', async () => {
      const v = make('sqlite');
      const sql = "SELECT * FROM 'accounts'";
      const r = await v.validate(sql, USER);
      expect(r.valid).toBe(false);
      const rows = await fullEngine.run(sql);
      expect(rows.some((row) => 'password' in row)).toBe(true); // run unvalidated, it returns the column: the rejection matters
    });

    it('regression (RC-1, generic dialect / 0.0.1-style): single-quoted table + star passes validation', async () => {
      const v = make(undefined);
      const r = await v.validate("SELECT * FROM 'accounts'", USER);
      expect(r.valid).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Full pipeline: the RLS-1 leak survives QueryGenerator.generateQuery end to end
// ---------------------------------------------------------------------------

class FixedProvider extends BaseLLMProvider {
  constructor(private readonly sql: string) {
    super({ provider: 'openai', apiKey: 'unused' });
  }
  async generate(): Promise<string> {
    return this.sql;
  }
  async generateWithSystem(): Promise<string> {
    return this.sql;
  }
  async validateApiKey(): Promise<boolean> {
    return true;
  }
  getDefaultModel(): string {
    return 'fixed';
  }
}

describeSqlite('Full generateQuery pipeline (SQLite)', () => {
  let full: any;
  const q = (sql: string): Promise<Array<Record<string, unknown>>> =>
    new Promise((resolve, reject) => full.all(sql, (e: Error | null, r: any[]) => (e ? reject(e) : resolve(r))));

  beforeAll(async () => {
    full = new sqlite3.Database(':memory:');
    for (const s of [...TABLES_SQLITE, ...inserts()]) await q(s);
  });
  afterAll(async () => {
    await new Promise<void>((r) => full.close(() => r()));
  });

  it('regression (RLS-1): generateQuery returns a query that leaks another user\'s row', async () => {
    const leakSql = "SELECT o.id, (SELECT body FROM 'notes' x WHERE x.user_id = 2 LIMIT 1) AS leak FROM orders o";
    const gen = new QueryGenerator({
      llm: { provider: 'openai', apiKey: 'unused' },
      llmProvider: new FixedProvider(leakSql),
      database: schema('sqlite'),
      security: { allowedOperations: ['SELECT'], enableRowLevelSecurity: true, requireUserContext: false, maxRowLimit: 1000 },
      identifierCheck: 'off',
      maxCorrectionAttempts: 0,
    });
    const res = await gen.generateQuery('show my orders', USER);
    const rows = await q(res.query);
    const leaked = rows.map((r) => r.leak).filter((b) => b !== null);
    expect(leaked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Postgres (PGlite) — real engine for the engine-independent findings.
// One process per file, closed in afterAll.
// ---------------------------------------------------------------------------

describe('Postgres (PGlite) data-access invariants', () => {
  let db: PGliteProcess;
  const norm = (rows: Array<Record<string, unknown>>) =>
    rows.map((r) => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))));
  // full data and a user-1-only copy live in separate schemas of one database
  const run = async (searchPath: string, sql: string) => {
    await db.exec(`SET search_path TO ${searchPath}`);
    try {
      return norm((await db.query(sql)).rows);
    } finally {
      await db.exec('SET search_path TO public');
    }
  };

  beforeAll(async () => {
    db = startPGlite();
    const pgTables = TABLES_SQLITE.map((s) => s.replace(/INTEGER PRIMARY KEY/g, 'INTEGER PRIMARY KEY'));
    await db.exec('CREATE SCHEMA full_s; CREATE SCHEMA own_s;');
    await db.exec(`SET search_path TO full_s; ${[...pgTables, ...inserts()].join('; ')}; SET search_path TO public`);
    await db.exec(`SET search_path TO own_s; ${[...pgTables, ...inserts(1)].join('; ')}; SET search_path TO public`);
  });
  afterAll(async () => {
    await db?.close();
  });

  const v = () => new SecurityValidator(RLS_CONFIG, { databaseType: 'postgres', schema: schema('postgres') });

  const HOLDS: Array<[string, string]> = [
    ['scalar subquery', 'SELECT id, (SELECT SUM(total) FROM orders) s FROM orders'],
    ['lateral join', 'SELECT o.id, g.total FROM orders o JOIN LATERAL (SELECT total FROM orders i WHERE i.id = o.id) g ON true'],
    ['window', 'SELECT id, user_id, SUM(total) OVER (PARTITION BY product_id) w FROM orders'],
    ['values join', 'SELECT v.x, o.id FROM (VALUES (1),(2)) AS v(x) JOIN orders o ON o.id = v.x'],
    ['correlated exists', 'SELECT o.id FROM orders o WHERE EXISTS (SELECT 1 FROM notes n WHERE n.order_id = o.id)'],
    ['quoted identifier subquery', 'SELECT id, (SELECT SUM(total) FROM "orders") s FROM orders'],
    ['union with derived table', 'SELECT id FROM orders UNION SELECT id FROM (SELECT * FROM orders) z'],
    ['intersect', 'SELECT id FROM orders INTERSECT SELECT order_id FROM notes'],
    ['whole-row ref', 'SELECT row_to_json(o) FROM orders o'],
  ];

  it.each(HOLDS)('GUARANTEE HOLDS: row-level security — %s', async (_n, sql) => {
    const filtered = v().addRowLevelSecurity(sql, USER);
    let rowsFull: Array<Record<string, unknown>>;
    try {
      rowsFull = await run('full_s', filtered);
    } catch {
      return; // failed to run is acceptable (no rows leave the database)
    }
    expect(sortRows(rowsFull)).toEqual(sortRows(await run('own_s', sql)));
  });

  it('regression (RLS-2): LEFT JOIN with the user table on the nullable side drops the user\'s own rows', async () => {
    const sql = 'SELECT p.id, o.id AS oid FROM products p LEFT JOIN orders o ON o.product_id = p.id';
    const filtered = v().addRowLevelSecurity(sql, USER);
    expect((await v().validate(filtered, USER)).valid).toBe(true);
    const rowsFull = await run('full_s', filtered);
    const rowsOwn = await run('own_s', sql); // product 3 present with oid=null
    expect(sortRows(rowsFull)).toEqual(sortRows(rowsOwn));
  });
});
