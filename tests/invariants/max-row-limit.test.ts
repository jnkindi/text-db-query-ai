/**
 * Guarantee 3: QueryGenerator.generateQuery with security.maxRowLimit = n never
 * returns SQL that can yield more than n rows.
 *
 * Method: a fake provider returns adversarial model SQL; the generated query is
 * executed on a table of 12 rows that all tie on the ORDER BY key, and the rows
 * are counted. Postgres runs through one PGlite process (closed in afterAll);
 * SQLite runs in-process.
 *
 * The `WITH TIES` blocks are regression tests: the generator used to lower the
 * row count but keep `WITH TIES`, so the query returned the count plus every
 * tying row.
 */
import { QueryGenerator } from '../../src/generator';
import { QuerySanitizer, SecurityValidator } from '../../src/security';
import type { DatabaseType } from '../../src/types';
import { fakeProvider, loadSqlite3, openSqlite, ordersSchema, SqliteEngine } from './helpers';
import { startPGlite, PGliteProcess } from '../integration/helpers/pglite-process';

const LIMIT = 5;
const ROWS = 12; // all tie on `total`

function makeGenerator(answer: string, databaseType: DatabaseType): QueryGenerator {
  return new QueryGenerator({
    llmProvider: fakeProvider(answer),
    database: ordersSchema(databaseType),
    security: { maxRowLimit: LIMIT, requireUserContext: false, enableRowLevelSecurity: false, allowUnion: true },
    identifierCheck: 'off',
    maxCorrectionAttempts: 0,
  } as any);
}

const SEED_PG = `CREATE TABLE orders (id int, user_id int, total int);
  INSERT INTO orders SELECT g, 1, 100 FROM generate_series(1, ${ROWS}) g;`;

// --- Postgres ---------------------------------------------------------------

describe('guarantee 3: maxRowLimit through the generator (Postgres / PGlite)', () => {
  jest.setTimeout(60000);
  let pg: PGliteProcess;
  beforeAll(async () => {
    pg = startPGlite();
    await pg.exec(SEED_PG);
  });
  afterAll(async () => {
    await pg.close();
  });

  const CAPPED = [
    'SELECT * FROM orders',
    'SELECT * FROM orders LIMIT 100',
    'SELECT * FROM orders ORDER BY total',
    'SELECT * FROM orders UNION ALL SELECT * FROM orders',
    '(SELECT * FROM orders LIMIT 100) UNION ALL (SELECT * FROM orders LIMIT 100)',
    'SELECT * FROM orders LIMIT 100 OFFSET 2',
    'WITH x AS (SELECT * FROM orders) SELECT * FROM x',
    'SELECT * FROM orders ORDER BY total FETCH FIRST 100 ROWS ONLY',
    'SELECT * FROM orders ORDER BY total OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY',
  ];

  it.each(CAPPED)('caps rows at the limit: %p', async (answer) => {
    const { query } = await makeGenerator(answer, 'postgres').generateQuery('q', { userId: 1, role: 'user' });
    const { rows } = await pg.query(query);
    expect({ query, count: rows.length }).toEqual({ query, count: expect.any(Number) });
    expect(rows.length).toBeLessThanOrEqual(LIMIT);
  });

  // ---- regression: FETCH ... WITH TIES must not survive lowering the count ----
  const WITH_TIES = [
    'SELECT * FROM orders ORDER BY total FETCH FIRST 100 ROWS WITH TIES',
    'SELECT * FROM orders ORDER BY total OFFSET 0 ROWS FETCH NEXT 100 ROWS WITH TIES',
  ];
  it.each(WITH_TIES)('[regression] WITH TIES must not exceed the limit: %p', async (answer) => {
    const { query } = await makeGenerator(answer, 'postgres').generateQuery('q', { userId: 1, role: 'user' });
    const { rows } = await pg.query(query);
    // Demonstrates the bug: `query` is the generator's output for maxRowLimit=5.
    expect({ query, count: rows.length }).toMatchObject({ count: expect.any(Number) });
    expect(rows.length).toBeLessThanOrEqual(LIMIT);
  });
});

// --- SQLite -----------------------------------------------------------------

const sqlite3 = loadSqlite3();
const describeSqlite = sqlite3 ? describe : describe.skip;

describeSqlite('guarantee 3: maxRowLimit through the generator (SQLite)', () => {
  let db: SqliteEngine;
  beforeAll(async () => {
    db = openSqlite(sqlite3);
    await db.exec(`CREATE TABLE orders (id INTEGER, user_id INTEGER, total INTEGER);`);
    const vals = Array.from({ length: ROWS }, (_, i) => `(${i + 1}, 1, 100)`).join(', ');
    await db.exec(`INSERT INTO orders VALUES ${vals};`);
  });
  afterAll(async () => {
    await db.close();
  });

  const CAPPED = [
    'SELECT * FROM orders',
    'SELECT * FROM orders LIMIT 100',
    'SELECT * FROM orders ORDER BY total',
    'SELECT * FROM orders UNION ALL SELECT * FROM orders',
    'SELECT * FROM orders LIMIT 100 OFFSET 2',
    'WITH x AS (SELECT * FROM orders) SELECT * FROM x',
    'SELECT * FROM orders LIMIT 100, 100',
  ];
  it.each(CAPPED)('caps rows at the limit: %p', async (answer) => {
    const { query } = await makeGenerator(answer, 'sqlite').generateQuery('q', { userId: 1, role: 'user' });
    const rows = await db.all(query);
    expect({ query, count: rows.length }).toEqual({ query, count: expect.any(Number) });
    expect(rows.length).toBeLessThanOrEqual(LIMIT);
  });
});

// --- SQL Server (reasoned from the produced text; not executed) -------------

describe('guarantee 3: maxRowLimit produced text (SQL Server, reasoned)', () => {
  it('[regression] TOP n WITH TIES is kept, so SQL Server returns n plus ties', async () => {
    const answer = 'SELECT TOP 100 WITH TIES * FROM orders ORDER BY total';
    const { query } = await makeGenerator(answer, 'mssql').generateQuery('q', { userId: 1, role: 'user' });
    // query === 'SELECT TOP 5 WITH TIES * FROM orders ORDER BY total'
    // T-SQL `TOP n WITH TIES` returns n rows plus all rows tying the nth on ORDER BY.
    expect(query.toUpperCase()).not.toContain('WITH TIES');
  });

  it('enforceLimit keeps WITH TIES (root cause, direct)', () => {
    const s = new QuerySanitizer('postgres');
    const out = s.enforceLimit('SELECT * FROM orders ORDER BY total FETCH FIRST 100 ROWS WITH TIES', LIMIT);
    expect(out.toUpperCase()).not.toContain('WITH TIES');
  });

  it('validator refuses FETCH FIRST n WITH TIES, which can return more than maxRowLimit', async () => {
    const v = new SecurityValidator({ requireUserContext: false, maxRowLimit: LIMIT }, { databaseType: 'postgres' });
    const r = await v.validate('SELECT * FROM orders ORDER BY total FETCH FIRST 3 ROWS WITH TIES');
    expect(r.valid).toBe(false);
  });
});
