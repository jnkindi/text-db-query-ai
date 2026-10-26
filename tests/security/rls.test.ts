/**
 * Row-level security (design doc 5.4): the text addRowLevelSecurity produces,
 * the values it refuses, and the rows the rewritten SQL returns on SQLite
 * (Postgres: tests/integration/pglite.test.ts).
 */

import { SecurityValidator } from '../../src/security/validator';
import { TextToQueryError, UserContext } from '../../src/types';
import { rlsCases, invalidUserIds, RlsCase, InvalidUserIdCase } from '../fixtures/security-rls';
import { ISOLATION_SETUP, expectIsolation } from '../fixtures/rls-isolation';

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
    for (const s of ISOLATION_SETUP) await all(s);
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

// The same isolation checks run on Postgres in tests/integration/pglite.test.ts, which owns the PGlite process.
