import type { DatabaseType } from '../types';

/**
 * SQL dialects understood by the lexer and analyzer.
 *
 * `generic` is used when the database type is unknown. It is deliberately
 * conservative: where dialects disagree on how a character sequence is read,
 * it picks the reading that exposes more structure (for example `#` starts a
 * comment and backslashes never escape quotes), so ambiguous input is rejected
 * by the validator instead of being misread.
 */
export type SqlDialect = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'generic';

/**
 * Map a configured database type to a lexer dialect.
 * `mongodb` and `undefined` map to `generic`.
 */
export function toSqlDialect(t?: DatabaseType): SqlDialect {
  switch (t) {
    case 'postgres':
    case 'mysql':
    case 'sqlite':
    case 'mssql':
      return t;
    default:
      return 'generic';
  }
}

export type TokenType =
  | 'word'
  | 'quoted'
  | 'string'
  | 'number'
  | 'param'
  | 'operator'
  | 'punct'
  | 'comment'
  | 'whitespace';

export interface Token {
  type: TokenType;
  /** Exact source slice. */
  text: string;
  /** word: UPPERCASED; quoted: unescaped identifier name (case kept); otherwise the same as `text`. */
  value: string;
  /** Offset in the source, inclusive. */
  start: number;
  /** Offset in the source, exclusive. */
  end: number;
}

export type SqlLexErrorKind =
  | 'unterminated_string'
  | 'unterminated_quoted_identifier'
  | 'unterminated_comment';

/**
 * Thrown by `tokenize()` when a string, quoted identifier or block comment is
 * never closed.
 */
export class SqlLexError extends Error {
  readonly kind: SqlLexErrorKind;
  /** Offset of the start of the unterminated token (including any prefix such as `E` or `N`). */
  readonly position: number;
  /** The opening delimiter: `'`, `"`, a backtick, `[`, `/*` or a dollar-quote tag such as `$fn$`. */
  readonly delimiter: string;

  constructor(kind: SqlLexErrorKind, position: number, delimiter: string) {
    const what =
      kind === 'unterminated_string'
        ? 'string literal'
        : kind === 'unterminated_quoted_identifier'
          ? 'quoted identifier'
          : 'block comment';
    super(`Unterminated ${what} starting at position ${position}`);
    this.name = 'SqlLexError';
    this.kind = kind;
    this.position = position;
    this.delimiter = delimiter;
    Object.setPrototypeOf(this, SqlLexError.prototype);
  }
}

export interface LexOptions {
  /**
   * MySQL only: whether backslash escapes quotes inside `'...'` and `"..."`
   * strings. Default true (MySQL's default; false matches the
   * NO_BACKSLASH_ESCAPES SQL mode). Ignored for other dialects.
   */
  backslashEscapes?: boolean;
}

// Character codes used by the scanner.
const C_TAB = 9;
const C_LF = 10;
const C_CR = 13;
const C_SPACE = 32;
const C_DQUOTE = 34;
const C_HASH = 35;
const C_DOLLAR = 36;
const C_SQUOTE = 39;
const C_LPAREN = 40;
const C_RPAREN = 41;
const C_STAR = 42;
const C_PLUS = 43;
const C_COMMA = 44;
const C_MINUS = 45;
const C_DOT = 46;
const C_SLASH = 47;
const C_0 = 48;
const C_1 = 49;
const C_7 = 55;
const C_9 = 57;
const C_COLON = 58;
const C_SEMI = 59;
const C_QUESTION = 63;
const C_AT = 64;
const C_LBRACKET = 91;
const C_BACKSLASH = 92;
const C_RBRACKET = 93;
const C_UNDERSCORE = 95;
const C_BACKTICK = 96;
const C_AMP = 38;
const C_PIPE = 124;

