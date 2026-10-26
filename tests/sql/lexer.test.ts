/**
 * Tests for the dialect-aware SQL lexer (src/sql/lexer.ts)
 */

import { tokenize, toSqlDialect, SqlLexError, Token, SqlDialect } from '../../src/sql/lexer';
import { splitStatements } from '../../src/sql/analyze';

const DIALECTS: SqlDialect[] = ['postgres', 'mysql', 'sqlite', 'mssql', 'generic'];

/** Tokenize and check that the tokens cover the input exactly, in order. */
function lex(sql: string, dialect: SqlDialect = 'generic', backslashEscapes?: boolean): Token[] {
  const tokens = tokenize(sql, dialect, backslashEscapes === undefined ? {} : { backslashEscapes });
  let pos = 0;
  for (const t of tokens) {
    expect(t.start).toBe(pos);
    expect(t.end).toBeGreaterThan(t.start);
    expect(t.text).toBe(sql.slice(t.start, t.end));
    pos = t.end;
  }
  expect(pos).toBe(sql.length);
  expect(tokens.map((t) => t.text).join('')).toBe(sql);
  return tokens;
}

/** Significant tokens as [type, text] pairs. */
function sig(sql: string, dialect: SqlDialect = 'generic', backslashEscapes?: boolean): Array<[string, string]> {
  return lex(sql, dialect, backslashEscapes)
    .filter((t) => t.type !== 'whitespace')
    .map((t) => [t.type, t.text]);
}

function single(text: string, dialect: SqlDialect, backslashEscapes?: boolean): Token {
  const tokens = lex(text, dialect, backslashEscapes);
  expect(tokens).toHaveLength(1);
  return tokens[0];
}

function lexError(sql: string, dialect: SqlDialect, backslashEscapes?: boolean): SqlLexError {
  try {
    tokenize(sql, dialect, backslashEscapes === undefined ? {} : { backslashEscapes });
  } catch (e) {
    expect(e).toBeInstanceOf(SqlLexError);
    expect(e).toBeInstanceOf(Error);
    return e as SqlLexError;
  }
  throw new Error(`expected SqlLexError for ${sql}`);
}

describe('toSqlDialect', () => {
  it('maps database types to dialects', () => {
    expect(toSqlDialect('postgres')).toBe('postgres');
    expect(toSqlDialect('mysql')).toBe('mysql');
    expect(toSqlDialect('sqlite')).toBe('sqlite');
    expect(toSqlDialect('mssql')).toBe('mssql');
    expect(toSqlDialect('mongodb')).toBe('generic');
    expect(toSqlDialect(undefined)).toBe('generic');
    expect(toSqlDialect()).toBe('generic');
  });
});

describe('tokenize: coverage and basic tokens', () => {
  const samples = [
    "SELECT u.id, COUNT(*) AS n FROM \"User\" u WHERE u.email = 'a''b' AND x::int >= 3 -- c\n;",
    'SELECT `a`, "b", [c] FROM t /* x */ WHERE d <> 1 OR e != 2 # tail',
    "SELECT $1, ?, :name, @p, @@version, E'x', N'y', X'0F', B'01', $$z$$ FROM t;\t\r\n",
    'select a from　t﻿',
    '',
  ];
  it.each(DIALECTS)('reproduces the input exactly in %s', (dialect) => {
    for (const s of samples) lex(s, dialect);
  });

  it('uppercases word values and keeps the text', () => {
    const [w] = lex('selEct', 'postgres');
    expect(w).toMatchObject({ type: 'word', text: 'selEct', value: 'SELECT', start: 0, end: 6 });
  });

  it('groups whitespace runs, including Unicode spaces', () => {
    const tokens = lex('a \t\n  b', 'postgres');
    expect(tokens.map((t) => t.type)).toEqual(['word', 'whitespace', 'word']);
  });

  it('keeps non-ASCII letters, digits, _ and $ in identifiers', () => {
    expect(sig('SELECT café_1$x FROM t', 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['word', 'café_1$x'],
      ['word', 'FROM'],
      ['word', 't'],
    ]);
  });

  it('lexes numbers', () => {
    expect(sig('1 1.5 .5 1e10 1.5E-3 0x1F 0b101 0o17 10.', 'postgres').map(([type, text]) => `${type}:${text}`)).toEqual([
      'number:1',
      'number:1.5',
      'number:.5',
      'number:1e10',
      'number:1.5E-3',
      'number:0x1F',
      'number:0b101',
      'number:0o17',
      'number:10.',
    ]);
  });

  it('does not read `.5` after a name as a number', () => {
    expect(sig('t.5', 'postgres')).toEqual([
      ['word', 't'],
      ['punct', '.'],
      ['number', '5'],
    ]);
  });

  it('lexes punctuation', () => {
    expect(sig('( ) , . ; [ ]', 'postgres').map(([type]) => type)).toEqual(Array(7).fill('punct'));
  });

  it('lexes multi-character operators greedily', () => {
    expect(sig("a::int a->>'k' a->'k' a @> b a <@ b a || b a <= b a <> b a != b a >= b a #>> '{x}' a => b", 'postgres')
      .filter(([type]) => type === 'operator')
      .map(([, text]) => text)).toEqual(['::', '->>', '->', '@>', '<@', '||', '<=', '<>', '!=', '>=', '#>>', '=>']);
    expect(sig('a <=> b', 'mysql').filter(([type]) => type === 'operator').map(([, text]) => text)).toEqual(['<=>']);
  });
});

