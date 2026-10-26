/**
 * Row-level security must filter every read of a table that holds user rows,
 * not just the main table: subqueries, CTE bodies, derived tables, extra joins,
 * self-joins and the source of INSERT ... SELECT included.
 *
 * Checked by meaning on SQLite (Postgres: tests/integration/pglite.test.ts):
 * addRowLevelSecurity(q) run on the full database must return the same rows
 * as q itself run on a copy that holds only user 1's rows.
 */
import { SecurityValidator } from '../../src/security';
import {
  COVERAGE_CONFIG as CONFIG,
  COVERAGE_KEEPS_MEANING,
  COVERAGE_LEAKS,
  COVERAGE_USER as USER,
  coverageSchema,
  coverageSetup,
  Executor,
  expectSameRows,
} from '../fixtures/rls-isolation';

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
const SCHEMA = coverageSchema('sqlite');

describeSqlite('row-level security covers every read (SQLite)', () => {
  let full: any;
  let own: any;
  const run = (db: any, sql: string): Promise<any[]> =>
    new Promise((resolve, reject) => db.all(sql, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows))));
  const fullDb: Executor = { run: (sql) => run(full, sql) };
  const ownDb: Executor = { run: (sql) => run(own, sql) };

  beforeAll(async () => {
    full = new sqlite3.Database(':memory:');
    own = new sqlite3.Database(':memory:');
    for (const s of coverageSetup()) await run(full, s);
    for (const s of coverageSetup(1)) await run(own, s);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => full.close(() => resolve()));
    await new Promise<void>((resolve) => own.close(() => resolve()));
  });

  describe('with a schema', () => {
    const validator = new SecurityValidator(CONFIG, { databaseType: 'sqlite', schema: SCHEMA });

    it.each([...COVERAGE_LEAKS, ...COVERAGE_KEEPS_MEANING])('%s', async (_name, sql) => {
      await expectSameRows(validator, fullDb, ownDb, sql, true);
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
      const pg = new SecurityValidator(CONFIG, { databaseType: 'postgres', schema: coverageSchema('postgres') });
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

    it.each(COVERAGE_LEAKS)('%s', async (_name, sql) => {
      await expectSameRows(validator, fullDb, ownDb, sql, false);
    });

    it('keeps the unqualified 0.0.1 filter for a join, which a second user table makes ambiguous', async () => {
      const sql = 'SELECT o.id, p.name FROM orders o JOIN products p ON p.id = o.product_id';
      expect(validator.addRowLevelSecurity(sql, USER)).toBe(`${sql} WHERE user_id = 1`);
      await expect(run(full, validator.addRowLevelSecurity('SELECT o.id FROM orders o JOIN notes n ON 1 = 1', USER))).rejects.toThrow(
        /ambiguous/,
      );
    });

    it('does not count a filter on a table whose columns are renamed as covering the join (Postgres syntax)', () => {
      const pg = new SecurityValidator(CONFIG, { databaseType: 'postgres' });
      const out = pg.addRowLevelSecurity('SELECT * FROM orders AS o(a, b, c, d) JOIN notes n ON true WHERE o.user_id = 1', USER);
      // n gets the unqualified filter (o renames user_id away), and o is wrapped
      expect(out).toBe(
        'SELECT * FROM (SELECT * FROM orders AS __rls WHERE __rls.user_id = 1) AS o(a, b, c, d) JOIN notes n ON true WHERE o.user_id = 1 AND user_id = 1',
      );
    });

    it('does not count a filter on one table of a join as covering the others', () => {
      const out = validator.addRowLevelSecurity('SELECT n.body FROM orders o, notes n WHERE o.user_id = 1', USER);
      expect(out).toBe('SELECT n.body FROM orders o, notes n WHERE o.user_id = 1 AND user_id = 1');
    });
  });
});
