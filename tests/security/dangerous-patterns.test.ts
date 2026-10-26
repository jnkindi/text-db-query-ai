/**
 * Token-based dangerous-pattern detection (design doc 5.2): message format,
 * dialect-specific readings, and the cost of a validation.
 */

import * as lexer from '../../src/sql/lexer';
import { SecurityValidator, SecurityValidatorOptions } from '../../src/security/validator';
import { SecurityConfig } from '../../src/types';

async function errors(sql: string, options: SecurityValidatorOptions = {}, config: SecurityConfig = {}): Promise<string[]> {
  return (await new SecurityValidator({ requireUserContext: false, ...config }, options).validate(sql)).errors;
}

describe('messages keep the 0.0.1 pattern names and order', () => {
  it('stacked statements', async () => {
    expect(await errors('SELECT * FROM users; DROP TABLE users')).toEqual([
      'Query contains dangerous patterns: Multiple statements detected, DROP',
    ]);
    expect(await errors('SELECT 1; GRANT ALL ON t TO x; REVOKE ALL ON t FROM y; ALTER TABLE t ADD c int; CREATE TABLE z (a int); TRUNCATE t')).toEqual([
      'Query contains dangerous patterns: Multiple statements detected, TRUNCATE, ALTER, CREATE, GRANT, REVOKE',
    ]);
    // The critic's case, given straight to validate(): the trailing comment is reported too
    expect(await errors('SELECT id FROM t; DELETE FROM t; -- done')).toEqual([
      'Query contains dangerous patterns: Multiple statements detected, --',
    ]);
  });

  it('EXEC, xp_cmdshell and sp_executesql', async () => {
    expect(await errors("SELECT 1; EXEC xp_cmdshell 'dir'", { databaseType: 'mssql' })).toEqual([
      'Query contains dangerous patterns: Multiple statements detected, EXEC, xp_cmdshell',
    ]);
    expect(await errors("SELECT 1; EXECUTE sp_executesql N'SELECT 1'", { databaseType: 'mssql' })).toEqual([
      'Query contains dangerous patterns: Multiple statements detected, EXECUTE, sp_executesql',
    ]);
  });

  it('comments in a query given straight to validate()', async () => {
    expect(await errors('SELECT 1 LIMIT 1 -- x')).toEqual(['Query contains dangerous patterns: --']);
    expect(await errors('SELECT 1 /* x */ LIMIT 1')).toEqual(['Query contains dangerous patterns: /*']);
    expect(await errors('SELECT 1 LIMIT 1 # x', { databaseType: 'mysql' })).toEqual(['Query contains dangerous patterns: #']);
    expect(await errors('SELECT 1 /*+ MAX_EXECUTION_TIME(1) */ LIMIT 1', { databaseType: 'mysql' })).toEqual([
      'Query contains dangerous patterns: /*',
    ]);
  });

  it('new patterns follow the 0.0.1 ones', async () => {
    expect(await errors('SELECT pg_sleep(1) FROM t UNION SELECT 1 FOR UPDATE')).toEqual([
      'Query contains dangerous patterns: UNION.*SELECT, FOR UPDATE, function PG_SLEEP',
    ]);
  });

  it('malformed input', async () => {
    expect(await errors("SELECT 'x")).toEqual(['Malformed SQL: Unterminated string literal starting at position 7']);
    expect(await errors('SELECT "x', { databaseType: 'postgres' })).toEqual([
      'Malformed SQL: Unterminated quoted identifier starting at position 7',
    ]);
    expect(await errors('SELECT 1 /* x', { databaseType: 'postgres' })).toEqual(['Malformed SQL: Unterminated block comment starting at position 9']);
    expect(await errors('SELECT /*! 1 */', { databaseType: 'mysql' })).toEqual(['Query contains dangerous patterns: executable comment /*!']);
    expect(await errors('SELECT /*M! 1 */')).toEqual(['Query contains dangerous patterns: executable comment /*M!']);
    expect(await errors('SELECT (1 LIMIT 1')).toEqual(['Malformed SQL: Unbalanced parentheses']);
  });
});