describe('tokenize: strings', () => {
  it('lexes single-quoted strings with doubled quotes in every dialect', () => {
    for (const d of DIALECTS) {
      expect(single("'it''s'", d)).toMatchObject({ type: 'string', text: "'it''s'", value: "'it''s'" });
    }
  });

  it('postgres: plain strings do not use backslash escapes (standard_conforming_strings)', () => {
    expect(sig("SELECT 'a\\' AS x", 'postgres')).toEqual([
      ['word', 'SELECT'],
      ['string', "'a\\'"],
      ['word', 'AS'],
      ['word', 'x'],
    ]);
  });

  it("postgres: E'...' strings use backslash escapes", () => {
    expect(single("E'a\\'b'", 'postgres').type).toBe('string');
    expect(single("e'a\\\\'", 'postgres').text).toBe("e'a\\\\'");
    // The same text has no backslash escapes in generic, so it ends early
    expect(sig("E'a\\'", 'generic')).toEqual([['string', "E'a\\'"]]);
  });

  it('postgres: dollar quoting with and without tags', () => {
    expect(single("$$it's; DROP TABLE x$$", 'postgres').type).toBe('string');
    expect(single('$fn$ a $$ b $fn$', 'postgres').text).toBe('$fn$ a $$ b $fn$');
    expect(sig("SELECT $$a$$ || $q$b$q$", 'postgres').map(([type]) => type)).toEqual(['word', 'string', 'operator', 'string']);
  });

  it('postgres: $1 is a param, not a dollar quote', () => {
    expect(sig('$1 + $23', 'postgres')).toEqual([
      ['param', '$1'],
      ['operator', '+'],
      ['param', '$23'],
    ]);
  });

  it("postgres: U&'...' strings and U&\"...\" identifiers", () => {
    expect(single("U&'d\\0061t'", 'postgres').type).toBe('string');
    expect(single('U&"d\\0061t"', 'postgres')).toMatchObject({ type: 'quoted', value: 'd\\0061t' });
  });

  it('mysql: single and double quotes are strings with backslash escapes', () => {
    expect(single("'it\\'s'", 'mysql').type).toBe('string');
    expect(single('"say \\"hi\\""', 'mysql').type).toBe('string');
    expect(single('"a""b"', 'mysql').type).toBe('string');
  });

  it('mysql: backslashEscapes false follows NO_BACKSLASH_ESCAPES', () => {
    const sql = "'a\\' OR 1 -- '";
    expect(sig(sql, 'mysql', false)).toEqual([
      ['string', "'a\\'"],
      ['word', 'OR'],
      ['number', '1'],
      ['comment', "-- '"],
    ]);
    expect(sig(sql, 'mysql', true)).toEqual([['string', sql]]);
    expect(lexError("'a\\' 'b'", 'mysql', true).kind).toBe('unterminated_string');
  });

  it('mysql: the two escape modes give different statement counts', () => {
    const sql = "SELECT 'a\\'; DROP TABLE x; -- '";
    const withEscapes = tokenize(sql, 'mysql', { backslashEscapes: true });
    const without = tokenize(sql, 'mysql', { backslashEscapes: false });
    expect(splitStatements(withEscapes)).toHaveLength(1);
    expect(splitStatements(without)).toHaveLength(2);
    expect(without.some((t) => t.type === 'comment')).toBe(true);
    expect(withEscapes.some((t) => t.type === 'comment')).toBe(false);
    // Default is backslash escapes on
    expect(splitStatements(tokenize(sql, 'mysql'))).toHaveLength(1);
  });

  it('backslashEscapes is ignored outside mysql', () => {
    expect(sig("'a\\' 'b'", 'postgres', true)).toEqual([
      ['string', "'a\\'"],
      ['string', "'b'"],
    ]);
  });

  it("N'...', X'...' and B'...' prefixes are part of the string token", () => {
    for (const d of DIALECTS) {
      expect(single("N'héllo'", d)).toMatchObject({ type: 'string', start: 0 });
      expect(single("x'0F'", d).type).toBe('string');
      expect(single("B'0101'", d).type).toBe('string');
    }
  });

  it('a prefix letter inside a word is not a prefix', () => {
    expect(sig("SELECTN'x'", 'mssql')).toEqual([
      ['word', 'SELECTN'],
      ['string', "'x'"],
    ]);
  });
});

