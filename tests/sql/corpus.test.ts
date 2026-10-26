/**
 * The research-harness corpus run through the analyzer: every valid query is
 * analyzed as one read statement, and every dangerous query exposes at least
 * one signal a validator can reject on.
 */

import { valid, validEdgeCases, dangerous, CorpusDialect } from '../fixtures/sql-corpus';
import { analyzeSql, SqlAnalysis } from '../../src/sql/analyze';
import { isBlockedFunction } from '../../src/sql/keywords';
import { SqlLexError } from '../../src/sql/lexer';

const DIALECTS: CorpusDialect[] = ['postgres', 'mysql', 'sqlite', 'mssql'];

const rows = (src: Record<CorpusDialect, string[]>): Array<[CorpusDialect, string]> =>
  DIALECTS.flatMap((d) => src[d].map((q): [CorpusDialect, string] => [d, q]));

/**
 * Statements that are valid reads but have no SELECT/INSERT/UPDATE/DELETE
 * operation: a bare VALUES list (and `TABLE t`, which the corpus does not
 * contain). The validator rejects these as "Could not determine query
 * operation", exactly like 0.0.1 did.
 */
const NULL_OPERATION = new Set(["VALUES (1, 'a'), (2, 'b')"]);

describe('corpus sizes', () => {
  it('matches the research harness (159 valid, 39 dangerous)', () => {
    expect(rows(valid)).toHaveLength(159);
    expect(rows(dangerous)).toHaveLength(39);
    expect(rows(validEdgeCases)).toHaveLength(11);
  });
});

describe('valid corpus', () => {
  it.each(rows(valid).concat(rows(validEdgeCases)))('[%s] %s', (dialect, sql) => {
    const a = analyzeSql(sql, dialect);
    expect(a.statements).toHaveLength(1);
    if (NULL_OPERATION.has(sql)) expect(a.operation).toBeNull();
    else expect(a.operation).toBe('SELECT');
    expect(a.nestedStatements).toEqual([]);
    expect(a.functions.filter((f) => isBlockedFunction(f))).toEqual([]);
    // Every table name is a real token of the query, never a keyword fragment of a name
    for (const t of a.tables) expect(sql.slice(t.start, t.end)).toContain(t.name);
  });
});

/** What a token-based validator can reject a query on. */
function signals(a: SqlAnalysis): string[] {
  const out: string[] = [];
  if (a.statements.length > 1) out.push('multiple statements');
  if (a.operation !== 'SELECT') out.push(`operation ${a.operation}`);
  for (const s of a.nestedStatements) out.push(`statement ${s.keyword}`);
  if (a.hasComments) out.push('comment');
  for (const f of a.functions) if (isBlockedFunction(f)) out.push(`function ${f}`);
  const first = a.statements[0] ?? [];
  for (let i = 0; i < first.length; i++) {
    const t = first[i];
    if (t.type !== 'word') continue;
    if (t.value === 'INTO') out.push('INTO');
    const next = first[i + 1];
    if (t.value === 'FOR' && next && next.type === 'word' && ['UPDATE', 'SHARE', 'NO', 'KEY'].includes(next.value)) out.push('locking clause');
  }
  return out;
}

function dangerSignals(dialect: CorpusDialect, sql: string): string[] {
  const modes = dialect === 'mysql' ? [true, false] : [true];
  const found: string[] = [];
  for (const backslashEscapes of modes) {
    try {
      found.push(...signals(analyzeSql(sql, dialect, { backslashEscapes })));
    } catch (e) {
      expect(e).toBeInstanceOf(SqlLexError);
      found.push('lex error');
    }
  }
  return found;
}

describe('dangerous corpus', () => {
  it.each(rows(dangerous))('[%s] %s', (dialect, sql) => {
    expect(dangerSignals(dialect, sql).length).toBeGreaterThan(0);
  });

  it('exposes the expected signal for representative queries', () => {
    expect(dangerSignals('postgres', 'SELECT 1; DELETE FROM users;')).toContain('multiple statements');
    expect(dangerSignals('postgres', 'WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d')).toContain('statement DELETE');
    expect(dangerSignals('postgres', 'SELECT * INTO backup_users FROM users')).toContain('INTO');
    expect(dangerSignals('postgres', 'SELECT * FROM users FOR NO KEY UPDATE')).toContain('locking clause');
    expect(dangerSignals('postgres', 'SELECT pg_sleep(100)')).toContain('function PG_SLEEP');
    expect(dangerSignals('postgres', "SELECT * FROM dblink('host=x', 'DELETE FROM t') AS t(a int)")).toContain('function DBLINK');
    expect(dangerSignals('postgres', 'SELECT 1 /* nested /* c */ */; DROP TABLE x')).toEqual(expect.arrayContaining(['multiple statements', 'comment']));
    expect(dangerSignals('postgres', "DO $$ BEGIN DELETE FROM users; END $$")).toContain('operation null');
    expect(dangerSignals('mysql', "SELECT * FROM users INTO OUTFILE '/tmp/x'")).toContain('INTO');
    expect(dangerSignals('mysql', "SELECT 'a\\'; DROP TABLE x; -- '")).toEqual(expect.arrayContaining(['multiple statements', 'comment']));
    expect(dangerSignals('sqlite', "SELECT load_extension('/tmp/evil.so')")).toContain('function LOAD_EXTENSION');
    expect(dangerSignals('mssql', "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;', 'SELECT 1')")).toContain('function OPENROWSET');
    expect(dangerSignals('mssql', "EXEC xp_cmdshell 'dir'")).toContain('operation null');
  });

  it('the MySQL escaping ambiguity is only visible when both modes are lexed', () => {
    const sql = "SELECT 'a\\'; DROP TABLE x; -- '";
    expect(signals(analyzeSql(sql, 'mysql'))).toEqual([]);
    expect(signals(analyzeSql(sql, 'mysql', { backslashEscapes: false }))).toEqual(['multiple statements', 'comment']);
  });
});
