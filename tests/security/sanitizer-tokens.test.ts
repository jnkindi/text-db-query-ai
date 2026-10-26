/**
 * QuerySanitizer on top of the lexer (design doc 5.3).
 */

import { QuerySanitizer } from '../../src/security/sanitizer';

const generic = new QuerySanitizer();
const pg = new QuerySanitizer('postgres');
const my = new QuerySanitizer('mysql');
const ms = new QuerySanitizer('mssql');
const lite = new QuerySanitizer('sqlite');

describe('sanitize', () => {
  it('keeps every statement: only trailing semicolons are dropped (the critic stacked-statement case)', () => {
    expect(pg.sanitize('SELECT id FROM t; DELETE FROM t; -- done')).toBe('SELECT id FROM t; DELETE FROM t');
    expect(generic.sanitize('SELECT id FROM t; DELETE FROM t; -- done')).toBe('SELECT id FROM t; DELETE FROM t');
    expect(pg.sanitize('SELECT 1 /* x */; TRUNCATE users')).toBe('SELECT 1 ; TRUNCATE users');
    expect(pg.sanitize('SELECT 1 ; ; \n')).toBe('SELECT 1');
    expect(pg.sanitize('SELECT 1 -- a\n; -- b\n')).toBe('SELECT 1');
  });

  it('never touches strings, quoted identifiers or dollar quotes', () => {
    expect(pg.sanitize("SELECT * FROM t WHERE code = 'A--B' AND active = 1")).toBe("SELECT * FROM t WHERE code = 'A--B' AND active = 1");
    expect(pg.sanitize("SELECT 'x /* y */ z',  'a  b'")).toBe("SELECT 'x /* y */ z', 'a  b'");
    expect(pg.sanitize('SELECT "a  -- b"\n FROM t')).toBe('SELECT "a  -- b" FROM t');
    expect(pg.sanitize("SELECT $$ two  spaces; -- $$")).toBe('SELECT $$ two  spaces; -- $$');
    expect(my.sanitize("SELECT 'it\\'s -- fine'")).toBe("SELECT 'it\\'s -- fine'");
  });

  it('replaces each comment with a space, so tokens are never glued together', () => {
    expect(pg.sanitize('SELECT a/**/FROM t')).toBe('SELECT a FROM t');
    expect(pg.sanitize('SELECT 1-/**/-1')).toBe('SELECT 1- -1');
    expect(pg.sanitize('SELECT 1 /* a /* nested */ b */ + 2')).toBe('SELECT 1 + 2');
    expect(my.sanitize('SELECT 1 # note\nFROM t')).toBe('SELECT 1 FROM t');
    expect(ms.sanitize('SELECT [a] -- x\nFROM [t]')).toBe('SELECT [a] FROM [t]');
  });

  it('collapses whitespace, including Unicode spaces, outside literals', () => {
    expect(pg.sanitize('  SELECT\t*\r\n FROM users  ')).toBe('SELECT * FROM users');
  });

  it('removes NUL bytes first', () => {
    expect(pg.sanitize('SELECT 1;\0')).toBe('SELECT 1');
    expect(pg.sanitize("SELECT 'a\0b'")).toBe("SELECT 'ab'");
  });

  it('generic: keeps # comments (an operator to Postgres) so validation rejects them', () => {
    expect(generic.sanitize("SELECT data #>> '{a}' AS v\nFROM t")).toBe("SELECT data #>> '{a}' AS v\nFROM t");
    expect(generic.sanitize('SELECT 1--x')).toBe('SELECT 1--x');
  });

  it('keeps a MySQL executable comment so validation rejects it', () => {
    expect(my.sanitize('SELECT /*!50000 SLEEP(5) */ 1')).toBe('SELECT /*!50000 SLEEP(5) */ 1');
    expect(pg.sanitize('SELECT /*! x */ 1')).toBe('SELECT 1'); // an ordinary comment to Postgres
  });

  it('falls back to the 0.0.1 behavior when the query cannot be tokenized', () => {
    expect(pg.sanitize("SELECT * FROM t WHERE name = 'John -- x")).toBe("SELECT * FROM t WHERE name = 'John");
    expect(pg.sanitize("SELECT 'a;;")).toBe("SELECT 'a");
  });
});

