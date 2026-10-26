/**
 * The research corpus and the security fixtures run through SecurityValidator
 * and QuerySanitizer: every valid query is accepted, every dangerous query is
 * rejected, in its own dialect.
 */

import { SecurityValidator } from '../../src/security/validator';
import { QuerySanitizer } from '../../src/security/sanitizer';
import { DatabaseType, QueryOperation, SecurityConfig } from '../../src/types';
import { tokenize } from '../../src/sql';
import {
  CORPUS_DIALECTS,
  ALL_DIALECTS,
  SecurityDialect,
  valid,
  validEdgeCases,
  dangerous,
  validLookalikes,
  dangerousCases,
  odbcEscapes,
} from '../fixtures/security-corpus';

const ALL_OPERATIONS: QueryOperation[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/**
 * Valid corpus queries the validator rejects by design:
 * - a bare VALUES list has no SELECT/INSERT/UPDATE/DELETE operation (0.0.1
 *   rejected it the same way: "Could not determine query operation");
 * - a MySQL string with `\'` ends somewhere else under NO_BACKSLASH_ESCAPES,
 *   where this one turns into a second statement (0.0.1 rejected it too, for
 *   the word DROP);
 * - TOP n PERCENT returns a share of the table, which maxRowLimit cannot cap.
 */
const REJECTED_BY_DESIGN = new Set([
  "VALUES (1, 'a'), (2, 'b')",
  "SELECT 'it\\'s; DROP TABLE x' AS s",
  'SELECT TOP 10 PERCENT id FROM orders ORDER BY total DESC',
]);

function validator(dialect: SecurityDialect, config: SecurityConfig = {}): SecurityValidator {
  const options = dialect === 'generic' ? {} : { databaseType: dialect as DatabaseType };
  return new SecurityValidator(
    { requireUserContext: false, allowUnion: true, allowedOperations: ALL_OPERATIONS, ...config },
    options
  );
}

function sanitizer(dialect: SecurityDialect): QuerySanitizer {
  return new QuerySanitizer(dialect === 'generic' ? undefined : (dialect as DatabaseType));
}

const rows = <T>(src: Record<string, T[]>, dialects: SecurityDialect[]): Array<[SecurityDialect, T]> =>
  dialects.flatMap((d) => (src[d] ?? []).map((q): [SecurityDialect, T] => [d, q]));

describe('valid queries are accepted', () => {
  const cases = rows(valid as Record<string, string[]>, CORPUS_DIALECTS)
    .concat(rows(validEdgeCases as Record<string, string[]>, CORPUS_DIALECTS))
    .concat(rows(validLookalikes, ALL_DIALECTS))
    .filter(([, sql]) => !REJECTED_BY_DESIGN.has(sql));

  it.each(cases)('[%s] %s', async (dialect, sql) => {
    const v = validator(dialect);
    // Through the pipeline (comments are removed by the sanitizer first)
    const sanitized = sanitizer(dialect).sanitize(sql);
    expect(sanitizer(dialect).validateSQLSyntax(sanitized)).toEqual({ valid: true });
    const result = await v.validate(sanitized);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    // And directly, unless the query has a comment (reported when given straight to validate())
    const lexDialect = dialect === 'generic' ? 'generic' : dialect;
    if (!tokenize(sql, lexDialect).some((t) => t.type === 'comment')) {
      expect((await v.validate(sql)).errors).toEqual([]);
    }
  });

  it('rejects the documented exceptions', async () => {
    expect((await validator('postgres').validate("VALUES (1, 'a'), (2, 'b')")).errors).toEqual([
      'Could not determine query operation',
    ]);
    expect((await validator('mysql').validate("SELECT 'it\\'s; DROP TABLE x' AS s")).errors).toEqual([
      'Query contains dangerous patterns: ambiguous string escaping',
    ]);
  });
});

describe('dangerous corpus queries are rejected (SELECT-only)', () => {
  it.each(rows(dangerous as Record<string, string[]>, CORPUS_DIALECTS))('[%s] %s', async (dialect, sql) => {
    const v = validator(dialect, { allowedOperations: ['SELECT'] });
    expect((await v.validate(sql)).valid).toBe(false);
    // Also after sanitizing, as the generator does
    expect((await v.validate(sanitizer(dialect).sanitize(sql))).valid).toBe(false);
  });

  it.each(rows(dangerous as Record<string, string[]>, CORPUS_DIALECTS))('[generic] %s (%s corpus)', async (_d, sql) => {
    const v = validator('generic', { allowedOperations: ['SELECT'] });
    expect((await v.validate(sql)).valid).toBe(false);
  });
});

describe('dangerous fixture queries are rejected with the expected message', () => {
  it.each(rows(dangerousCases, ALL_DIALECTS))('[%s] %j', async (dialect, [sql, fragment]) => {
    const result = await validator(dialect, { allowedOperations: ['SELECT'], allowUnion: false }).validate(sql);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' | ')).toContain(fragment);
  });
});

describe('ODBC escapes are rejected in every dialect', () => {
  const cases = ALL_DIALECTS.flatMap((d) => odbcEscapes.map(([form, sql]): [SecurityDialect, string, string] => [d, form, sql]));
  it.each(cases)('[%s] {%s ...}', async (dialect, _form, sql) => {
    const result = await validator(dialect).validate(sql);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' | ')).toContain('ODBC escape');
  });

  it('does not reject braces inside strings', async () => {
    for (const d of ALL_DIALECTS) {
      expect((await validator(d).validate("SELECT id FROM t WHERE tags = '{a,b}' AND doc = '{\"x\": 1}'")).valid).toBe(true);
    }
  });
});
