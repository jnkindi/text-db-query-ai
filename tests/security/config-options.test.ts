/**
 * Every SecurityConfig option, and the SecurityValidatorOptions, is enforced.
 * One describe per option.
 */

import { SecurityValidator, SecurityValidatorOptions } from '../../src/security/validator';
import { DatabaseSchema, SecurityConfig, TextToQueryError, UserContext } from '../../src/types';

const ctx: UserContext = { userId: 7, role: 'user' };

async function check(sql: string, config: SecurityConfig = {}, options: SecurityValidatorOptions = {}) {
  return new SecurityValidator({ requireUserContext: false, ...config }, options).validate(sql);
}

const schema: DatabaseSchema = {
  databaseType: 'postgres',
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'email', type: 'varchar' },
        { name: 'password', type: 'varchar', sensitive: true },
        { name: 'ssn', type: 'varchar', sensitive: true },
      ],
    },
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'user_id', type: 'integer' },
        { name: 'total', type: 'decimal' },
      ],
    },
    { name: 'admins', columns: [{ name: 'id', type: 'integer' }, { name: 'password', type: 'varchar' }] },
  ],
};

describe('allowedOperations', () => {
  it('defaults to SELECT only', async () => {
    expect((await check('SELECT id FROM t LIMIT 1')).valid).toBe(true);
    for (const sql of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t']) {
      const r = await check(sql);
      expect(r.valid).toBe(false);
      expect(r.errors[0]).toMatch(/^Operation (INSERT|UPDATE|DELETE) is not allowed\. Allowed operations: SELECT$/);
    }
  });

  it('allows the listed operations, including after WITH and leading parentheses', async () => {
    const cfg: SecurityConfig = { allowedOperations: ['SELECT', 'DELETE'] };
    expect((await check('WITH x AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM x)', cfg)).valid).toBe(true);
    expect((await check('(SELECT id FROM t) LIMIT 1', cfg)).valid).toBe(true);
    expect((await check('WITH x AS (SELECT 1) UPDATE t SET a = 1', cfg)).errors[0]).toContain('Operation UPDATE is not allowed');
  });

  it('applies to data-modifying statements nested in a query', async () => {
    const sql = 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d LIMIT 5';
    expect((await check(sql)).errors).toEqual(['Query contains dangerous patterns: statement DELETE']);
    expect((await check(sql, { allowedOperations: ['SELECT', 'DELETE'] })).valid).toBe(true);
  });

  it('applies to upserts, which update existing rows', async () => {
    const pg = 'INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 2';
    const my = 'INSERT INTO t (id) VALUES (1) ON DUPLICATE KEY UPDATE n = 2';
    expect((await check(pg, { allowedOperations: ['INSERT'] })).errors).toEqual(['Query contains dangerous patterns: statement UPDATE']);
    expect((await check(my, { allowedOperations: ['INSERT'] }, { databaseType: 'mysql' })).errors).toEqual([
      'Query contains dangerous patterns: statement UPDATE',
    ]);
    expect((await check(pg, { allowedOperations: ['INSERT', 'UPDATE'] })).valid).toBe(true);
    const sqlite = 'INSERT OR REPLACE INTO t (id) VALUES (1)';
    expect((await check(sqlite, { allowedOperations: ['INSERT'] }, { databaseType: 'sqlite' })).errors).toEqual([
      'Query contains dangerous patterns: statement REPLACE',
    ]);
    expect((await check('INSERT OR IGNORE INTO t (id) VALUES (1)', { allowedOperations: ['INSERT'] }, { databaseType: 'sqlite' })).valid).toBe(true);
  });

  it('rejects statements that are not queries', async () => {
    for (const sql of ['DROP TABLE users', 'MERGE INTO t USING s ON 1=1', 'CALL p()', 'VALUES (1)', 'SHOW TABLES', 'EXPLAIN SELECT 1']) {
      expect((await check(sql)).errors).toEqual(['Could not determine query operation']);
    }
  });
});