describe('extractFromMarkdown', () => {
  it.each([
    ['```sql\nSELECT 1\n```', 'SELECT 1'],
    ['```SQL\r\nSELECT 1\r\n```', 'SELECT 1'],
    ['```postgresql\nSELECT 1\n```', 'SELECT 1'],
    ['```sql SELECT 1```', 'SELECT 1'],
    ['```SELECT 1```', 'SELECT 1'],
    ['```\nSELECT 1\n```', 'SELECT 1'],
    ['~~~sql\nSELECT 1\n~~~', 'SELECT 1'],
    ['Here is the query:\n\n```sql\nSELECT 1\n```\nIt returns one row.', 'SELECT 1'],
    ['```python\nprint(1)\n```\n```sql\nSELECT 1\n```', 'SELECT 1'],
    ['```text\nnote\n```\n```\nSELECT 1\n```', 'SELECT 1'],
    ['```\nsql\nSELECT 1\n```', 'SELECT 1'],
    ['<sql>SELECT 1</sql>', 'SELECT 1'],
    ['Answer: <sql>\nSELECT 1\n</sql>', 'SELECT 1'],
    ['sql\nSELECT 1', 'SELECT 1'],
    ['```sql\nSELECT 1', 'SELECT 1'],
  ])('%j', (text, expected) => {
    expect(generic.extractFromMarkdown(text)).toBe(expected);
  });

  it('returns text without a fence as is', () => {
    expect(generic.extractFromMarkdown('  SELECT 1\n')).toBe('  SELECT 1\n');
    expect(generic.extractFromMarkdown('SELECT sql FROM t')).toBe('SELECT sql FROM t');
  });
});

describe('validateSQLSyntax', () => {
  it('accepts the 0.0.1 statements, also after leading parentheses and comments', () => {
    for (const q of ['SELECT 1', 'WITH x AS (SELECT 1) SELECT * FROM x', '(SELECT 1) UNION (SELECT 2)', 'insert into t values (1)', '-- c\nSELECT 1']) {
      expect(pg.validateSQLSyntax(q)).toEqual({ valid: true });
    }
  });

  it('keeps the 0.0.1 messages', () => {
    expect(pg.validateSQLSyntax('INVALID QUERY')).toEqual({
      valid: false,
      error: 'Query must start with one of: SELECT, INSERT, UPDATE, DELETE, WITH',
    });
    expect(pg.validateSQLSyntax("INVALID 'x")).toEqual({
      valid: false,
      error: 'Query must start with one of: SELECT, INSERT, UPDATE, DELETE, WITH',
    });
    expect(pg.validateSQLSyntax('SELECT (1')).toEqual({ valid: false, error: 'Unbalanced parentheses' });
    expect(pg.validateSQLSyntax('SELECT 1)')).toEqual({ valid: false, error: 'Unbalanced parentheses' });
    expect(pg.validateSQLSyntax("SELECT 'x")).toEqual({ valid: false, error: 'Unbalanced single quotes' });
    expect(pg.validateSQLSyntax('SELECT "x')).toEqual({ valid: false, error: 'Unbalanced double quotes' });
    expect(my.validateSQLSyntax('SELECT "x')).toEqual({ valid: false, error: 'Unbalanced double quotes' });
  });

  it('counts parentheses and quotes on tokens only', () => {
    expect(pg.validateSQLSyntax("SELECT ')' AS p, 'O''Brien', E'it\\'s', $$it's$$")).toEqual({ valid: true });
    expect(pg.validateSQLSyntax('SELECT "a(b" FROM t')).toEqual({ valid: true });
    expect(my.validateSQLSyntax("SELECT 'it\\'s'")).toEqual({ valid: true });
  });

  it('reports other unterminated tokens', () => {
    expect(my.validateSQLSyntax('SELECT `x')).toEqual({ valid: false, error: 'Unbalanced backticks' });
    expect(ms.validateSQLSyntax('SELECT [x')).toEqual({ valid: false, error: 'Unbalanced brackets' });
    expect(pg.validateSQLSyntax('SELECT 1 /* x')).toEqual({ valid: false, error: 'Unterminated block comment' });
    expect(pg.validateSQLSyntax('SELECT $a$ x').error).toContain('Unterminated string literal');
  });

  it('leaves MySQL executable comments to the security validator', () => {
    expect(my.validateSQLSyntax('SELECT /*! 1 */')).toEqual({ valid: true });
  });
});

