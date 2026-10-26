/**
 * A validator built without a database type (every 0.0.1 caller) must reject
 * text that some database reads differently from the validator: each query
 * here hides a table or a statement from one reading (tests/sql/readings.test.ts).
 */
import { SecurityValidator } from '../../src/security';

const HIDDEN = [
  ['-- before a quote, a comment except in MySQL', "SELECT a FROM t --'\n; DROP TABLE users; --'"],
  ['# before a subquery, a MySQL comment but a Postgres operator', 'SELECT a FROM t WHERE 1 = 1 # (SELECT count(*) FROM secrets)'],
  ['T-SQL bracket identifiers holding quotes', "SELECT [a'] , (SELECT password FROM users) , ['] FROM t"],
  ['Postgres dollar quotes holding quotes', "SELECT $$'$$ , (SELECT password FROM users) , $$'$$ FROM t"],
  ['MySQL backslash escapes', "SELECT '\\' , 1 , ' , (SELECT password FROM users) , 'x' FROM t"],
  ['nested block comments', "SELECT a FROM t /* /* */ ' */ ; DROP TABLE t; -- '"],
] as const;

describe('generic dialect rejects text that databases read differently', () => {
  const validator = new SecurityValidator({ allowedTables: ['t'], requireUserContext: false });

  it.each(HIDDEN)('%s', async (_name, sql) => {
    const result = await validator.validate(sql);
    expect(result.valid).toBe(false);
  });

  it('still accepts an ordinary query', async () => {
    const result = await validator.validate("SELECT a, b FROM t WHERE created_at > '2024-01-01' LIMIT 10");
    expect(result.errors).toEqual([]);
  });
});