describe('tokenize: quoted identifiers', () => {
  it('double quotes are identifiers everywhere except mysql', () => {
    for (const d of ['postgres', 'sqlite', 'mssql', 'generic'] as SqlDialect[]) {
      expect(single('"User"', d)).toMatchObject({ type: 'quoted', text: '"User"', value: 'User' });
      expect(single('"a""b"', d).value).toBe('a"b');
    }
    expect(single('"User"', 'mysql').type).toBe('string');
  });

  it('backticks are identifiers in mysql, sqlite and generic', () => {
    for (const d of ['mysql', 'sqlite', 'generic'] as SqlDialect[]) {
      expect(single('`order`', d)).toMatchObject({ type: 'quoted', value: 'order' });
      expect(single('`a``b`', d).value).toBe('a`b');
    }
    expect(sig('`x`', 'postgres').map(([type]) => type)).toEqual(['operator', 'word', 'operator']);
  });

  it('brackets are identifiers in mssql (with ]] escapes) and sqlite', () => {
    expect(single('[Order Details]', 'mssql')).toMatchObject({ type: 'quoted', value: 'Order Details' });
    expect(single('[weird]]name]', 'mssql').value).toBe('weird]name');
    expect(single('[orders]', 'sqlite').value).toBe('orders');
    // SQLite has no escape inside brackets: the first ] closes
    expect(sig('[a]]', 'sqlite')).toEqual([
      ['quoted', '[a]'],
      ['punct', ']'],
    ]);
  });

  it('brackets are punctuation in postgres, mysql and generic', () => {
    for (const d of ['postgres', 'mysql', 'generic'] as SqlDialect[]) {
      expect(sig('ARRAY[1]', d)).toEqual([
        ['word', 'ARRAY'],
        ['punct', '['],
        ['number', '1'],
        ['punct', ']'],
      ]);
    }
  });
});

describe('tokenize: comments', () => {
  it('-- comments run to the end of the line, without the newline', () => {
    for (const d of DIALECTS) {
      const tokens = lex('a -- x; DROP\nb', d);
      expect(tokens.map((t) => t.type)).toEqual(['word', 'whitespace', 'comment', 'whitespace', 'word']);
      expect(tokens[2].text).toBe('-- x; DROP');
    }
  });

  it('# is a comment in mysql and generic only', () => {
    expect(sig('a # b', 'mysql')).toEqual([
      ['word', 'a'],
      ['comment', '# b'],
    ]);
    expect(sig('a # b', 'generic')).toEqual([
      ['word', 'a'],
      ['comment', '# b'],
    ]);
    expect(sig('a # b', 'postgres')).toEqual([
      ['word', 'a'],
      ['operator', '#'],
      ['word', 'b'],
    ]);
    expect(sig('SELECT * FROM #temp, ##g', 'mssql')).toContainEqual(['word', '#temp']);
    expect(sig('SELECT * FROM #temp, ##g', 'mssql')).toContainEqual(['word', '##g']);
  });

  it('block comments nest in postgres and mssql', () => {
    for (const d of ['postgres', 'mssql'] as SqlDialect[]) {
      expect(sig('/* a /* b */ c */ x', d)).toEqual([
        ['comment', '/* a /* b */ c */'],
        ['word', 'x'],
      ]);
    }
  });

  it('block comments do not nest in mysql, sqlite and generic', () => {
    for (const d of ['mysql', 'sqlite', 'generic'] as SqlDialect[]) {
      expect(sig('/* a /* b */ c */', d)).toEqual([
        ['comment', '/* a /* b */'],
        ['word', 'c'],
        ['operator', '*'],
        ['operator', '/'],
      ]);
    }
  });

  it('mysql /*! ... */ is a comment token', () => {
    expect(sig('SELECT 1 /*! ; DROP TABLE x */', 'mysql')).toEqual([
      ['word', 'SELECT'],
      ['number', '1'],
      ['comment', '/*! ; DROP TABLE x */'],
    ]);
  });

  it('comment markers inside strings and identifiers are not comments', () => {
    expect(sig("'a--b' \"c/*d\" 'e#f'", 'postgres').map(([type]) => type)).toEqual(['string', 'quoted', 'string']);
  });
});

