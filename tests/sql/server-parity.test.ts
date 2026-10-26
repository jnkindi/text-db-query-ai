/**
 * Cases where a naive reading of the SQL differs from what the database
 * server runs. Each one would let a table, column or function hide from the
 * validator, so the analysis must follow the server (or refuse the input).
 */
import { analyzeSql, isBlockedFunction, SqlLexError, tokenize } from '../../src/sql';
import type { SqlDialect } from '../../src/sql';

const tableNames = (sql: string, dialect?: SqlDialect) => analyzeSql(sql, dialect).tables.map((t) => t.name);

function lexErrorKind(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof SqlLexError) return e.kind;
    throw e;
  }
  return undefined;
}

describe('MySQL executable comments', () => {
  it.each(['mysql', 'generic'] as const)('rejects /*! ... */ and /*M! ... */ in %s', (dialect) => {
    expect(lexErrorKind(() => tokenize('SELECT 1 /*! ; DROP TABLE users */', dialect))).toBe('executable_comment');
    expect(lexErrorKind(() => tokenize('SELECT 1 /*!50000 UNION SELECT password FROM users */', dialect))).toBe(
      'executable_comment',
    );
    expect(lexErrorKind(() => tokenize('SELECT 1 /*M!100000 , SLEEP(5) */', dialect))).toBe('executable_comment');
  });

  it('reports the opening delimiter and position', () => {
    try {
      tokenize('SELECT 1 /*!50000 x */', 'mysql');
      throw new Error('expected SqlLexError');
    } catch (e) {
      expect(e).toBeInstanceOf(SqlLexError);
      expect((e as SqlLexError).position).toBe(9);
      expect((e as SqlLexError).delimiter).toBe('/*!');
      expect((e as SqlLexError).message).toMatch(/executable comment/i);
    }
  });

  it('keeps ordinary comments and optimizer hints as comments', () => {
    expect(analyzeSql('SELECT /*+ MAX_EXECUTION_TIME(100) */ a FROM t', 'mysql').hasComments).toBe(true);
    expect(analyzeSql('SELECT /* note */ a FROM t', 'mysql').hasComments).toBe(true);
  });

  it.each(['postgres', 'sqlite', 'mssql'] as const)('treats /*! as an ordinary comment in %s', (dialect) => {
    expect(analyzeSql('SELECT a FROM t /*! DROP TABLE users */', dialect).hasComments).toBe(true);
    expect(tableNames('SELECT a FROM t /*! DROP TABLE users */', dialect)).toEqual(['t']);
  });
});

describe('MySQL double-dash comments', () => {
  it.each(['mysql'] as const)('reads --x as two minus signs in %s, as the server does', (dialect) => {
    const sql = 'SELECT 1 --(SELECT password FROM users)';
    expect(tableNames(sql, dialect)).toEqual(['users']);
    expect(analyzeSql(sql, dialect).hasComments).toBe(false);
    expect(tableNames('SELECT a FROM t WHERE b = 1--(SELECT 1 FROM secrets)', dialect)).toEqual(['t', 'secrets']);
  });

  it.each(['mysql', 'generic'] as const)('still reads -- followed by whitespace as a comment in %s', (dialect) => {
    for (const sql of ['SELECT a FROM t -- note', 'SELECT a FROM t --\tnote', 'SELECT a FROM t --\nWHERE 1 = 1', 'SELECT a FROM t --']) {
      const a = analyzeSql(sql, dialect);
      expect(a.hasComments).toBe(true);
      expect(a.tables.map((t) => t.name)).toEqual(['t']);
    }
  });

  it.each(['postgres', 'sqlite', 'mssql'] as const)('reads --x as a comment in %s', (dialect) => {
    const a = analyzeSql('SELECT 1 --(SELECT password FROM users)', dialect);
    expect(a.hasComments).toBe(true);
    expect(a.tables).toEqual([]);
  });
});

describe('ODBC escapes', () => {
  it.each(['mysql', 'mssql', 'generic'] as const)('reads tables inside {oj ...} in %s', (dialect) => {
    expect(
      tableNames('SELECT * FROM {oj users LEFT OUTER JOIN secrets ON users.id = secrets.user_id}', dialect),
    ).toEqual(['users', 'secrets']);
    expect(tableNames('SELECT * FROM { OJ users u LEFT JOIN secrets s ON u.id = s.user_id }', dialect)).toEqual([
      'users',
      'secrets',
    ]);
  });
});

describe('schema-qualified function calls', () => {
  it('records the qualified name, so qualified block patterns apply', () => {
    const a = analyzeSql("SELECT dbms_pipe.receive_message('x', 5)", 'generic');
    expect(a.functions).toEqual(['DBMS_PIPE.RECEIVE_MESSAGE']);
    expect(a.functions.some((f) => isBlockedFunction(f))).toBe(true);
    expect(analyzeSql('SELECT app.reset_all()').functions.some((f) => isBlockedFunction(f, ['app.*']))).toBe(true);
  });

  it('still matches the bare name of a qualified call', () => {
    const a = analyzeSql('SELECT pg_catalog.pg_sleep(1)');
    expect(a.functions).toEqual(['PG_CATALOG.PG_SLEEP']);
    expect(isBlockedFunction(a.functions[0])).toBe(true);
    expect(analyzeSql("SELECT * FROM extensions.dblink('host=x', 'SELECT 1') AS t(a int)").functions).toEqual([
      'EXTENSIONS.DBLINK',
    ]);
  });
});