describe('names, strings and quoted identifiers never match', () => {
  it.each([
    'SELECT created_at, executed_at, grants, dropoff_time, alternate_email, update_count FROM t LIMIT 1',
    'SELECT "drop", "exec", "union" FROM t LIMIT 1',
    "SELECT 'DROP TABLE x; DELETE FROM y; EXEC xp_cmdshell; UNION SELECT 1 -- /* */' FROM t LIMIT 1",
    'SELECT t.drop, t.exec, t.union, t.into, t.for FROM t LIMIT 1',
    'SELECT revoked_at, truncated, altered, creator, xp_cmdshell_count FROM t LIMIT 1',
  ])('%s', async (sql) => {
    for (const databaseType of ['postgres', 'mysql', 'sqlite', 'mssql', undefined] as const) {
      const quoted = databaseType === 'mysql' ? sql.replace(/"/g, '`') : databaseType === 'mssql' ? sql.replace(/"(\w+)"/g, '[$1]') : sql;
      expect(await errors(quoted, { databaseType })).toEqual([]);
    }
  });
});

describe('MySQL dual lexing', () => {
  const mysql = { databaseType: 'mysql' } as const;
  it('rejects strings that end elsewhere under NO_BACKSLASH_ESCAPES', async () => {
    expect(await errors("SELECT 'a\\'; DROP TABLE x; -- '", mysql)).toEqual([
      'Query contains dangerous patterns: ambiguous string escaping',
    ]);
    expect(await errors("SELECT * FROM t WHERE a = '\\' AND b = ' OR 1=1 -- '", mysql)).toEqual([
      'Query contains dangerous patterns: --, ambiguous string escaping',
    ]);
  });

  it('accepts backslashes that do not change where a string ends', async () => {
    expect(await errors("SELECT 'C:\\\\temp', 'a\\nb', 'x\\%' LIMIT 1", mysql)).toEqual([]);
  });
});

describe('T-SQL statements without semicolons', () => {
  const mssql = { databaseType: 'mssql' } as const;
  it.each([
    'SELECT 1 DELETE FROM users',
    'SELECT * FROM t WHERE a = 1 UPDATE t SET a = 2',
    "SELECT * FROM t EXEC('x')",
    'SELECT * FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY DROP TABLE t',
    'SELECT CASE WHEN 1 = 1 THEN 1 END INSERT INTO t VALUES (1)',
    'SELECT * DECLARE @x int',
    'SELECT 1 COMMIT',
    'SELECT 1 WHILE 1=1 SELECT 1',
  ])('%s', async (sql) => {
    expect((await errors(sql, mssql)).join()).toContain('Multiple statements detected');
    // The 0.0.1 constructor (generic dialect) catches them too
    expect((await errors(sql)).join()).toContain('Multiple statements detected');
  });

  it.each([
    'SELECT TOP 5 u.id FROM users u INNER MERGE JOIN orders o ON o.uid = u.id',
    'SELECT TOP 5 id FROM t OPTION (MERGE JOIN, HASH JOIN)',
    "UPDATE t SET a = 1, b = 'x' WHERE id = 2",
    'UPDATE TOP (5) t SET a = 1',
    'DELETE FROM t WHERE id IN (SELECT id FROM u)',
    'SELECT TOP 5 MIN(ts) begin, MAX(ts) [end] FROM t',
    'SELECT TOP 5 [set], [use], [if] FROM t',
  ])('not a second statement: %s', async (sql) => {
    expect(await errors(sql, mssql, { allowedOperations: ['SELECT', 'UPDATE', 'DELETE'] })).toEqual([]);
  });
});

describe('generic dialect: readings where databases disagree are rejected', () => {
  it('-- without a space is a comment to Postgres, SQLite and SQL Server', async () => {
    expect(await errors('SELECT * FROM t WHERE a = 1--x')).toEqual(['Query contains dangerous patterns: --']);
    expect(await errors('SELECT 1--x', { databaseType: 'mysql' })).toEqual([]); // 1 - (-x) in MySQL
    expect(await errors('SELECT 1--x', { databaseType: 'postgres' })).toEqual(['Query contains dangerous patterns: --']);
  });

  it('dollar quotes are strings to Postgres', async () => {
    expect(await errors('SELECT * FROM t WHERE a <> $x$ ORDER BY $x$')).toEqual([
      'Query contains dangerous patterns: ambiguous dollar quoting',
    ]);
    expect(await errors('SELECT id FROM t WHERE a = $1 LIMIT 1')).toEqual([]);
  });

  it('backslash escapes are a MySQL reading', async () => {
    expect(await errors("SELECT * FROM t WHERE a = '\\' AND b = ' OR 1=1 -- '")).toEqual([
      'Query contains dangerous patterns: ambiguous string escaping',
    ]);
    expect(await errors("SELECT id FROM users WHERE email ~* '@gmail\\.com$' LIMIT 1")).toEqual([]);
  });
});

describe('cost', () => {
  afterEach(() => jest.restoreAllMocks());

  it('validate() lexes once, twice only for a backslash in a MySQL or generic string', async () => {
    const spy = jest.spyOn(lexer, 'tokenize');
    const config: SecurityConfig = {
      requireUserContext: false,
      restrictedColumns: ['password', 'users.ssn'],
      allowedTables: ['users'],
      customValidator: async () => true,
    };
    const schema = { databaseType: 'postgres' as const, tables: [{ name: 'users', columns: [{ name: 'password', type: 'text', sensitive: true }] }] };
    await new SecurityValidator(config, { databaseType: 'postgres', schema }).validate('SELECT * FROM users u WHERE id = 1 LIMIT 5');
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    await new SecurityValidator(config, { databaseType: 'mysql' }).validate("SELECT * FROM users WHERE a = 'x' LIMIT 5");
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    await new SecurityValidator(config, { databaseType: 'mysql' }).validate("SELECT * FROM users WHERE a = 'C:\\\\x' LIMIT 5");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('is linear in the query size', async () => {
    const v = new SecurityValidator(
      { requireUserContext: false, allowUnion: true, restrictedColumns: ['password'] },
      { databaseType: 'postgres', schema: { databaseType: 'postgres', tables: [{ name: 't', columns: [{ name: 'a', type: 'int' }] }] } }
    );
    const build = (n: number) =>
      'SELECT * FROM t WHERE ' + Array.from({ length: n }, (_, i) => `(a = ${i} OR b IN (SELECT c FROM u${i % 7} x${i}))`).join(' AND ');
    // Best of three runs, to keep scheduling noise out of the ratio
    const time = async (sql: string) => {
      let best = Infinity;
      for (let r = 0; r < 3; r++) {
        const t0 = process.hrtime.bigint();
        await v.validate(sql);
        v.addRowLevelSecurity(sql, { userId: 1, role: 'u' });
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
      }
      return best;
    };
    // Kept small: other suites (and a timing benchmark) run in parallel.
    // 8x the size: linear work takes ~8x the time, quadratic work ~64x.
    await time(build(100)); // warm up
    const small = await time(build(200));
    const large = await time(build(1600));
    expect(large).toBeLessThan(Math.max(small * 30, 50));
    expect(large).toBeLessThan(1000);
  });

  it('stays linear on deep nesting and many branches', async () => {
    const schema = { databaseType: 'postgres' as const, tables: [{ name: 't', columns: [{ name: 'user_id', type: 'int' }] }] };
    const v = new SecurityValidator(
      { requireUserContext: false, allowUnion: true, restrictedColumns: ['t.secret'] },
      { databaseType: 'postgres', schema }
    );
    const depth = 3000;
    const nested = '('.repeat(depth) + 'SELECT * FROM t WHERE (a OR b)' + ')'.repeat(depth);
    const selects = 'SELECT ' + 'COALESCE((SELECT * FROM t x WHERE '.repeat(500) + '1' + '), 0) '.repeat(500).trim();
    const branches = Array.from({ length: 2000 }, (_, i) => `SELECT * FROM t t${i} JOIN t u${i} ON u${i}.a = t${i}.a`).join(' UNION ALL ');
    const t0 = process.hrtime.bigint();
    for (const sql of [nested, selects, branches]) {
      await v.validate(sql);
      v.addRowLevelSecurity(sql, { userId: 1, role: 'u' });
    }
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(2000);
    expect(v.addRowLevelSecurity(nested, { userId: 1, role: 'u' })).toBe(
      '('.repeat(depth) + 'SELECT * FROM t WHERE (a OR b) AND user_id = 1' + ')'.repeat(depth)
    );
  });
});
