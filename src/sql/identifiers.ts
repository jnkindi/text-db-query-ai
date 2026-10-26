import type { SqlDialect } from './lexer';
import { isReservedKeyword } from './keywords';

// Postgres folds unquoted names to lowercase, so a plain name must already be lowercase.
const PLAIN_POSTGRES = /^[a-z_][a-z0-9_$]*$/;
const PLAIN_DOLLAR = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const PLAIN_ANSI = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether `name` must be quoted to be used as an identifier in `dialect`:
 * it is reserved there, or it is not a plain identifier (letters, digits,
 * underscore; `$` after the first character except in `generic`). In Postgres
 * any uppercase letter also needs quoting, because unquoted names fold to
 * lowercase.
 */
export function needsQuoting(name: string, dialect: SqlDialect): boolean {
  if (name.length === 0) return true;
  const plain =
    dialect === 'postgres' ? PLAIN_POSTGRES : dialect === 'generic' ? PLAIN_ANSI : PLAIN_DOLLAR;
  if (!plain.test(name)) return true;
  return isReservedKeyword(name, dialect);
}

/**
 * Quote an identifier for `dialect`: `"x"` for postgres, sqlite and generic,
 * backticks for mysql and `[x]` for mssql. The closing quote character inside
 * the name is doubled.
 */
export function quoteIdentifier(name: string, dialect: SqlDialect): string {
  switch (dialect) {
    case 'mysql':
      return '`' + name.replace(/`/g, '``') + '`';
    case 'mssql':
      return '[' + name.replace(/]/g, ']]') + ']';
    default:
      return '"' + name.replace(/"/g, '""') + '"';
  }
}
