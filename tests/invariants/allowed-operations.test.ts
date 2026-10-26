/**
 * Guarantee 2: a validated query performs no write, DDL, transaction control,
 * locking read, sequence advance or blocked-function call unless allowed,
 * including nested forms (writable CTEs, subqueries, functions that run SQL
 * from strings). Default allowedOperations is ['SELECT'].
 *
 * Each row is validated across every dialect where the syntax is meaningful
 * and must be rejected. A short allow-list section checks that the gate opens
 * when the operation or function is explicitly allowed.
 */
import { SecurityValidator } from '../../src/security';
import type { DatabaseType } from '../../src/types';

const USER = { userId: 1, role: 'user' };
const SELECT_ONLY = { allowedOperations: ['SELECT' as const], requireUserContext: false, allowUnion: true };
const ALL_DIALECTS: Array<DatabaseType | undefined> = ['postgres', 'mysql', 'sqlite', 'mssql', undefined];

async function rejectedEverywhere(sql: string, dialects = ALL_DIALECTS): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const d of dialects) {
    const v = new SecurityValidator(SELECT_ONLY, { databaseType: d });
    const r = await v.validate(sql, USER);
    result[String(d)] = r.valid ? 'ACCEPTED' : 'rejected';
  }
  return result;
}

function expectAllRejected(result: Record<string, string>): void {
  for (const [, v] of Object.entries(result)) expect(v).toBe('rejected');
}

describe('guarantee 2: writes and DDL as the main statement', () => {
  const forms = [
    'INSERT INTO orders VALUES (1)',
    'UPDATE orders SET total = 0',
    'DELETE FROM orders',
    'DROP TABLE orders',
    'TRUNCATE TABLE orders',
    'ALTER TABLE orders ADD COLUMN x int',
    'CREATE TABLE t (id int)',
    'GRANT SELECT ON orders TO u',
    'REVOKE SELECT ON orders FROM u',
    'MERGE INTO orders USING src ON (1=1) WHEN MATCHED THEN DELETE',
  ];
  it.each(forms)('rejects %p', async (sql) => expectAllRejected(await rejectedEverywhere(sql)));
});

describe('guarantee 2: data modification nested in a read', () => {
  const forms = [
    'WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x',
    'WITH x AS (UPDATE orders SET total = 0 RETURNING *) SELECT * FROM x',
    'WITH x AS (INSERT INTO orders VALUES (1) RETURNING *) SELECT * FROM x',
    'SELECT * FROM (DELETE FROM orders RETURNING *) d',
    'SELECT * FROM orders WHERE id IN (DELETE FROM orders RETURNING id)',
    'WITH a AS (SELECT 1), b AS (DELETE FROM orders RETURNING *) SELECT * FROM a',
  ];
  it.each(forms)('rejects %p (postgres)', async (sql) => {
    const v = new SecurityValidator(SELECT_ONLY, { databaseType: 'postgres' });
    expect((await v.validate(sql, USER)).valid).toBe(false);
  });
});

describe('guarantee 2: upserts need UPDATE/DELETE', () => {
  const forms: Array<[string, DatabaseType]> = [
    ['INSERT INTO orders VALUES (1) ON CONFLICT (id) DO UPDATE SET total = 0', 'postgres'],
    ['INSERT INTO orders VALUES (1) ON DUPLICATE KEY UPDATE total = 0', 'mysql'],
    ['INSERT OR REPLACE INTO orders VALUES (1)', 'sqlite'],
  ];
  it.each(forms)('rejects %p', async (sql, d) => {
    const v = new SecurityValidator(SELECT_ONLY, { databaseType: d });
    expect((await v.validate(sql, USER)).valid).toBe(false);
  });
});

