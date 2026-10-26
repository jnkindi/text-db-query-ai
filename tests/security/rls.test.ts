/**
 * Row-level security (design doc 5.4): the text addRowLevelSecurity produces,
 * the values it refuses, and the rows the rewritten SQL returns on real
 * SQLite and Postgres databases.
 */

import { SecurityValidator } from '../../src/security/validator';
import { DatabaseType, TextToQueryError, UserContext } from '../../src/types';
import { rlsCases, invalidUserIds, RlsCase, InvalidUserIdCase } from '../fixtures/security-rls';
import { startPGlite, PGliteProcess } from '../integration/helpers/pglite-process';

jest.setTimeout(60000);

function validatorFor(c: Pick<RlsCase, 'config' | 'databaseType' | 'schema'>): SecurityValidator {
  const databaseType = c.databaseType === 'generic' ? undefined : (c.databaseType ?? 'postgres');
  return new SecurityValidator({ enableRowLevelSecurity: true, ...c.config }, { databaseType, schema: c.schema });
}

const user = (userId: unknown): UserContext => ({ userId: userId as string | number, role: 'user' });

describe('addRowLevelSecurity output', () => {
  it.each(rlsCases.map((c): [string, RlsCase] => [c.name, c]))('%s', (_name, c) => {
    const out = validatorFor(c).addRowLevelSecurity(c.query, user(c.userId ?? 123));
    expect(out).toBe(c.expected);
  });

  it('returns the query unchanged without a user context', () => {
    const v = validatorFor({});
    expect(v.addRowLevelSecurity('SELECT * FROM orders', undefined as unknown as UserContext)).toBe('SELECT * FROM orders');
  });

  it('is on by default in the validator (0.0.1 default)', () => {
    expect(new SecurityValidator().addRowLevelSecurity('SELECT * FROM t', user(1))).toBe('SELECT * FROM t WHERE user_id = 1');
  });

  it('produces queries the validator accepts', async () => {
    const v = new SecurityValidator(
      { requireUserContext: false, allowUnion: true, allowedOperations: ['SELECT', 'UPDATE', 'DELETE'] },
      { databaseType: 'postgres' }
    );
    for (const q of [
      "SELECT * FROM orders WHERE status = 'paid' OR status = 'refunded' LIMIT 10",
      'SELECT status, COUNT(*) FROM orders GROUP BY status ORDER BY 2 LIMIT 5',
      'SELECT id FROM a UNION SELECT id FROM b LIMIT 5',
      'UPDATE orders SET status = 1 WHERE id = 1 OR id = 2',
    ]) {
      const result = await v.validate(v.addRowLevelSecurity(q, user(7)));
      expect(result.errors).toEqual([]);
    }
  });
});

describe('addRowLevelSecurity refuses unsafe values', () => {
  it.each(invalidUserIds.map((c): [string, InvalidUserIdCase] => [c.name, c]))('%s', (_name, c) => {
    const v = validatorFor({ databaseType: c.databaseType ?? 'postgres' });
    let thrown: unknown;
    try {
      v.addRowLevelSecurity('SELECT * FROM orders', user(c.userId));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TextToQueryError);
    expect((thrown as TextToQueryError).code).toBe('SECURITY_VALIDATION_FAILED');
  });

  it.each(['tenant_id; DROP TABLE x', 'a b', '', "'x'", 'x.y'])('invalid rowLevelSecurityColumn %j', (column) => {
    const v = validatorFor({ config: { rowLevelSecurityColumn: column } });
    expect(() => v.addRowLevelSecurity('SELECT * FROM orders', user(1))).toThrow(TextToQueryError);
  });

  it('does not check the value of queries it does not filter', () => {
    const v = validatorFor({});
    expect(v.addRowLevelSecurity('INSERT INTO t VALUES (1)', user(NaN))).toBe('INSERT INTO t VALUES (1)');
  });
});

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

interface Executor {
  run(sql: string): Promise<Array<Record<string, unknown>>>;
}

async function expectIsolation(db: Executor, databaseType: DatabaseType): Promise<void> {
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

const SETUP = [
  'CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, status TEXT, total REAL, note TEXT)',
  "INSERT INTO orders VALUES (1, 1, 'paid', 10, NULL), (2, 2, 'paid', 20, NULL), (3, 2, 'refunded', 5, 'user_id = 1'), (4, 1, 'new', 0, 'user_id = 1')",
  'CREATE TABLE docs (id INTEGER PRIMARY KEY, owner TEXT NOT NULL)',
  "INSERT INTO docs VALUES (1, 'O''Brien'), (2, 'x'), (3, 'someone')",
];

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

describeSqlite('row isolation on SQLite (sqlite3, in memory)', () => {
  let db: any;
  const all = (sql: string): Promise<Array<Record<string, unknown>>> =>
    new Promise((resolve, reject) => db.all(sql, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows))));

  beforeAll(async () => {
    db = new sqlite3.Database(':memory:');
    for (const s of SETUP) await all(s);
  });
  afterAll(() => new Promise<void>((resolve) => db.close(() => resolve())));

  it('every filtered query returns only user 1', async () => {
    await expectIsolation({ run: all }, 'sqlite');
  });

  it('0.0.1 leaked other users through the OR (regression)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const legacy = require('text-db-query-ai-legacy');
    const old = new legacy.SecurityValidator({ enableRowLevelSecurity: true });
    const leaked = await all(old.addRowLevelSecurity("SELECT * FROM orders WHERE status = 'paid' OR status = 'refunded'", user(1)));
    expect(new Set(leaked.map((r) => r.user_id))).toContain(2);
  });
});

/*
 * Opt-in (PGLITE_RLS=1): a second PGlite process next to the one in
 * tests/integration/pglite.test.ts slows the parallel full run enough to push
 * the wall-clock benchmark in tests/sql/performance.test.ts over its budget.
 */
const describePostgres = process.env.PGLITE_RLS === '1' ? describe : describe.skip;

describePostgres('row isolation on Postgres (PGlite; set PGLITE_RLS=1)', () => {
  let pg: PGliteProcess;
  beforeAll(async () => {
    pg = startPGlite();
    for (const s of SETUP) await pg.exec(s);
  });
  afterAll(async () => {
    await pg.close();
  });

  it('every filtered query returns only user 1', async () => {
    await expectIsolation({ run: async (sql) => (await pg.query(sql)).rows }, 'postgres');
  });
});