describe('CTE names versus table names', () => {
  // A name that only matches a CTE after case folding must stay a table
  // wherever the server may compare names case-sensitively.
  it.each(['mysql', 'mssql', 'generic'] as const)('keeps a differently cased reference as a table in %s', (dialect) => {
    expect(tableNames('WITH Secrets AS (SELECT 1 AS x) SELECT * FROM secrets', dialect)).toEqual(['secrets']);
    expect(tableNames('WITH s AS (SELECT 1 AS x) SELECT * FROM s', dialect)).toEqual([]);
  });

  it('folds unquoted names in postgres and compares quoted ones exactly', () => {
    expect(tableNames('WITH Secrets AS (SELECT 1 AS x) SELECT * FROM secrets', 'postgres')).toEqual([]);
    expect(tableNames('WITH "Secrets" AS (SELECT 1 AS x) SELECT * FROM secrets', 'postgres')).toEqual(['secrets']);
  });

  it('compares names case-insensitively in sqlite, as sqlite does', () => {
    expect(tableNames('WITH Secrets AS (SELECT 1 AS x) SELECT * FROM secrets', 'sqlite')).toEqual([]);
  });
});

describe('generic dialect: constructs that databases read differently', () => {
  it('refuses -- followed by a non-space, which MySQL runs as code and others skip', () => {
    expect(lexErrorKind(() => tokenize("SELECT 1 --'\n; DROP TABLE users; --'", 'generic'))).toBe('ambiguous_syntax');
    expect(lexErrorKind(() => tokenize('SELECT a FROM t --x', 'generic'))).toBe('ambiguous_syntax');
    expect(analyzeSql('SELECT a FROM t -- note', 'generic').hasComments).toBe(true);
  });

  it('matches CTE names only when the exact and the Postgres-folded names both agree', () => {
    // Postgres folds the unquoted reference to "secrets", which is not the CTE "Secrets".
    expect(tableNames('WITH "Secrets" AS (SELECT 1 AS x) SELECT * FROM Secrets', 'generic')).toEqual(['Secrets']);
    expect(tableNames('WITH recent AS (SELECT 1 AS x) SELECT * FROM recent', 'generic')).toEqual([]);
    expect(tableNames('WITH Recent AS (SELECT 1 AS x) SELECT * FROM Recent', 'generic')).toEqual([]);
  });
});

describe('SQLite names written as single-quoted strings', () => {
  // SQLite's grammar accepts a string where it expects a name: FROM 'accounts', a.'password', AS 'x'
  const columns = (sql: string, dialect: SqlDialect) =>
    analyzeSql(sql, dialect).columns.map((c) => (c.qualifier ? `${c.qualifier}.${c.name}` : c.name));

  it.each(['sqlite', 'generic'] as const)('reads them as tables and columns in %s', (dialect) => {
    expect(tableNames("SELECT * FROM 'accounts'", dialect)).toEqual(['accounts']);
    expect(tableNames("SELECT * FROM orders, 'secrets' s", dialect)).toEqual(['orders', 'secrets']);
    expect(tableNames("SELECT o.id FROM orders o JOIN 'notes' n ON n.id = o.id", dialect)).toEqual(['orders', 'notes']);
    expect(tableNames("SELECT (SELECT body FROM 'notes' x LIMIT 1) FROM orders", dialect)).toEqual(['notes', 'orders']);
    expect(tableNames("SELECT * FROM 'main'.'accounts'", dialect)).toEqual(['accounts']);
    expect(tableNames("INSERT INTO 'archive' SELECT * FROM orders", dialect)).toEqual(['archive', 'orders']);
    expect(tableNames("UPDATE 'orders' SET total = 1", dialect)).toEqual(['orders']);
    expect(tableNames("DELETE FROM 'orders' WHERE id = 1", dialect)).toEqual(['orders']);
    expect(columns("SELECT a.'password' FROM accounts a", dialect)).toContain('a.password');
    expect(analyzeSql("SELECT 'it''s' FROM 'x''y'", dialect).tables[0].name).toBe("x'y");
  });

  it.each(['sqlite', 'generic'] as const)('keeps string values as strings in %s', (dialect) => {
    expect(columns("SELECT 'password' AS label FROM accounts WHERE note = 'password'", dialect)).not.toContain('password');
    expect(tableNames("SELECT value FROM json_each('[1, 2]')", dialect)).toEqual([]);
    expect(tableNames("SELECT id FROM orders WHERE status IN ('paid', 'new') ORDER BY 'x'", dialect)).toEqual(['orders']);
  });

  it('does not read them as names in postgres, where they are string literals', () => {
    expect(tableNames("SELECT * FROM 'accounts'", 'postgres')).toEqual([]);
  });
});