describe('addLimitIfMissing', () => {
  it('appends LIMIT unless the main statement has a top-level limit', () => {
    expect(pg.addLimitIfMissing('SELECT * FROM users', 100)).toBe('SELECT * FROM users LIMIT 100');
    expect(pg.addLimitIfMissing('SELECT * FROM users LIMIT 50', 100)).toBe('SELECT * FROM users LIMIT 50');
    expect(pg.addLimitIfMissing('SELECT * FROM users LIMIT 5000', 100)).toBe('SELECT * FROM users LIMIT 5000');
    expect(pg.addLimitIfMissing('SELECT * FROM users LIMIT $1', 100)).toBe('SELECT * FROM users LIMIT $1');
    expect(pg.addLimitIfMissing('SELECT * FROM users FETCH FIRST 5 ROWS ONLY', 100)).toBe('SELECT * FROM users FETCH FIRST 5 ROWS ONLY');
    expect(pg.addLimitIfMissing('SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 5)', 100)).toBe(
      'SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 5) LIMIT 100'
    );
    expect(pg.addLimitIfMissing("SELECT 'LIMIT 5' AS s", 100)).toBe("SELECT 'LIMIT 5' AS s LIMIT 100");
    expect(pg.addLimitIfMissing('WITH x AS (SELECT * FROM t LIMIT 5) SELECT * FROM x', 100)).toBe(
      'WITH x AS (SELECT * FROM t LIMIT 5) SELECT * FROM x LIMIT 100'
    );
    expect(pg.addLimitIfMissing('SELECT * FROM t -- note', 100)).toBe('SELECT * FROM t LIMIT 100 -- note');
    expect(pg.addLimitIfMissing('SELECT * FROM t;', 100)).toBe('SELECT * FROM t LIMIT 100;');
  });

  it('mssql: inserts TOP after SELECT [DISTINCT|ALL], or FETCH after OFFSET', () => {
    expect(ms.addLimitIfMissing('SELECT * FROM users', 100)).toBe('SELECT TOP 100 * FROM users');
    expect(ms.addLimitIfMissing('SELECT DISTINCT a FROM t', 100)).toBe('SELECT DISTINCT TOP 100 a FROM t');
    expect(ms.addLimitIfMissing('WITH x AS (SELECT 1 AS a) SELECT a FROM x', 100)).toBe('WITH x AS (SELECT 1 AS a) SELECT TOP 100 a FROM x');
    expect(ms.addLimitIfMissing('SELECT TOP 10 id FROM t', 100)).toBe('SELECT TOP 10 id FROM t');
    expect(ms.addLimitIfMissing('SELECT id FROM t ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY', 100)).toBe(
      'SELECT id FROM t ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY'
    );
    expect(ms.addLimitIfMissing('SELECT id FROM t ORDER BY id OFFSET 10 ROWS', 100)).toBe(
      'SELECT id FROM t ORDER BY id OFFSET 10 ROWS FETCH NEXT 100 ROWS ONLY'
    );
    // TOP in each branch would allow 100 rows per branch: the whole result is limited instead
    expect(ms.addLimitIfMissing('SELECT a FROM t UNION SELECT b FROM u', 100)).toBe(
      'SELECT a FROM t UNION SELECT b FROM u ORDER BY 1 OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY'
    );
    expect(ms.addLimitIfMissing('SELECT a FROM t UNION ALL SELECT b FROM u ORDER BY a DESC', 100)).toBe(
      'SELECT a FROM t UNION ALL SELECT b FROM u ORDER BY a DESC OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY'
    );
    expect(ms.enforceLimit('SELECT TOP 100 a FROM t UNION SELECT TOP 100 b FROM u', 100)).toBe(
      'SELECT TOP 100 a FROM t UNION SELECT TOP 100 b FROM u ORDER BY 1 OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY'
    );
    expect(ms.addLimitIfMissing('WITH x AS (SELECT a FROM t) SELECT a FROM x UNION SELECT b FROM u', 5)).toBe(
      'WITH x AS (SELECT a FROM t) SELECT a FROM x UNION SELECT b FROM u ORDER BY 1 OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY'
    );
    expect(ms.addLimitIfMissing('UPDATE t SET a = 1', 100)).toBe('UPDATE t SET a = 1');
  });

  it('falls back to the 0.0.1 check when the query cannot be tokenized', () => {
    expect(pg.addLimitIfMissing("SELECT 'x", 100)).toBe("SELECT 'x LIMIT 100");
  });
});