describe('tokenize: params', () => {
  it('lexes $n, ?, :name and @name', () => {
    expect(sig('$1 ? :name', 'postgres').map(([type]) => type)).toEqual(['param', 'param', 'param']);
    expect(sig('@email @@ROWCOUNT', 'mssql')).toEqual([
      ['param', '@email'],
      ['param', '@@ROWCOUNT'],
    ]);
    expect(sig('@v @@version', 'mysql')).toEqual([
      ['param', '@v'],
      ['param', '@@version'],
    ]);
    expect(sig('?1 :a @b $c', 'sqlite').map(([type]) => type)).toEqual(['param', 'param', 'param', 'param']);
  });

  it('postgres: @ is an operator, :: is a cast, ?| is an operator', () => {
    expect(sig('a @> b', 'postgres')).toContainEqual(['operator', '@>']);
    expect(sig('x::text', 'postgres')).toEqual([
      ['word', 'x'],
      ['operator', '::'],
      ['word', 'text'],
    ]);
    expect(sig("d ?| array['a']", 'postgres')).toContainEqual(['operator', '?|']);
  });
});

describe('tokenize: errors', () => {
  const cases: Array<[string, SqlDialect, string, number, string]> = [
    ["SELECT 'abc", 'postgres', 'unterminated_string', 7, "'"],
    ["SELECT E'a\\'", 'postgres', 'unterminated_string', 7, "'"],
    ['SELECT $$abc$', 'postgres', 'unterminated_string', 7, '$$'],
    ['SELECT $fn$abc$$', 'postgres', 'unterminated_string', 7, '$fn$'],
    ['SELECT "abc', 'mysql', 'unterminated_string', 7, '"'],
    ["SELECT N'abc", 'mssql', 'unterminated_string', 7, "'"],
    ['SELECT "abc', 'postgres', 'unterminated_quoted_identifier', 7, '"'],
    ['SELECT `abc', 'mysql', 'unterminated_quoted_identifier', 7, '`'],
    ['SELECT [abc', 'mssql', 'unterminated_quoted_identifier', 7, '['],
    ['SELECT [abc', 'sqlite', 'unterminated_quoted_identifier', 7, '['],
    ['SELECT 1 /* x', 'generic', 'unterminated_comment', 9, '/*'],
    ['SELECT 1 /* a /* b */', 'postgres', 'unterminated_comment', 9, '/*'],
  ];
  it.each(cases)('%s (%s) -> %s at %d', (sql, dialect, kind, position, delimiter) => {
    const err = lexError(sql, dialect);
    expect(err.kind).toBe(kind);
    expect(err.position).toBe(position);
    expect(err.delimiter).toBe(delimiter);
    expect(err.name).toBe('SqlLexError');
    expect(err.message).toContain(String(position));
  });

  it("mysql: 'a\\' is unterminated with backslash escapes and complete without", () => {
    expect(lexError("SELECT 'a\\'", 'mysql').kind).toBe('unterminated_string');
    expect(() => tokenize("SELECT 'a\\'", 'mysql', { backslashEscapes: false })).not.toThrow();
  });

  it('the same nested comment is complete in mysql', () => {
    expect(() => tokenize('SELECT 1 /* a /* b */', 'mysql')).not.toThrow();
  });
});

describe('tokenize: linear time on long inputs', () => {
  const MB = 1024 * 1024;
  const timed = (fn: () => void): number => {
    const t0 = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };

  it('lexes a 1 MB string literal quickly in every dialect', () => {
    const sql = "SELECT '" + 'x'.repeat(MB) + "' AS s";
    for (const d of DIALECTS) {
      let tokens: Token[] = [];
      const ms = timed(() => {
        tokens = tokenize(sql, d);
      });
      expect(tokens.filter((t) => t.type === 'string')).toHaveLength(1);
      expect(ms).toBeLessThan(500);
    }
  });

  it('handles long runs of escapes, comments, dollar quotes and failures quickly', () => {
    const inputs: Array<[string, SqlDialect]> = [
      ["'" + "''".repeat(MB / 2) + "'", 'postgres'],
      ["'" + '\\\''.repeat(MB / 2) + "'", 'mysql'],
      ['/*' + ' /*'.repeat(MB / 6) + ' */'.repeat(MB / 6) + '*/', 'postgres'],
      ['-- ' + 'x'.repeat(MB), 'generic'],
      ['$q$' + '$'.repeat(MB) + '$q$', 'postgres'],
      ['"' + 'a'.repeat(MB) + '"', 'postgres'],
    ];
    for (const [sql, d] of inputs) {
      expect(timed(() => tokenize(sql, d))).toBeLessThan(500);
    }
    // Unterminated input fails fast instead of backtracking
    expect(timed(() => expect(() => tokenize("'" + 'x'.repeat(MB), 'postgres')).toThrow(SqlLexError))).toBeLessThan(500);
    expect(timed(() => expect(() => tokenize('/*' + ' /*'.repeat(MB / 3), 'postgres')).toThrow(SqlLexError))).toBeLessThan(500);
  });
});
