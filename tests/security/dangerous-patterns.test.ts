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

});

describe('sequences', () => {
  it('rejects NEXT VALUE FOR, which advances a sequence like the blocked NEXTVAL', async () => {
    for (const databaseType of ['mssql', 'postgres', undefined] as const) {
      const r = await new SecurityValidator({ requireUserContext: false }, { databaseType }).validate(
        'SELECT NEXT VALUE FOR order_seq AS id'
      );
      expect(r.errors).toEqual(['Query contains dangerous patterns: NEXT VALUE FOR']);
    }
    const ok = await new SecurityValidator({ requireUserContext: false }, { databaseType: 'mssql' }).validate(
      'SELECT id FROM t ORDER BY id OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY'
    );
    expect(ok.errors).toEqual([]);
  });
});

describe('T-SQL queries stacked without ";"', () => {
  // SQL Server runs each as its own statement; the driver returns the first result.
  const stacked = [
    'SELECT * FROM orders SELECT 1 AS x',
    'SELECT * FROM orders SELECT * FROM orders',
    'SELECT * FROM orders WHERE id = 1 SELECT * FROM orders',
    "SELECT * FROM orders WHERE note = 'x' SELECT 1",
    'SELECT * FROM orders WITH x AS (SELECT 1 AS a) SELECT * FROM x',
    'SELECT * FROM orders WITH RECURSIVE x AS (SELECT 1 AS a) SELECT * FROM x',
    'SELECT * FROM orders WHERE (id = 1) (SELECT 1)',
    'UPDATE orders SET total = 1 WHERE id = 2 SELECT * FROM orders',
    // Words that are keywords elsewhere but legal T-SQL aliases or operands
    'SELECT * FROM orders next SELECT * FROM secrets',
    'SELECT * FROM orders AS limit SELECT * FROM secrets',
    'SELECT * FROM orders key SELECT * FROM secrets',
    'SELECT * FROM orders o (SELECT * FROM secrets)',
    'SELECT * FROM orders WHERE note IS NULL (SELECT * FROM secrets)',
    'SELECT * FROM orders ORDER BY id DESC (SELECT * FROM secrets)',
    'SELECT * FROM orders WHERE id = @v (SELECT * FROM secrets)',
    // Not set operators or reserved words in T-SQL, so aliases there
    'SELECT * FROM orders minus SELECT * FROM secrets',
    'SELECT * FROM orders lateral (SELECT * FROM secrets)',
    'SELECT * FROM orders array (SELECT * FROM secrets)',
    'SELECT * FROM orders returning (SELECT * FROM secrets)',
    'SELECT * FROM orders materialized (SELECT * FROM secrets)',
    'SELECT * FROM orders using (SELECT * FROM secrets)',
    'SELECT * FROM orders ties (SELECT * FROM secrets)',
    'SELECT * FROM orders apply (SELECT * FROM secrets)',
  ];
  const fine = [
    'SELECT a FROM t UNION SELECT a FROM u',
    'SELECT a FROM t UNION ALL SELECT a FROM u EXCEPT SELECT a FROM v',
    'SELECT a FROM t INTERSECT SELECT a FROM u',
    '(SELECT a FROM t) UNION (SELECT a FROM u)',
    'WITH x AS (SELECT 1 AS a), y (b) AS (SELECT 2) SELECT * FROM x, y',
    'INSERT INTO t SELECT a FROM u',
    'INSERT INTO t (a, b) SELECT a, b FROM u',
    'INSERT t SELECT a FROM u',
    'SELECT id FROM orders WITH (NOLOCK) WHERE id IN (SELECT id FROM t)',
    'SELECT id, (SELECT MAX(total) FROM orders) AS m FROM t WHERE EXISTS (SELECT 1 FROM u)',
    'SELECT TOP 5 (SELECT 1) AS a FROM t',
    'SELECT a, (SELECT 1) AS b, CASE WHEN (SELECT 1) = 1 THEN 1 END AS c FROM t',
    'SELECT a FROM t WHERE b BETWEEN (SELECT 1) AND (SELECT 2) AND c IN (SELECT 3)',
    'SELECT a FROM t GROUP BY a HAVING COUNT(*) > (SELECT 1) ORDER BY (SELECT 1)',
    'UPDATE t SET a = (SELECT MAX(b) FROM u) WHERE id IN (SELECT id FROM u)',
    'INSERT INTO t VALUES (1), ((SELECT 2))',
    'SELECT o.id, x.n FROM orders o CROSS APPLY (SELECT COUNT(*) AS n FROM t) x OUTER APPLY (SELECT 1 AS m) y',
  ];

  it.each(['mssql', undefined] as const)('rejects them (%s)', async (databaseType) => {
    const v = new SecurityValidator(
      { requireUserContext: false, allowedOperations: ['SELECT', 'UPDATE', 'INSERT'], allowUnion: true },
      { databaseType }
    );
    for (const sql of stacked) {
      expect({ sql, errors: (await v.validate(sql)).errors }).toEqual({
        sql,
        errors: expect.arrayContaining(['Query contains dangerous patterns: Multiple statements detected']),
      });
    }
    for (const sql of fine) {
      expect({ sql, errors: (await v.validate(sql)).errors }).toEqual({ sql, errors: [] });
    }
  });

  it('reads a query group after TOP n WITH TIES as part of the statement', async () => {
    const v = new SecurityValidator({ requireUserContext: false }, { databaseType: 'mssql' });
    const { errors } = await v.validate('SELECT TOP 5 WITH TIES (SELECT 1) AS a FROM t ORDER BY a');
    expect(errors).not.toContain('Query contains dangerous patterns: Multiple statements detected');
  });

  it('accepts the Postgres forms with databaseType postgres; without a type they could be two T-SQL statements', async () => {
    const config = { requireUserContext: false, allowedOperations: ['SELECT', 'INSERT', 'DELETE'] as const };
    const postgres = new SecurityValidator({ ...config, allowedOperations: [...config.allowedOperations] }, { databaseType: 'postgres' });
    const generic = new SecurityValidator({ ...config, allowedOperations: [...config.allowedOperations] });
    for (const sql of [
      'INSERT INTO t WITH x AS (SELECT 1 AS a) SELECT a FROM x',
      'SELECT ARRAY(SELECT 1) AS a FROM t',
      'DELETE FROM t USING (SELECT 1 AS id) x WHERE t.id = x.id',
      'SELECT a FROM t CROSS JOIN LATERAL (SELECT 1 AS b) l',
    ]) {
      expect({ sql, errors: (await postgres.validate(sql)).errors }).toEqual({ sql, errors: [] });
    }
    for (const sql of ['INSERT INTO t WITH x AS (SELECT 1 AS a) SELECT a FROM x', 'SELECT a FROM t WHERE b = ANY (SELECT b FROM u)']) {
      expect({ sql, errors: (await generic.validate(sql)).errors }).toEqual({ sql, errors: [] });
    }
    expect((await generic.validate('SELECT ARRAY(SELECT 1) AS a FROM t')).valid).toBe(false);
  });

  it('keeps the row-level filter in the first statement', () => {
    const v = new SecurityValidator({ enableRowLevelSecurity: true }, { databaseType: 'mssql' });
    expect(v.addRowLevelSecurity('SELECT * FROM orders SELECT 1 AS x', { userId: 5, role: 'u' })).toBe(
      'SELECT * FROM orders WHERE user_id = 5 SELECT 1 AS x'
    );
  });
});