describe('allowedTables', () => {
  const cfg: SecurityConfig = { allowedTables: ['users', 'orders', 'billing.invoices'] };

  it('accepts listed tables, case-insensitively, quoted or qualified', async () => {
    for (const sql of [
      'SELECT * FROM users LIMIT 1',
      'SELECT * FROM "Users" LIMIT 1',
      'SELECT * FROM billing.invoices LIMIT 1',
      'SELECT * FROM users u JOIN orders o ON o.user_id = u.id LIMIT 1',
      'WITH secrets AS (SELECT id FROM users) SELECT * FROM secrets LIMIT 1',
    ]) {
      expect((await check(sql, cfg)).errors).toEqual([]);
    }
  });

  it('rejects every other table reference', async () => {
    const cases: Array<[string, string, string?]> = [
      ['SELECT * FROM admin_secrets', 'admin_secrets'],
      ['SELECT * FROM `admin_secrets`', 'admin_secrets', 'mysql'],
      ['SELECT * FROM "admin_secrets"', 'admin_secrets', 'postgres'],
      ['SELECT * FROM [admin_secrets]', 'admin_secrets', 'mssql'],
      ['SELECT * FROM users, admin_secrets', 'admin_secrets'],
      ['SELECT * FROM users WHERE id IN (SELECT id FROM admin_secrets)', 'admin_secrets'],
      ['SELECT * FROM other.invoices', 'other.invoices'],
      // An unqualified entry is the table the connection resolves the name to; another
      // schema or database with a table of that name is a different table.
      ['SELECT * FROM public.users', 'public.users'],
      ['SELECT * FROM tenant_b.users', 'tenant_b.users'],
      ['SELECT * FROM otherdb.users', 'otherdb.users', 'mysql'],
      ['SELECT * FROM otherdb..users', 'otherdb..users', 'mssql'],
      ['SELECT * FROM otherdb.dbo.users', 'otherdb.dbo.users', 'mssql'],
      // A qualified entry allows that schema only, not the bare name (it may resolve elsewhere).
      ['SELECT * FROM invoices', 'invoices'],
      ['SELECT * FROM other.billing.invoices', 'other.billing.invoices', 'mssql'],
      ['SELECT * FROM users JOIN information_schema.columns c ON 1=1', 'information_schema.columns'],
    ];
    for (const [sql, table, databaseType] of cases) {
      const r = await check(sql, cfg, { databaseType: databaseType as any });
      expect(r.valid).toBe(false);
      expect(r.errors).toContain(`Query accesses unauthorized tables: ${table}`);
    }
  });

  it('allows every table when empty (the default)', async () => {
    expect((await check('SELECT * FROM anything LIMIT 1', { allowedTables: [] })).valid).toBe(true);
  });
});