describe('guarantee 2: transaction control, locking reads and SELECT INTO', () => {
  const forms: Array<[string, DatabaseType | undefined]> = [
    ['BEGIN', 'postgres'],
    ['COMMIT', 'postgres'],
    ['ROLLBACK', 'postgres'],
    ['START TRANSACTION', 'mysql'],
    ['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'mssql'],
    ['LOCK TABLE orders', 'postgres'],
    ['LOCK TABLES orders READ', 'mysql'],
    ['SELECT * FROM orders FOR UPDATE', 'postgres'],
    ['SELECT * FROM orders FOR NO KEY UPDATE', 'postgres'],
    ['SELECT * FROM orders FOR SHARE', 'postgres'],
    ['SELECT * FROM orders FOR KEY SHARE', 'postgres'],
    ['SELECT * FROM orders LOCK IN SHARE MODE', 'mysql'],
    ['SELECT * INTO backup FROM orders', 'postgres'],
    ['SELECT * FROM orders INTO OUTFILE \'/tmp/x\'', 'mysql'],
    ['SELECT * FROM orders INTO DUMPFILE \'/tmp/x\'', 'mysql'],
  ];
  it.each(forms)('rejects %p', async (sql, d) => {
    const v = new SecurityValidator(SELECT_ONLY, { databaseType: d });
    expect((await v.validate(sql, USER)).valid).toBe(false);
  });
});

describe('guarantee 2: sequence advance', () => {
  const forms: Array<[string, DatabaseType | undefined]> = [
    ["SELECT nextval('s')", 'postgres'],
    ["SELECT setval('s', 1)", 'postgres'],
    ['SELECT NEXT VALUE FOR s', 'mssql'],
    ['SELECT NEXT VALUE FOR s', undefined],
  ];
  it.each(forms)('rejects %p', async (sql, d) => {
    const v = new SecurityValidator(SELECT_ONLY, { databaseType: d });
    expect((await v.validate(sql, USER)).valid).toBe(false);
  });
});

describe('guarantee 2: blocked functions, incl. nested and quoted/qualified', () => {
  const forms: Array<[string, DatabaseType | undefined]> = [
    ['SELECT pg_sleep(10)', 'postgres'],
    ['SELECT "pg_sleep"(10)', 'postgres'],
    ['SELECT pg_catalog.pg_sleep(10)', 'postgres'],
    ['SELECT (SELECT pg_sleep(10))', 'postgres'],
    ['SELECT CASE WHEN true THEN pg_sleep(10) ELSE 0 END', 'postgres'],
    ['WITH x AS (SELECT pg_sleep(10) a) SELECT * FROM x', 'postgres'],
    ['SELECT 1 FROM orders GROUP BY id HAVING pg_sleep(10) IS NULL', 'postgres'],
    ['SELECT * FROM pg_sleep(10)', 'postgres'],
    ["SELECT pg_read_file('/etc/passwd')", 'postgres'],
    ["SELECT dblink('x', 'y')", 'postgres'],
    ["SELECT set_config('x', 'y', false)", 'postgres'],
    ["SELECT load_extension('x')", 'sqlite'],
    ["SELECT readfile('/etc/passwd')", 'sqlite'],
    ['SELECT sleep(10)', 'mysql'],
    ["SELECT load_file('/etc/passwd')", 'mysql'],
    ["SELECT benchmark(100000000, md5('x'))", 'mysql'],
    ["SELECT get_lock('x', 10)", 'mysql'],
    ["EXEC xp_cmdshell 'dir'", 'mssql'],
    ["SELECT * FROM OPENROWSET('x', 'y', 'z')", 'mssql'],
  ];
  it.each(forms)('rejects %p', async (sql, d) => {
    const v = new SecurityValidator(SELECT_ONLY, { databaseType: d });
    expect((await v.validate(sql, USER)).valid).toBe(false);
  });
});

describe('guarantee 2: credential tables', () => {
  const forms: Array<[string, DatabaseType | undefined]> = [
    ['SELECT * FROM pg_shadow', 'postgres'],
    ['SELECT * FROM pg_authid', 'postgres'],
    ['SELECT * FROM pg_catalog.pg_authid', 'postgres'],
    ['SELECT * FROM mysql.user', 'mysql'],
    ['SELECT * FROM sys.sql_logins', 'mssql'],
  ];
  it.each(forms)('rejects %p', async (sql, d) => {
    const v = new SecurityValidator({ ...SELECT_ONLY }, { databaseType: d });
    expect((await v.validate(sql, USER)).valid).toBe(false);
  });
});

describe('guarantee 2: the gate opens when explicitly allowed', () => {
  it('allowedOperations lets an INSERT through', async () => {
    const v = new SecurityValidator(
      { allowedOperations: ['SELECT', 'INSERT'], requireUserContext: false },
      { databaseType: 'postgres' }
    );
    expect((await v.validate('INSERT INTO orders VALUES (1)', USER)).valid).toBe(true);
  });
  it('allowedFunctions un-blocks a default-blocked function', async () => {
    const v = new SecurityValidator(
      { requireUserContext: false, allowedFunctions: ['pg_sleep'] },
      { databaseType: 'postgres' }
    );
    expect((await v.validate('SELECT pg_sleep(1)', USER)).valid).toBe(true);
  });
  it('a plain read is accepted', async () => {
    const v = new SecurityValidator(SELECT_ONLY, { databaseType: 'postgres' });
    expect((await v.validate('SELECT id, total FROM orders WHERE user_id = 1', USER)).valid).toBe(true);
  });
});
