/**
 * Guarantee 1, SQL Server batches without ';' (reasoned, not executed: no local
 * SQL Server, and these forms are syntax errors on sqlite/Postgres).
 *
 * The validator detects a second T-SQL statement that starts with a data or DDL
 * keyword (DROP/DELETE/UPDATE/INSERT/TRUNCATE/GRANT/EXEC/...), so the dangerous
 * batches are rejected. Statement keywords without side effects (PRINT, THROW,
 * RAISERROR, RETURN, cursor statements) used to be missing from its stacking
 * list, so `SELECT 1 <stmt>` passed as one statement although SQL Server runs
 * it as a two-statement batch.
 *
 * The regression block checks that those two-statement batches are rejected.
 */
import { SecurityValidator } from '../../src/security';
import type { DatabaseType } from '../../src/types';

const USER = { userId: 1, role: 'user' };
const CFG = { allowedOperations: ['SELECT' as const], requireUserContext: false, allowUnion: true };

describe('guarantee 1: SQL Server stacking that IS detected', () => {
  const rejected = [
    'SELECT 1 DROP TABLE t',
    'SELECT 1 DELETE FROM t',
    'SELECT 1 UPDATE t SET x = 1',
    'SELECT 1 INSERT INTO t VALUES (1)',
    'SELECT 1 TRUNCATE TABLE t',
    'SELECT 1 GRANT SELECT ON t TO u',
    "SELECT 1 WAITFOR DELAY '0:0:5'",
    'SELECT 1 SHUTDOWN',
    'SELECT * FROM orders SELECT * FROM secrets',
    'SELECT 1 WITH x AS (SELECT 1) SELECT * FROM x',
  ];
  it.each(rejected)('rejects %p (mssql and generic)', async (sql) => {
    for (const d of ['mssql', undefined] as Array<DatabaseType | undefined>) {
      const v = new SecurityValidator(CFG, { databaseType: d });
      expect((await v.validate(sql, USER)).valid).toBe(false);
    }
  });
});

describe('guarantee 1: SQL Server stacking that is NOT detected', () => {
  // Each is two T-SQL statements: a SELECT (whose rows the driver returns) and a
  // second statement the server also runs. They are benign control/diagnostic
  // statements, so the impact is lower than a reachable write, but the
  // single-statement guarantee does not hold for them.
  const twoStatementBatches = [
    "SELECT 1 PRINT 'x'",
    "SELECT 1 THROW 50000, 'boom', 1",
    "SELECT 1 RAISERROR('boom', 16, 1)",
    'SELECT 1 RETURN',
    'SELECT 1 OPEN c',
    'SELECT 1 CLOSE c',
    'SELECT 1 DEALLOCATE c',
  ];
  it.each(twoStatementBatches)('[regression] should reject the two-statement batch %p', async (sql) => {
    const v = new SecurityValidator(CFG, { databaseType: 'mssql' });
    const r = await v.validate(sql, USER);
    expect(r.valid).toBe(false);
  });
});

describe('guarantee: valid read queries wrongly rejected (false positives, low severity)', () => {
  // TABLE and VALUES are complete row-returning statements in Postgres, but the
  // syntax gate only accepts SELECT/INSERT/UPDATE/DELETE/WITH, so they are
  // rejected as "Could not determine query operation".
  const validReads = ['TABLE orders', 'VALUES (1), (2), (3)'];
  // Rejected as in 0.0.1: QueryOperation has no member for a bare TABLE or VALUES statement.
  it.each(validReads)('rejects the bare read %p, as 0.0.1 did', async (sql) => {
    const v = new SecurityValidator({ requireUserContext: false }, { databaseType: 'postgres' });
    const r = await v.validate(sql, USER);
    expect(r.errors).toEqual(['Could not determine query operation']);
  });
});