describe('restrictedColumns', () => {
  it('restricts every column whose name contains a bare entry, as 0.0.1 did (default)', async () => {
    const cfg: SecurityConfig = { restrictedColumns: ['password', 'ssn', 'credit_card'] };
    for (const sql of [
      'SELECT email, password_hash FROM users',
      'SELECT ssn_last4 FROM users',
      'SELECT u.credit_card_number FROM users u',
      'SELECT "PasswordHash" FROM users',
      'SELECT id FROM users ORDER BY password_updated_at',
    ]) {
      expect({ sql, errors: (await check(sql, cfg)).errors.join() }).toEqual({
        sql,
        errors: expect.stringMatching(/Query accesses restricted columns: (password|ssn|credit_card)/),
      });
    }
    // Strings, table names, function names and keywords are not columns
    for (const sql of [
      "SELECT id FROM users WHERE note = 'password' LIMIT 1",
      'SELECT id FROM passwords LIMIT 1',
      'SELECT has_password(id) FROM users LIMIT 1',
    ]) {
      expect({ sql, errors: (await check(sql, cfg)).errors }).toEqual({ sql, errors: [] });
    }
    // A bare entry that is part of a reserved word does not match the word
    expect((await check('SELECT id FROM t ORDER BY id LIMIT 1', { restrictedColumns: ['or'] })).errors).toEqual([]);
    // Unreserved keywords can be column names, so they are matched
    for (const databaseType of ['mysql', undefined] as const) {
      expect((await check('SELECT timestamp FROM t LIMIT 1', { restrictedColumns: ['time'] }, { databaseType })).errors).toEqual([
        'Query accesses restricted columns: time',
      ]);
    }
  });

  it('reaches columns through * by name fragment too', async () => {
    const r = await check('SELECT * FROM users LIMIT 1', { restrictedColumns: ['password'] }, { schema });
    expect(r.errors.join()).toMatch(/restricted columns: password/);
  });

  it('matches exact identifiers only with restrictedColumnsMatch: exact', async () => {
    const cfg: SecurityConfig = { restrictedColumns: ['password', 'ssn'], restrictedColumnsMatch: 'exact' };
    for (const sql of [
      'SELECT username, password_updated_at, ssn_last4 FROM users LIMIT 1',
      "SELECT id FROM users WHERE note = 'password' LIMIT 1",
      'SELECT id FROM passwords LIMIT 1',
    ]) {
      expect((await check(sql, cfg)).errors).toEqual([]);
    }
    for (const sql of [
      'SELECT password FROM users',
      'SELECT u.password FROM users u',
      'SELECT "password" FROM users',
      'SELECT id FROM users WHERE ssn = 1',
      'SELECT id FROM users ORDER BY password',
      'SELECT password FROM users AS password',
      'SELECT x.pw FROM (SELECT password AS pw FROM users) x',
    ]) {
      expect((await check(sql, cfg)).errors.join()).toMatch(/Query accesses restricted columns: (password|ssn)/);
    }
  });

  it('a table.column entry applies to that table only, through aliases', async () => {
    const cfg: SecurityConfig = { restrictedColumns: ['users.password'] };
    expect((await check('SELECT a.password FROM admins a JOIN users u ON u.id = a.id LIMIT 1', cfg)).valid).toBe(true);
    expect((await check('SELECT password FROM admins LIMIT 1', cfg)).valid).toBe(true);
    for (const sql of [
      'SELECT u.password FROM admins a JOIN users u ON u.id = a.id',
      'SELECT users.password FROM users',
      'SELECT password FROM users',
      'SELECT x.password FROM (SELECT * FROM users) x',
    ]) {
      expect((await check(sql, cfg)).errors).toContain('Query accesses restricted columns: users.password');
    }
  });

  it('with a schema, expands *, t.* and whole-row references', async () => {
    const cfg: SecurityConfig = { restrictedColumns: ['password'] };
    for (const sql of [
      'SELECT * FROM users',
      'SELECT u.* FROM users u',
      'SELECT o.id, u.* FROM orders o JOIN users u ON u.id = o.user_id',
      'SELECT row_to_json(u) FROM users u',
      'SELECT to_jsonb(users) FROM users',
      'SELECT json_agg(u ORDER BY u.id) FROM users u',
      'SELECT u FROM users u',
      'SELECT * FROM (SELECT * FROM users) t',
      'WITH x AS (SELECT * FROM users) SELECT id FROM x',
      // Postgres alias column lists rename columns by position
      'SELECT pw FROM users AS u(id, email, pw)',
      'SELECT x FROM users u(x)',
    ]) {
      expect({ sql, errors: (await check(sql, cfg, { schema })).errors }).toEqual({
        sql,
        errors: ['Query accesses restricted columns: password'],
      });
    }
    for (const sql of [
      'SELECT * FROM orders',
      'SELECT * FROM orders WHERE user_id IN (SELECT id FROM users)',
      'SELECT o.* FROM orders o JOIN users u ON u.id = o.user_id',
      'SELECT id, email FROM users',
    ]) {
      expect({ sql, errors: (await check(sql, cfg, { schema })).errors }).toEqual({ sql, errors: [] });
    }
  });

  it('without a schema, * is not expanded and nothing crashes', async () => {
    const cfg: SecurityConfig = { restrictedColumns: ['password', 'users.ssn'] };
    expect((await check('SELECT * FROM users', cfg)).errors).toEqual([]);
    expect((await check('SELECT row_to_json(u) FROM users u', cfg)).errors).toEqual([]);
  });
});

