/**
 * sqlReadings() lists every way a database may read the text. Each query here
 * hides a table or a statement from at least one reading, and must expose it
 * in another, so checks that run over all readings cannot be bypassed.
 */
import { analyzeSql, sqlReadings, SqlLexError } from '../../src/sql';
import type { SqlAnalysis } from '../../src/sql';

/** Analysis per reading; a reading that cannot lex the text yields null. */
function analyses(sql: string): Array<SqlAnalysis | null> {
  return sqlReadings('generic').map((r) => {
    try {
      return analyzeSql(sql, r.dialect, r.options);
    } catch (e) {
      if (e instanceof SqlLexError) return null;
      throw e;
    }
  });
}

const exposes = (sql: string, table: string) =>
  analyses(sql).some((a) => a !== null && a.tables.some((t) => t.name.toLowerCase() === table));
const splits = (sql: string) => analyses(sql).some((a) => a === null || a.statements.length > 1);

describe('sqlReadings', () => {
  it('lists every concrete reading for generic and both backslash modes for mysql', () => {
    expect(sqlReadings('generic').map((r) => `${r.dialect}:${r.options.backslashEscapes ?? '-'}`)).toEqual([
      'postgres:-',
      'mysql:true',
      'mysql:false',
      'sqlite:-',
      'mssql:-',
    ]);
    expect(sqlReadings('mysql').map((r) => r.options.backslashEscapes)).toEqual([true, false]);
    expect(sqlReadings('mysql', { backslashEscapes: false }).map((r) => r.options.backslashEscapes)).toEqual([false]);
    expect(sqlReadings('postgres')).toEqual([{ dialect: 'postgres', options: {} }]);
    expect(sqlReadings('sqlite')).toEqual([{ dialect: 'sqlite', options: {} }]);
    expect(sqlReadings('mssql')).toEqual([{ dialect: 'mssql', options: {} }]);
  });

  it('exposes a statement hidden behind -- in MySQL', () => {
    expect(splits("SELECT 1 --'\n; DROP TABLE users; --'")).toBe(true);
  });

  it('exposes a subquery after # (a comment in MySQL, an operator in Postgres)', () => {
    expect(exposes('SELECT 1 # (SELECT count(*) FROM secrets)', 'secrets')).toBe(true);
  });

  it('exposes a subquery between T-SQL bracket identifiers holding quotes', () => {
    expect(exposes("SELECT [a'] , (SELECT password FROM users) , ['] FROM t", 'users')).toBe(true);
  });

  it('exposes a subquery between Postgres dollar-quoted strings', () => {
    expect(exposes("SELECT $$'$$ , (SELECT password FROM users) , $$'$$", 'users')).toBe(true);
  });

  it('exposes a subquery that only MySQL backslash escapes reveal', () => {
    expect(exposes("SELECT '\\' , 1 , ' , (SELECT password FROM users) , 'x'", 'users')).toBe(true);
  });

  it('exposes a subquery inside a nested block comment', () => {
    expect(splits("SELECT 1 /* /* */ ' */ ; DROP TABLE t; -- '")).toBe(true);
  });

  it('lets an ordinary query through every reading unchanged', () => {
    const all = analyses("SELECT u.id, u.name FROM users u WHERE u.created_at > '2024-01-01' LIMIT 10");
    expect(all.every((a) => a !== null && a.statements.length === 1)).toBe(true);
    expect(all.every((a) => a!.tables.map((t) => t.name).join() === 'users')).toBe(true);
  });
});
