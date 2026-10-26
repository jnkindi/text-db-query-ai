/**
 * Regressions found while building the security validator on the analyzer.
 */

import { analyzeSql } from '../../src/sql/analyze';

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