function isWhitespace(c: number): boolean {
  if (c === C_SPACE || (c >= C_TAB && c <= C_CR)) return true;
  if (c < 0x80) return false;
  // Unicode spaces are treated as whitespace so that no engine can see more
  // tokens than we do.
  return (
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

function isDigit(c: number): boolean {
  return c >= C_0 && c <= C_9;
}

function isHexDigit(c: number): boolean {
  return isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// ASCII character classes, precomputed so the hot loops do one table lookup.
const CC_IDENT_START = 1;
const CC_IDENT_PART = 2;
const ASCII_CLASS = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  let k = 0;
  if (isAsciiLetter(c) || c === C_UNDERSCORE) k |= CC_IDENT_START | CC_IDENT_PART;
  if (isDigit(c) || c === C_DOLLAR) k |= CC_IDENT_PART;
  ASCII_CLASS[c] = k;
}

/** First character of an unquoted identifier (dialect-independent part). */
function isIdentStart(c: number): boolean {
  return c < 0x80 ? (ASCII_CLASS[c] & CC_IDENT_START) !== 0 : !isWhitespace(c);
}

/** Following characters of an unquoted identifier (dialect-independent part). */
function isIdentPart(c: number): boolean {
  return c < 0x80 ? (ASCII_CLASS[c] & CC_IDENT_PART) !== 0 : !isWhitespace(c);
}

// Multi-character operators, matched greedily (longest first). None of them
// contains `--` or `/*`, so they can never swallow the start of a comment.
const OPERATORS_4 = new Set(['!~~*']);
const OPERATORS_3 = new Set(['->>', '#>>', '<=>', '!~*', '~~*', '!~~', '<->', '||/', '<<=', '>>=']);
const OPERATORS_2 = new Set([
  '::', '->', '#>', '#-', '@>', '<@', '||', '<=', '>=', '<>', '!=', '==', '<<', '>>',
  '&&', '!~', '~*', '~~', '?|', '?&', ':=', '=>', '**', '|/', '!!', '@@', '@?', '^@',
  '&<', '&>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '!<', '!>',
]);

/**
 * Split SQL into tokens. Every character of the input belongs to exactly one
 * token, so concatenating the `text` of all tokens reproduces the input.
 *
 * @param sql - SQL text
 * @param dialect - Dialect whose quoting and comment rules apply. Default `generic`.
 * @param options - Lexer options (MySQL backslash escapes)
 * @throws SqlLexError on an unterminated string, quoted identifier or block comment
 */
export function tokenize(sql: string, dialect: SqlDialect = 'generic', options: LexOptions = {}): Token[] {
  const tokens: Token[] = [];
  const n = sql.length;
  const isPg = dialect === 'postgres';
  const isMysql = dialect === 'mysql';
  const isMssql = dialect === 'mssql';
  const isSqlite = dialect === 'sqlite';
  const mysqlBackslash = isMysql && options.backslashEscapes !== false;
  // `#` starts a comment in MySQL; generic follows MySQL so that nothing a
  // MySQL server would ignore is analyzed as code.
  const hashComment = isMysql || dialect === 'generic';
  const nestedComments = isPg || isMssql;
  const backtickIdent = isMysql || isSqlite || dialect === 'generic';
  const bracketIdent = isMssql || isSqlite;
  const doubleQuoteIsString = isMysql;

  let i = 0;

  const push = (type: TokenType, start: number, end: number, value?: string): void => {
    const text = sql.slice(start, end);
    tokens.push({ type, text, value: value === undefined ? text : value, start, end });
  };

  const pushWord = (start: number, end: number): void => {
    const text = sql.slice(start, end);
    tokens.push({ type: 'word', text, value: text.toUpperCase(), start, end });
  };

  /** Scan a quoted run starting at `open` (the quote char); returns the index after the closing quote. */
  const scanQuoted = (open: number, quote: number, backslash: boolean): number => {
    let j = open + 1;
    if (backslash) {
      while (j < n) {
        const c = sql.charCodeAt(j);
        if (c === C_BACKSLASH) {
          j += 2;
          continue;
        }
        if (c === quote) {
          if (j + 1 < n && sql.charCodeAt(j + 1) === quote) {
            j += 2;
            continue;
          }
          return j + 1;
        }
        j++;
      }
      return -1;
    }
    const q = String.fromCharCode(quote);
    for (;;) {
      const k = sql.indexOf(q, j);
      if (k < 0) return -1;
      if (k + 1 < n && sql.charCodeAt(k + 1) === quote) {
        j = k + 2;
        continue;
      }
      return k + 1;
    }
  };

  /** Lex a string literal whose body starts at `quotePos`; `start` includes any prefix. */
  const lexString = (start: number, quotePos: number, quote: number, backslash: boolean): void => {
    const end = scanQuoted(quotePos, quote, backslash);
    if (end < 0) throw new SqlLexError('unterminated_string', start, String.fromCharCode(quote));
    push('string', start, end);
    i = end;
  };

  /** Lex a quoted identifier with doubled-closer escapes (or none, for SQLite brackets). */
  const lexQuotedIdent = (start: number, bodyStart: number, close: number, escapes: boolean): void => {
    const closeCh = String.fromCharCode(close);
    let j = bodyStart;
    let escaped = false;
    let end = -1;
    for (;;) {
      const k = sql.indexOf(closeCh, j);
      if (k < 0) break;
      if (escapes && k + 1 < n && sql.charCodeAt(k + 1) === close) {
        escaped = true;
        j = k + 2;
        continue;
      }
      end = k + 1;
      break;
    }
    if (end < 0) {
      throw new SqlLexError('unterminated_quoted_identifier', start, sql.slice(start, bodyStart));
    }
    let value = sql.slice(bodyStart, end - 1);
    if (escaped) value = value.split(closeCh + closeCh).join(closeCh);
    push('quoted', start, end, value);
    i = end;
  };

  while (i < n) {
    const start = i;
    const c = sql.charCodeAt(i);
    const c1 = i + 1 < n ? sql.charCodeAt(i + 1) : -1;

    // Whitespace runs
    if (isWhitespace(c)) {
      i++;
      while (i < n && isWhitespace(sql.charCodeAt(i))) i++;
      push('whitespace', start, i);
      continue;
    }

    // Unquoted identifiers and keywords, and the prefixed strings that start with a letter:
    // N'..', X'..', B'..' everywhere; E'..' in Postgres (backslash escapes) and generic
    // (no backslash escapes); U&'..' / U&".." in Postgres.
    if (isIdentStart(c)) {
      const lower = c | 0x20;
      if (c1 === C_SQUOTE) {
        if (lower === 110 /* n */ || lower === 120 /* x */ || lower === 98 /* b */) {
          lexString(start, i + 1, C_SQUOTE, mysqlBackslash);
          continue;
        }
        if (lower === 101 /* e */ && (isPg || dialect === 'generic')) {
          lexString(start, i + 1, C_SQUOTE, isPg);
          continue;
        }
      } else if (isPg && lower === 117 /* u */ && c1 === C_AMP && i + 2 < n) {
        const c2 = sql.charCodeAt(i + 2);
        if (c2 === C_SQUOTE) {
          lexString(start, i + 2, C_SQUOTE, false);
          continue;
        }
        if (c2 === C_DQUOTE) {
          lexQuotedIdent(start, i + 3, C_DQUOTE, true);
          continue;
        }
      }
      i++;
      if (isMssql) {
        while (i < n) {
          const d = sql.charCodeAt(i);
          if (!(isIdentPart(d) || d === C_HASH || d === C_AT)) break;
          i++;
        }
      } else {
        while (i < n && isIdentPart(sql.charCodeAt(i))) i++;
      }
      pushWord(start, i);
      continue;
    }

    // Line comments: `--` everywhere, `#` in MySQL (and generic)
    if ((c === C_MINUS && c1 === C_MINUS) || (c === C_HASH && hashComment)) {
      i += c === C_HASH ? 1 : 2;
      while (i < n) {
        const d = sql.charCodeAt(i);
        if (d === C_LF || d === C_CR) break;
        i++;
      }
      push('comment', start, i);
      continue;
    }

    // Block comments (nested in Postgres and T-SQL). MySQL `/*! ... */` is a comment token too.
    if (c === C_SLASH && c1 === C_STAR) {
      if (nestedComments) {
        let depth = 1;
        let j = i + 2;
        while (j < n && depth > 0) {
          const d = sql.charCodeAt(j);
          if (d === C_SLASH && j + 1 < n && sql.charCodeAt(j + 1) === C_STAR) {
            depth++;
            j += 2;
          } else if (d === C_STAR && j + 1 < n && sql.charCodeAt(j + 1) === C_SLASH) {
            depth--;
            j += 2;
          } else {
            j++;
          }
        }
        if (depth > 0) throw new SqlLexError('unterminated_comment', start, '/*');
        i = j;
      } else {
        const k = sql.indexOf('*/', i + 2);
        if (k < 0) throw new SqlLexError('unterminated_comment', start, '/*');
        i = k + 2;
      }
      push('comment', start, i);
      continue;
    }

    // Plain strings
    if (c === C_SQUOTE) {
      lexString(start, i, C_SQUOTE, mysqlBackslash);
      continue;
    }
    if (c === C_DQUOTE) {
      if (doubleQuoteIsString) lexString(start, i, C_DQUOTE, mysqlBackslash);
      else lexQuotedIdent(start, i + 1, C_DQUOTE, true);
      continue;
    }

    // Quoted identifiers
    if (c === C_BACKTICK && backtickIdent) {
      lexQuotedIdent(start, i + 1, C_BACKTICK, true);
      continue;
    }
    if (c === C_LBRACKET && bracketIdent) {
      lexQuotedIdent(start, i + 1, C_RBRACKET, isMssql);
      continue;
    }

    // `$`: Postgres params and dollar quoting; `$1` params elsewhere; MySQL identifiers
    if (c === C_DOLLAR) {
      if (isDigit(c1)) {
        i += 2;
        while (i < n && isDigit(sql.charCodeAt(i))) i++;
        push('param', start, i);
        continue;
      }
      if (isPg) {
        let j = i + 1;
        if (j < n && isIdentStart(sql.charCodeAt(j))) {
          j++;
          while (j < n) {
            const d = sql.charCodeAt(j);
            if (!(isIdentStart(d) || isDigit(d))) break;
            j++;
          }
        }
        if (j < n && sql.charCodeAt(j) === C_DOLLAR) {
          const tag = sql.slice(i, j + 1);
          const close = sql.indexOf(tag, j + 1);
          if (close < 0) throw new SqlLexError('unterminated_string', start, tag);
          i = close + tag.length;
          push('string', start, i);
          continue;
        }
      } else if (isSqlite && isIdentStart(c1)) {
        i += 2;
        while (i < n && isIdentPart(sql.charCodeAt(i))) i++;
        push('param', start, i);
        continue;
      } else if (isMysql && (isIdentPart(c1) || c1 === C_DOLLAR)) {
        i++;
        while (i < n && isIdentPart(sql.charCodeAt(i))) i++;
        pushWord(start, i);
        continue;
      }
    }

    // T-SQL temp tables (#t, ##t) are identifiers
    if (c === C_HASH && isMssql) {
      i++;
      while (i < n && (isIdentPart(sql.charCodeAt(i)) || sql.charCodeAt(i) === C_HASH)) i++;
      pushWord(start, i);
      continue;
    }

    // Numbers: 12, 1.5, .5, 1e-3, 0x1F, 0b101, 0o17
    if (isDigit(c) || (c === C_DOT && isDigit(c1) && !followsName(tokens, start))) {
      if (c === C_0 && (c1 | 0x20) === 120 /* x */ && i + 2 < n && isHexDigit(sql.charCodeAt(i + 2))) {
        i += 3;
        while (i < n && isHexDigit(sql.charCodeAt(i))) i++;
      } else if (c === C_0 && (c1 | 0x20) === 98 /* b */ && i + 2 < n && (sql.charCodeAt(i + 2) === C_0 || sql.charCodeAt(i + 2) === C_1)) {
        i += 3;
        while (i < n && (sql.charCodeAt(i) === C_0 || sql.charCodeAt(i) === C_1)) i++;
      } else if (c === C_0 && (c1 | 0x20) === 111 /* o */ && i + 2 < n && sql.charCodeAt(i + 2) >= C_0 && sql.charCodeAt(i + 2) <= C_7) {
        i += 3;
        while (i < n && sql.charCodeAt(i) >= C_0 && sql.charCodeAt(i) <= C_7) i++;
      } else {
        while (i < n && isDigit(sql.charCodeAt(i))) i++;
        if (i < n && sql.charCodeAt(i) === C_DOT) {
          i++;
          while (i < n && isDigit(sql.charCodeAt(i))) i++;
        }
        if (i < n && (sql.charCodeAt(i) | 0x20) === 101 /* e */) {
          let j = i + 1;
          const s = j < n ? sql.charCodeAt(j) : -1;
          if (s === C_PLUS || s === C_MINUS) j++;
          if (j < n && isDigit(sql.charCodeAt(j))) {
            i = j + 1;
            while (i < n && isDigit(sql.charCodeAt(i))) i++;
          }
        }
      }
      push('number', start, i);
      continue;
    }

    // Params: ?, ?1, :name, @name, @@name
    if (c === C_QUESTION && !(isPg && (c1 === C_PIPE || c1 === C_AMP))) {
      i++;
      while (i < n && isDigit(sql.charCodeAt(i))) i++;
      push('param', start, i);
      continue;
    }
    if (c === C_COLON && c1 !== C_COLON && c1 !== -1 && (isAsciiLetter(c1) || c1 === C_UNDERSCORE)) {
      i += 2;
      while (i < n && isIdentPart(sql.charCodeAt(i))) i++;
      push('param', start, i);
      continue;
    }
    if (c === C_AT && !isPg) {
      let j = i + 1;
      if (c1 === C_AT && (isMssql || isMysql || dialect === 'generic')) j++;
      if (j < n && isIdentStart(sql.charCodeAt(j))) {
        i = j + 1;
        while (i < n) {
          const d = sql.charCodeAt(i);
          if (isIdentPart(d) || (isMssql && (d === C_HASH || d === C_AT))) i++;
          else break;
        }
        push('param', start, i);
        continue;
      }
    }

    // Punctuation
    if (c === C_LPAREN || c === C_RPAREN || c === C_COMMA || c === C_DOT || c === C_SEMI || c === C_LBRACKET || c === C_RBRACKET) {
      i++;
      push('punct', start, i);
      continue;
    }

    // Operators, longest match first
    if (i + 4 <= n && OPERATORS_4.has(sql.slice(i, i + 4))) {
      i += 4;
    } else if (i + 3 <= n && OPERATORS_3.has(sql.slice(i, i + 3))) {
      i += 3;
    } else if (i + 2 <= n && OPERATORS_2.has(sql.slice(i, i + 2))) {
      i += 2;
    } else {
      // Any other character is a one-character operator (including a lone `!` or `$`).
      // Surrogate pairs stay together.
      i += c >= 0xd800 && c <= 0xdbff && i + 1 < n ? 2 : 1;
    }
    push('operator', start, i);
  }

  return tokens;
}

/** True when the token right before `pos` (with no gap) is a name or `)`, so a following `.5` is not a number. */
function followsName(tokens: Token[], pos: number): boolean {
  const prev = tokens.length > 0 ? tokens[tokens.length - 1] : undefined;
  if (!prev || prev.end !== pos) return false;
  return (
    prev.type === 'word' ||
    prev.type === 'quoted' ||
    (prev.type === 'punct' && (prev.value === ')' || prev.value === ']'))
  );
}
