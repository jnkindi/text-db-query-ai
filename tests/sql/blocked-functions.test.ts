/**
 * Regression: functions that execute SQL (or read a table) given as a string
 * argument are blocked by default. Through them a query could read any table
 * or column without the validator seeing a table reference.
 */

import { isBlockedFunction, DEFAULT_BLOCKED_FUNCTIONS } from '../../src/sql/keywords';
import { analyzeSql } from '../../src/sql/analyze';

describe('functions that run SQL from a string', () => {
  it.each([
    'ts_stat',             // Postgres: ts_stat('SELECT to_tsvector(password) FROM users')
    'ts_rewrite',          // Postgres: ts_rewrite(q, 'SELECT ...') runs the SELECT
    'crosstab',            // tablefunc: crosstab('SELECT ...')
    'crosstab2',
    'connectby',           // tablefunc: reads the table named in its first argument
    'xpath_table',         // xml2: builds and runs a query from its arguments
    'eval',                // SQLite eval extension: eval('DELETE FROM t')
    'pg_catalog.ts_stat',
  ])('%s is blocked by default', (name) => {
    expect(isBlockedFunction(name)).toBe(true);
  });

  it('is reported by the analyzer as a call', () => {
    const a = analyzeSql("SELECT * FROM ts_stat('SELECT to_tsvector(password) FROM users')", 'postgres');
    expect(a.functions).toEqual(['TS_STAT']);
    expect(a.tables).toEqual([]);
  });

  it('can still be allowed explicitly', () => {
    expect(isBlockedFunction('ts_stat', undefined, ['ts_stat'])).toBe(false);
  });

  it('does not block similar ordinary names', () => {
    for (const f of ['ts_headline', 'to_tsvector', 'evaluate', 'evaluation_score', 'ts_rank']) {
      expect(isBlockedFunction(f)).toBe(false);
    }
    expect(DEFAULT_BLOCKED_FUNCTIONS).toContain('TS_STAT');
  });
});
