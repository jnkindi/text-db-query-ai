import type { LexOptions, SqlDialect } from './lexer';

/** One way a database server may read a query: a concrete dialect and its lexer options. */
export interface SqlReading {
  dialect: Exclude<SqlDialect, 'generic'>;
  options: LexOptions;
}

const GENERIC_READINGS: readonly SqlReading[] = Object.freeze([
  { dialect: 'postgres', options: {} },
  { dialect: 'mysql', options: { backslashEscapes: true } },
  { dialect: 'mysql', options: { backslashEscapes: false } },
  { dialect: 'sqlite', options: {} },
  { dialect: 'mssql', options: {} },
] as SqlReading[]);

/**
 * Every reading a security check has to pass for `dialect`.
 *
 * A single pass cannot be right for text that databases read differently:
 * `#`, `--x`, `[a']`, `$$'$$`, backslashes and nested comments each hide code
 * from some reading. So generic returns one reading per supported database,
 * and mysql returns both backslash modes unless `options.backslashEscapes`
 * says which one the server uses. A check is sound when it rejects the query
 * if any reading fails to lex or fails the check.
 *
 * @param dialect - Dialect the caller was configured with
 * @param options - Lexer options; `backslashEscapes` narrows mysql to one mode
 */
export function sqlReadings(dialect: SqlDialect, options: LexOptions = {}): SqlReading[] {
  if (dialect === 'generic') return GENERIC_READINGS.map((r) => ({ dialect: r.dialect, options: { ...r.options } }));
  if (dialect === 'mysql' && options.backslashEscapes === undefined) {
    return [
      { dialect, options: { ...options, backslashEscapes: true } },
      { dialect, options: { ...options, backslashEscapes: false } },
    ];
  }
  return [{ dialect, options: { ...options } }];
}
