/**
 * Zero-dependency, dialect-aware SQL lexer and token-based analysis shared by
 * the validator, sanitizer, row-level security and identifier checks.
 */
export type { SqlDialect, TokenType, Token, SqlLexErrorKind, LexOptions } from './lexer';
export { SqlLexError, toSqlDialect, tokenize } from './lexer';

export type { TableReference, ColumnReference, NestedStatement, SqlAnalysis } from './analyze';
export { analyzeSql, significantTokens, splitStatements, findTopLevel } from './analyze';

export {
  SQL_KEYWORDS,
  RESERVED_KEYWORDS,
  STATEMENT_KEYWORDS,
  DEFAULT_BLOCKED_FUNCTIONS,
  isBlockedFunction,
  isReservedKeyword,
} from './keywords';

export { formatIdentifier, needsQuoting, quoteIdentifier } from './identifiers';

export type { SqlReading } from './readings';
export { sqlReadings } from './readings';
