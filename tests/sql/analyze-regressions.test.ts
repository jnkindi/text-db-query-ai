/**
 * Regressions found while building the security validator on the analyzer.
 */

import { analyzeSql } from '../../src/sql/analyze';
import type { SqlDialect } from '../../src/sql';

describe('nested statements', () => {
  it('a T-SQL MERGE join hint is not a nested MERGE statement', () => {
    expect(analyzeSql('SELECT id FROM t OPTION (MERGE JOIN, HASH JOIN)', 'mssql').nestedStatements).toEqual([]);
    expect(analyzeSql('SELECT id FROM t OPTION (HASH JOIN, MERGE JOIN)', 'mssql').nestedStatements).toEqual([]);
  });

  it('a MERGE statement in parentheses still is', () => {
    const a = analyzeSql('WITH x AS (MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE) SELECT 1', 'postgres');
    expect(a.nestedStatements.map((s) => s.keyword)).toEqual(['MERGE']);
  });
});

// Index hints, FOR XML/JSON options, T-SQL `alias =` items, PIVOT lists, MEMBER OF
// and OUTPUT are read as syntax so the identifier check does not report them. The
// validator reads tables and function calls from the same analysis, so those must
// not change.
describe('hints and dialect clauses keep tables and calls', () => {
  const tables = (sql: string, dialect: SqlDialect) => analyzeSql(sql, dialect).tables.map((t) => t.name);
  const bare = (sql: string, dialect: SqlDialect) =>
    analyzeSql(sql, dialect)
      .columns.filter((c) => c.qualifier === undefined)
      .map((c) => c.name);
  const functions = (sql: string, dialect: SqlDialect) => analyzeSql(sql, dialect).functions;

  it('MySQL index hints are not tables or columns, and the tables around them stay', () => {
    expect(tables('SELECT o.id FROM orders o USE INDEX FOR JOIN (idx_user) JOIN users u ON u.id = o.user_id', 'mysql')).toEqual([
      'orders',
      'users',
    ]);
    expect(tables('SELECT id FROM a USE INDEX (i), IGNORE INDEX (j), b FORCE KEY (k) WHERE x = 1', 'mysql')).toEqual(['a', 'b']);
    expect(bare('SELECT id FROM a USE INDEX (i) WHERE x = 1', 'mysql')).toEqual(['id', 'x']);
  });

  it('T-SQL and SQLite index hints are not columns', () => {
    expect(bare('SELECT id FROM a WITH (NOLOCK, INDEX(ix), INDEX = iy, FORCESEEK (iz (c))) WHERE x = 1', 'mssql')).toEqual(['id', 'x']);
    expect(bare('SELECT id FROM a (INDEX(ix)) WHERE x = 1', 'mssql')).toEqual(['id', 'x']);
    expect(bare('SELECT id FROM a INDEXED BY ix WHERE x = 1', 'sqlite')).toEqual(['id', 'x']);
    expect(tables('SELECT id FROM a WITH (INDEX(ix)) JOIN b ON b.id = a.id', 'mssql')).toEqual(['a', 'b']);
  });

  it('calls stay visible inside hints, type lengths and FOR XML options', () => {
    expect(functions('SELECT CAST(pg_sleep(1) AS NVARCHAR(MAX)) FROM t', 'mssql')).toEqual(['CAST', 'PG_SLEEP']);
    expect(functions('SELECT id FROM t WITH (INDEX(xp_cmdshell(1)))', 'mssql')).toContain('XP_CMDSHELL');
    expect(functions('SELECT id FROM t USE INDEX (sleep(1))', 'mysql')).toContain('SLEEP');
    expect(functions("SELECT id FROM t FOR XML PATH(''), ROOT('r')", 'mssql')).toEqual([]);
  });

  it('`alias = expr` names a select item only on SQL Server', () => {
    expect(analyzeSql('SELECT total_sales = SUM(total) FROM orders', 'mssql').aliases).toContain('total_sales');
    expect(bare('SELECT total_sales = SUM(total) FROM orders', 'mssql')).toEqual(['total']);
    expect(bare('SELECT total_sales = SUM(total) FROM orders', 'postgres')).toEqual(['total_sales', 'total']);
    expect(bare("SELECT a FROM t WHERE b = 'x'", 'mssql')).toEqual(['a', 'b']);
  });

  it('PIVOT output columns and UNPIVOT new columns are aliases', () => {
    const pivot = analyzeSql('SELECT * FROM s PIVOT (SUM(v) FOR k IN ([a], [b])) AS p', 'mssql');
    expect(pivot.aliases).toEqual(expect.arrayContaining(['a', 'b', 'p']));
    expect(pivot.columns.map((c) => c.name)).toEqual(['v', 'k']);
    const unpivot = analyzeSql('SELECT * FROM s UNPIVOT (v FOR k IN (c1, c2)) u', 'mssql');
    expect(unpivot.aliases).toEqual(expect.arrayContaining(['v', 'k', 'u']));
    expect(unpivot.columns.map((c) => c.name)).toEqual(['c1', 'c2']);
  });

  it('MEMBER OF and OUTPUT are syntax only where the dialect has them', () => {
    expect(bare('SELECT id FROM t WHERE 5 MEMBER OF (tags)', 'mysql')).toEqual(['id', 'tags']);
    expect(bare('SELECT id FROM t WHERE 5 MEMBER OF (tags)', 'postgres')).toEqual(['id', 'MEMBER', 'tags']);
    expect(bare('UPDATE t SET a = 1 OUTPUT inserted.id', 'mssql')).toEqual(['a']);
    expect(bare('UPDATE t SET a = output', 'mssql')).toEqual(['a', 'output']);
  });
});