describe('enforceLimit', () => {
  it('lowers a larger top-level count in place', () => {
    expect(pg.enforceLimit('SELECT * FROM users LIMIT 5000', 100)).toBe('SELECT * FROM users LIMIT 100');
    expect(pg.enforceLimit('SELECT * FROM users LIMIT 50', 100)).toBe('SELECT * FROM users LIMIT 50');
    expect(pg.enforceLimit('SELECT * FROM users LIMIT 5000 OFFSET 10', 100)).toBe('SELECT * FROM users LIMIT 100 OFFSET 10');
    expect(pg.enforceLimit('SELECT * FROM users LIMIT ALL', 100)).toBe('SELECT * FROM users LIMIT 100');
    expect(pg.enforceLimit('SELECT * FROM users LIMIT (5000)', 100)).toBe('SELECT * FROM users LIMIT (100)');
    expect(pg.enforceLimit('SELECT * FROM t FETCH FIRST 5000 ROWS ONLY', 100)).toBe('SELECT * FROM t FETCH FIRST 100 ROWS ONLY');
    expect(my.enforceLimit('SELECT * FROM t LIMIT 10, 5000', 100)).toBe('SELECT * FROM t LIMIT 10, 100');
    expect(lite.enforceLimit('SELECT * FROM t LIMIT -1', 100)).toBe('SELECT * FROM t LIMIT 100');
    expect(ms.enforceLimit('SELECT TOP 5000 * FROM t', 100)).toBe('SELECT TOP 100 * FROM t');
    expect(ms.enforceLimit('SELECT TOP (5000) * FROM t', 100)).toBe('SELECT TOP (100) * FROM t');
    expect(ms.enforceLimit('SELECT id FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 5000 ROWS ONLY', 100)).toBe(
      'SELECT id FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY'
    );
  });

  it('adds a limit when there is none, and leaves subqueries and parameters alone', () => {
    expect(pg.enforceLimit('SELECT * FROM t', 100)).toBe('SELECT * FROM t LIMIT 100');
    expect(pg.enforceLimit('SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 5000)', 100)).toBe(
      'SELECT * FROM t WHERE id IN (SELECT id FROM u LIMIT 5000) LIMIT 100'
    );
    expect(pg.enforceLimit('SELECT * FROM t LIMIT $1', 100)).toBe('SELECT * FROM t LIMIT $1');
  });
});