describe('T-SQL statements that need no ";" (continued)', () => {
  it.each(['mssql', undefined] as const)('rejects a second statement of any kind (%s)', async (databaseType) => {
    const v = new SecurityValidator({ requireUserContext: false }, { databaseType });
    for (const sql of [
      "SELECT id FROM orders PRINT 'x'",
      "SELECT id FROM orders THROW 50000, 'x', 1",
      "SELECT id FROM orders RAISERROR('x', 16, 1)",
      'SELECT id FROM orders RETURN',
      'SELECT id FROM orders OPEN c',
      'SELECT id FROM orders CLOSE c',
      'SELECT id FROM orders DEALLOCATE c',
    ]) {
      expect({ sql, errors: (await v.validate(sql)).errors }).toEqual({
        sql,
        errors: expect.arrayContaining(['Query contains dangerous patterns: Multiple statements detected']),
      });
    }
  });

  it.each(['mssql', undefined] as const)('still accepts columns named like them (%s)', async (databaseType) => {
    const v = new SecurityValidator({ requireUserContext: false }, { databaseType });
    for (const sql of [
      'SELECT open, close, high, low FROM prices',
      'SELECT p.open, p.close FROM prices p WHERE close > open ORDER BY close',
      'SELECT AVG(close) AS c, MAX(open) FROM prices GROUP BY close',
    ]) {
      expect({ sql, errors: (await v.validate(sql)).errors }).toEqual({ sql, errors: [] });
    }
  });
});