describe('maxRowLimit', () => {
  it('rejects a larger top-level LIMIT, TOP or FETCH', async () => {
    const cfg: SecurityConfig = { maxRowLimit: 100 };
    expect((await check('SELECT * FROM users LIMIT 50', cfg)).valid).toBe(true);
    expect((await check('SELECT * FROM users LIMIT 500', cfg)).errors).toEqual(['LIMIT 500 exceeds maximum allowed limit of 100']);
    expect((await check('SELECT * FROM t LIMIT 10, 500', cfg, { databaseType: 'mysql' })).errors).toEqual([
      'LIMIT 500 exceeds maximum allowed limit of 100',
    ]);
    expect((await check('SELECT TOP 500 * FROM t', cfg, { databaseType: 'mssql' })).errors).toEqual([
      'LIMIT 500 exceeds maximum allowed limit of 100',
    ]);
    expect((await check('SELECT * FROM t FETCH FIRST 500 ROWS ONLY', cfg)).errors).toEqual([
      'LIMIT 500 exceeds maximum allowed limit of 100',
    ]);
    expect((await check('SELECT * FROM t LIMIT -1', cfg, { databaseType: 'sqlite' })).errors).toEqual([
      'LIMIT -1 exceeds maximum allowed limit of 100',
    ]);
  });

  it('only counts the top level, and warns when there is no limit', async () => {
    const cfg: SecurityConfig = { maxRowLimit: 100 };
    const inner = await check('SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 500)', cfg);
    expect(inner.errors).toEqual([]);
    expect(inner.warnings).toEqual(['Query does not have a LIMIT clause. Maximum 100 rows will be enforced.']);
    expect((await check("SELECT * FROM t WHERE note = 'LIMIT 5000'", cfg)).errors).toEqual([]);
    expect((await check('SELECT * FROM t LIMIT ALL', cfg)).warnings).toEqual([
      'Query does not have a LIMIT clause. Maximum 100 rows will be enforced.',
    ]);
    expect((await check('SELECT * FROM t LIMIT 5', cfg)).warnings).toEqual([]);
  });

  it('refuses a count that is not a plain number, since it cannot be checked or lowered', async () => {
    const cfg: SecurityConfig = { maxRowLimit: 100 };
    const cases: Array<[string, string, string?]> = [
      ['SELECT * FROM t LIMIT (SELECT 1000000)', 'LIMIT'],
      ['SELECT * FROM t LIMIT 2 * 100000', 'LIMIT'],
      ['SELECT * FROM t LIMIT 10, 2 * 1000', 'LIMIT', 'mysql'],
      ['SELECT * FROM t FETCH FIRST 2 * 1000 ROWS ONLY', 'FETCH'],
      ['SELECT * FROM t FETCH FIRST 50 PERCENT ROWS ONLY', 'FETCH'],
      ['SELECT TOP 100 PERCENT * FROM t', 'TOP', 'mssql'],
      ['SELECT TOP (2 * 1000) * FROM t', 'TOP', 'mssql'],
      // Variables are not placeholders the application binds: @@TEXTSIZE is 2147483647
      ['SELECT TOP (@@TEXTSIZE) * FROM t', 'TOP', 'mssql'],
      ['SELECT TOP (@n) * FROM t', 'TOP', 'mssql'],
      ['SELECT * FROM t LIMIT @@max_join_size', 'LIMIT', 'mysql'],
      ['SELECT * FROM t FETCH FIRST ? PERCENT ROWS ONLY', 'FETCH', 'postgres'],
    ];
    for (const [sql, keyword, databaseType] of cases) {
      const r = await check(sql, cfg, { databaseType: databaseType as any });
      // In the generic dialect a parenthesized query after LIMIT also counts as a second T-SQL statement
      expect(r.errors).toContain(`${keyword} value must be a plain number no greater than 100`);
    }
  });

  it('only warns for a lone placeholder, which the application binds (as in 0.0.1)', async () => {
    const cfg: SecurityConfig = { maxRowLimit: 100 };
    for (const [sql, databaseType] of [
      ['SELECT * FROM t LIMIT ?', 'mysql'],
      ['SELECT * FROM t LIMIT $1', 'postgres'],
      ['SELECT * FROM t LIMIT ?, ?', 'mysql'],
      ['SELECT * FROM t LIMIT :n', 'sqlite'],
    ] as const) {
      const r = await check(sql, cfg, { databaseType });
      expect(r.errors).toEqual([]);
      expect(r.warnings).toEqual(['Query does not have a LIMIT clause. Maximum 100 rows will be enforced.']);
    }
  });

  it('defaults to 1000', async () => {
    expect((await check('SELECT * FROM t LIMIT 1001')).errors).toEqual(['LIMIT 1001 exceeds maximum allowed limit of 1000']);
    expect((await check('SELECT * FROM t LIMIT 1000')).valid).toBe(true);
  });

  it('is not checked for statements other than SELECT', async () => {
    const r = await check('DELETE FROM t WHERE id = 1 LIMIT 5000', { allowedOperations: ['DELETE'], maxRowLimit: 10 }, { databaseType: 'mysql' });
    expect(r).toEqual({ valid: true, errors: [], warnings: [] });
  });
});

describe('requireUserContext', () => {
  it('is required by default and checked first', async () => {
    const v = new SecurityValidator();
    expect(await v.validate('DROP TABLE x')).toEqual({ valid: false, errors: ['User context is required but not provided'], warnings: [] });
    expect((await v.validate('SELECT 1 LIMIT 1', ctx)).valid).toBe(true);
  });

  it('can be turned off', async () => {
    expect((await new SecurityValidator({ requireUserContext: false }).validate('SELECT 1 LIMIT 1')).valid).toBe(true);
  });
});

describe('enableRowLevelSecurity', () => {
  it('gates addRowLevelSecurity (default on in the validator)', () => {
    expect(new SecurityValidator().addRowLevelSecurity('SELECT * FROM t', ctx)).toBe('SELECT * FROM t WHERE user_id = 7');
    expect(new SecurityValidator({ enableRowLevelSecurity: false }).addRowLevelSecurity('SELECT * FROM t', ctx)).toBe('SELECT * FROM t');
  });
});

describe('customValidator', () => {
  it('receives the query and context, and its result is enforced', async () => {
    const fn = jest.fn().mockResolvedValue(false);
    const r = await new SecurityValidator({ customValidator: fn }).validate('SELECT 1 LIMIT 1', ctx);
    expect(fn).toHaveBeenCalledWith('SELECT 1 LIMIT 1', ctx);
    expect(r.errors).toEqual(['Custom validation failed']);
  });

  it('reports a thrown error', async () => {
    const r = await check('SELECT 1 LIMIT 1', {
      customValidator: async () => {
        throw new Error('boom');
      },
    });
    expect(r.errors).toEqual(['Custom validation error: boom']);
  });

  it('is not called for queries rejected before any check', async () => {
    const fn = jest.fn().mockResolvedValue(true);
    await check("SELECT 'unterminated", { customValidator: fn });
    await check('DROP TABLE x', { customValidator: fn });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('allowUnion', () => {
  const sql = 'SELECT id FROM a UNION SELECT id FROM b LIMIT 5';
  it('blocks UNION by default with the 0.0.1 pattern name', async () => {
    expect((await check(sql)).errors).toEqual(['Query contains dangerous patterns: UNION.*SELECT']);
    expect((await check('SELECT id FROM a UNION ALL (SELECT id FROM b) LIMIT 5')).valid).toBe(false);
  });

  it('allows UNION when set', async () => {
    expect((await check(sql, { allowUnion: true })).valid).toBe(true);
  });

  it('never blocks INTERSECT or EXCEPT, or the word inside strings and names', async () => {
    expect((await check('SELECT id FROM a INTERSECT SELECT id FROM b LIMIT 5')).valid).toBe(true);
    expect((await check("SELECT union_id, 'union select' FROM t LIMIT 5")).valid).toBe(true);
  });
});

describe('blockedFunctions', () => {
  it('adds names and prefix patterns to the default list', async () => {
    const cfg: SecurityConfig = { blockedFunctions: ['audit_purge', 'internal_*'] };
    expect((await check('SELECT audit_purge(1)', cfg)).errors).toEqual(['Query contains dangerous patterns: function AUDIT_PURGE']);
    expect((await check('SELECT internal_dump()', cfg)).errors).toEqual(['Query contains dangerous patterns: function INTERNAL_DUMP']);
    expect((await check('SELECT lower(name) FROM t LIMIT 1', cfg)).valid).toBe(true);
    expect((await check('SELECT audit_purge FROM t LIMIT 1', cfg)).valid).toBe(true); // a column, not a call
  });

  it('wins over allowedFunctions', async () => {
    const r = await check('SELECT nextval(1)', { blockedFunctions: ['nextval'], allowedFunctions: ['nextval'] });
    expect(r.valid).toBe(false);
  });
});

describe('allowedFunctions', () => {
  it('overrides the default list only for the listed names', async () => {
    const cfg: SecurityConfig = { allowedFunctions: ['nextval', 'PG_ADVISORY*'] };
    expect((await check("SELECT nextval('s')", cfg)).valid).toBe(true);
    expect((await check('SELECT pg_advisory_lock(1)', cfg)).valid).toBe(true);
    expect((await check("SELECT setval('s', 1)", cfg)).errors).toEqual(['Query contains dangerous patterns: function SETVAL']);
    expect((await check("SELECT nextval('s')")).errors).toEqual(['Query contains dangerous patterns: function NEXTVAL']);
  });
});

describe('rowLevelSecurityColumn', () => {
  it('is the column the filter uses (default user_id)', () => {
    expect(new SecurityValidator({ rowLevelSecurityColumn: 'tenant_id' }).addRowLevelSecurity('SELECT * FROM t', ctx)).toBe(
      'SELECT * FROM t WHERE tenant_id = 7'
    );
  });

  it('rejects anything but a single identifier', () => {
    const v = new SecurityValidator({ rowLevelSecurityColumn: 'x = x OR 1' });
    expect(() => v.addRowLevelSecurity('SELECT * FROM t', ctx)).toThrow(TextToQueryError);
  });
});

describe('enforceSensitiveColumns', () => {
  it('warns by default about schema columns marked sensitive', async () => {
    const r = await check('SELECT email, password FROM users LIMIT 1', {}, { schema });
    expect(r.valid).toBe(true);
    expect(r.warnings).toEqual(['Query accesses sensitive columns: users.password']);
    expect((await check('SELECT * FROM users LIMIT 1', {}, { schema })).warnings).toEqual([
      'Query accesses sensitive columns: users.password, users.ssn',
    ]);
  });

  it('rejects them when set', async () => {
    const r = await check('SELECT u.ssn FROM users u LIMIT 1', { enforceSensitiveColumns: true }, { schema });
    expect(r.errors).toEqual(['Query accesses sensitive columns: users.ssn']);
    // admins.password is not marked sensitive
    expect((await check('SELECT password FROM admins LIMIT 1', { enforceSensitiveColumns: true }, { schema })).valid).toBe(true);
  });

  it('has no effect without a schema', async () => {
    expect((await check('SELECT password FROM users LIMIT 1', { enforceSensitiveColumns: true })).valid).toBe(true);
  });
});

describe('SecurityValidatorOptions', () => {
  it('databaseType selects the dialect (strings, comments, quoting)', async () => {
    const sql = 'SELECT "a; DROP TABLE x" FROM t LIMIT 1';
    expect((await check(sql, {}, { databaseType: 'mysql' })).valid).toBe(true); // a string in MySQL
    expect((await check(sql, {}, { databaseType: 'postgres' })).valid).toBe(true); // a quoted identifier there
    expect((await check('SELECT 1 # 2 LIMIT 1', {}, { databaseType: 'postgres' })).valid).toBe(true); // XOR in Postgres
    expect((await check('SELECT 1 # 2 LIMIT 1', {}, { databaseType: 'mysql' })).errors).toEqual(['Query contains dangerous patterns: #']);
    expect((await check('SELECT 1 # 2 LIMIT 1')).errors).toEqual(['Query contains dangerous patterns: #']); // generic: ambiguous
  });

  it('falls back to the schema databaseType', async () => {
    const mssqlSchema: DatabaseSchema = { databaseType: 'mssql', tables: [] };
    expect((await check('SELECT TOP 5 [x] FROM [t]', {}, { schema: mssqlSchema })).valid).toBe(true);
  });

  it('mongodb and no type use the generic dialect', async () => {
    expect((await check('SELECT 1--x', {}, { databaseType: 'mongodb' })).errors).toEqual(['Query contains dangerous patterns: --']);
  });
});
