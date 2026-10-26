import { DatabaseType } from '../types';
import {
  tokenize,
  toSqlDialect,
  significantTokens,
  splitStatements,
  SqlLexError,
  type SqlDialect,
  type Token,
} from '../sql';

/** First words validateSQLSyntax accepts, in the order 0.0.1 listed them. */
const VALID_STARTS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH'];
const VALID_START_SET: ReadonlySet<string> = new Set(VALID_STARTS);

const NUL = /\0/g;

// 0.0.1 behavior, used only when the query cannot be tokenized.
const LEGACY_LINE_COMMENT = /--[^\n]*/g;
const LEGACY_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LEGACY_TRAILING_SEMICOLONS = /;+$/;
const LEGACY_LIMIT = /LIMIT\s+\d+/i;
const WHITESPACE_RUN = /\s+/g;

// Markdown extraction
const FENCE = /```|~~~/g;
/** After a fence: optional language tag and an optional line break (sticky, set lastIndex first). */
const FENCE_TAG = /[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*(\r?\n)?/y;
const SQL_WRAPPER = /<sql>([\s\S]*?)<\/sql>/i;
const LEADING_SQL_LINE = /^[ \t]*sql[ \t]*\r?\n/i;
/** Fence tags that mark a SQL block; a block with one of these is preferred. */
const SQL_FENCE_TAGS: ReadonlySet<string> = new Set(
  'sql postgresql postgres pgsql psql plpgsql mysql mariadb sqlite sqlite3 tsql t-sql mssql sqlserver transact-sql plsql'.split(' ')
);

/** Words that combine query branches. @internal */
export const SET_OPERATORS: ReadonlySet<string> = new Set(['UNION', 'INTERSECT', 'EXCEPT']);

/** Words that can follow `WITH ... AS (...)` as the main statement. */
const MAIN_HEADS: ReadonlySet<string> = new Set(
  'SELECT INSERT UPDATE DELETE MERGE VALUES TABLE REPLACE UPSERT WITH'.split(' ')
);

/** First words of a parenthesized group that holds a query (and so has its own scope). */
const QUERY_GROUP_HEADS: ReadonlySet<string> = new Set(
  'SELECT WITH VALUES TABLE INSERT UPDATE DELETE MERGE'.split(' ')
);

/**
 * Significant tokens of one statement with their paren/bracket structure.
 * @internal
 */
export interface Shape {
  t: Token[];
  /** Nesting depth of each token, counting `(` and `[`; an opener and its closer have the outer depth. */
  depth: Int32Array;
  /** Index of the matching closer (for an opener) or opener (for a closer); -1 otherwise. */
  pair: Int32Array;
  /** Index of the innermost enclosing opener, or -1 at the top level. */
  parent: Int32Array;
  /** Whether every `(` and `[` is closed by its own closer. */
  balanced: boolean;
  /** Query scope of each token, computed on first use by queryScopes(). */
  scope?: Int32Array;
}

/**
 * A replacement of `[start, end)` in the source text (an insertion when start === end).
 * @internal
 */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * A row limit at the top level of a statement.
 * @internal
 */
export interface RowLimit {
  /** Index of the LIMIT, FETCH or TOP keyword. */
  keyword: number;
  /** Token span of the row count (sign included, parentheses excluded). Empty when the count is implicit. */
  valueStart: number;
  valueEnd: number;
  /** The row count, or null when it is not a plain number (a parameter, an expression, PERCENT, ALL). */
  value: number | null;
  /** `LIMIT ALL`, which does not limit anything. */
  all: boolean;
}

/** @internal */
export function isNameToken(tok: Token | undefined): boolean {
  return !!tok && (tok.type === 'word' || tok.type === 'quoted');
}

/** Identifier name of a word or quoted token (quotes removed, case kept). @internal */
export function nameOf(tok: Token): string {
  return tok.type === 'quoted' ? tok.value : tok.text;
}

/** @internal */
export function isPunctAt(t: Token[], i: number, v: string): boolean {
  const tok = t[i];
  return !!tok && tok.type === 'punct' && tok.value === v;
}

/**
 * A keyword use of word `v` at `i`: a word token that is not part of a
 * qualified name (`t.limit`, `limit.x`). @internal
 */
export function isWordAt(t: Token[], i: number, v: string): boolean {
  const tok = t[i];
  return (
    !!tok &&
    tok.type === 'word' &&
    tok.value === v &&
    !(i > 0 && isPunctAt(t, i - 1, '.')) &&
    !isPunctAt(t, i + 1, '.')
  );
}

/** Paren/bracket structure of a statement's significant tokens. @internal */
export function shapeOf(t: Token[]): Shape {
  const n = t.length;
  const depth = new Int32Array(n);
  const pair = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n);
  const stack: number[] = [];
  let balanced = true;
  for (let i = 0; i < n; i++) {
    const tok = t[i];
    parent[i] = stack.length > 0 ? stack[stack.length - 1] : -1;
    depth[i] = stack.length;
    if (tok.type !== 'punct') continue;
    const v = tok.value;
    if (v === '(' || v === '[') {
      stack.push(i);
    } else if (v === ')' || v === ']') {
      const o = stack.length > 0 ? stack[stack.length - 1] : -1;
      if (o >= 0 && t[o].value === (v === ')' ? '(' : '[')) {
        stack.pop();
        pair[o] = i;
        pair[i] = o;
        depth[i] = stack.length;
        parent[i] = parent[o];
      } else {
        balanced = false;
      }
    }
  }
  if (stack.length > 0) balanced = false;
  return { t, depth, pair, parent, balanced };
}

/**
 * Index of the main statement after the `WITH` at `w` (past every CTE body and
 * Postgres SEARCH/CYCLE clause), or -1 if the CTE list cannot be read. @internal
 */
export function skipWith(s: Shape, w: number): number {
  const { t, pair } = s;
  const n = t.length;
  let j = w + 1;
  if (isWordAt(t, j, 'RECURSIVE')) j++;
  let defs = 0;
  while (j < n && isNameToken(t[j])) {
    let k = j + 1;
    if (isPunctAt(t, k, '(')) {
      if (pair[k] < 0) return -1;
      k = pair[k] + 1;
    }
    if (!isWordAt(t, k, 'AS')) break;
    k++;
    if (isWordAt(t, k, 'NOT') && isWordAt(t, k + 1, 'MATERIALIZED')) k += 2;
    else if (isWordAt(t, k, 'MATERIALIZED')) k++;
    if (!isPunctAt(t, k, '(') || pair[k] < 0) break;
    k = pair[k] + 1;
    defs++;
    while (isWordAt(t, k, 'SEARCH') || isWordAt(t, k, 'CYCLE')) {
      k++;
      while (
        k < n &&
        !isPunctAt(t, k, ',') &&
        !isPunctAt(t, k, '(') &&
        !(t[k].type === 'word' && MAIN_HEADS.has(t[k].value))
      ) {
        k++;
      }
    }
    j = k;
    if (!isPunctAt(t, k, ',')) break;
    j = k + 1;
  }
  return defs > 0 && j < n ? j : -1;
}

/** Index of the statement's main keyword, past leading `(` and WITH clauses; -1 if there is none. @internal */
export function mainIndex(s: Shape, from = 0): number {
  const t = s.t;
  let j = from;
  for (;;) {
    while (j < t.length && isPunctAt(t, j, '(')) j++;
    if (!isWordAt(t, j, 'WITH')) return j < t.length ? j : -1;
    j = skipWith(s, j);
    if (j < 0) return -1;
  }
}

/** Whether the group opened at `o` holds a query or statement (it is a scope of its own). @internal */
export function isQueryGroup(s: Shape, o: number): boolean {
  const scope = queryScopes(s);
  return o + 1 < s.t.length && scope[o + 1] === o;
}

/**
 * The innermost enclosing query group (a `(` whose first word is SELECT, WITH,
 * VALUES, TABLE or a DML keyword) of every token, or -1 for the statement
 * itself. Parenthesized joins and function arguments are not scopes. Computed
 * once per shape in two linear passes. @internal
 */
export function queryScopes(s: Shape): Int32Array {
  if (s.scope) return s.scope;
  const { t, parent } = s;
  const n = t.length;
  const isQuery = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) {
    if (!isPunctAt(t, i, '(')) continue;
    const next = t[i + 1];
    if (isPunctAt(t, i + 1, '(')) isQuery[i] = isQuery[i + 1];
    else isQuery[i] = next && next.type === 'word' && QUERY_GROUP_HEADS.has(next.value) ? 1 : 0;
  }
  const scope = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const p = parent[i];
    scope[i] = p < 0 ? -1 : isQuery[p] ? p : scope[p];
  }
  s.scope = scope;
  return scope;
}

/**
 * Split `[start, end)` at the UNION/INTERSECT/EXCEPT operators on the level of
 * `start`. Returns `[branchStart, branchEnd)` pairs. Nested groups are
 * skipped, so the cost is the number of tokens on this level. @internal
 */
export function branchesOf(s: Shape, start: number, end: number): Array<[number, number]> {
  const { t, pair } = s;
  const out: Array<[number, number]> = [];
  if (start >= end) return out;
  let bs = start;
  for (let i = start; i < end; i++) {
    const tok = t[i];
    if (tok.type === 'punct') {
      if ((tok.value === '(' || tok.value === '[') && pair[i] > i) i = pair[i];
      continue;
    }
    if (tok.type === 'word' && SET_OPERATORS.has(tok.value) && isWordAt(t, i, tok.value)) {
      out.push([bs, i]);
      bs = isWordAt(t, i + 1, 'ALL') || isWordAt(t, i + 1, 'DISTINCT') ? i + 2 : i + 1;
    }
  }
  out.push([bs, end]);
  return out;
}

interface Literal {
  value: number;
  /** Token span of the sign and number. */
  start: number;
  end: number;
  /** Index after the literal, including closing parentheses. */
  next: number;
}

/**
 * A plain numeric literal at `j`: `5`, `-1`, `(10)`. Null for parameters and
 * expressions. With `standalone` false the token after it is not checked (in
 * `TOP (10) *` the star is the select list, not a multiplication).
 */
function literalAt(t: Token[], j: number, standalone = true): Literal | null {
  let open = 0;
  while (isPunctAt(t, j + open, '(')) open++;
  let k = j + open;
  let sign = 1;
  const s = t[k];
  if (s && s.type === 'operator' && (s.value === '-' || s.value === '+')) {
    if (s.value === '-') sign = -1;
    k++;
  }
  const num = t[k];
  if (!num || num.type !== 'number') return null;
  let next = k + 1;
  for (let c = 0; c < open; c++, next++) {
    if (!isPunctAt(t, next, ')')) return null;
  }
  const after = standalone ? t[next] : undefined;
  if (after && (after.type === 'operator' || (after.type === 'punct' && (after.value === '.' || after.value === '[' || after.value === '(')))) {
    return null; // an expression such as 10 * 1000
  }
  const value = sign * Number(num.text);
  if (Number.isNaN(value)) return null;
  return { value, start: j + open, end: k + 1, next };
}

/** Whether `tok` can start the row count of LIMIT or OFFSET. */
function startsCount(t: Token[], i: number, allowAll: boolean): boolean {
  const tok = t[i];
  if (!tok) return false;
  switch (tok.type) {
    case 'number':
    case 'param':
      return true;
    case 'word':
      return allowAll && isWordAt(t, i, 'ALL');
    case 'punct':
      return tok.value === '(';
    case 'operator':
      return tok.value === '-' || tok.value === '+';
    default:
      return false;
  }
}

/** Any set operator at a depth up to `maxDepth`. */
function hasSetOperatorUpTo(s: Shape, maxDepth: number): boolean {
  const { t, depth } = s;
  for (let i = 0; i < t.length; i++) {
    if (depth[i] <= maxDepth && t[i].type === 'word' && SET_OPERATORS.has(t[i].value) && isWordAt(t, i, t[i].value)) {
      return true;
    }
  }
  return false;
}

/**
 * Row limits that bound the whole statement: LIMIT and FETCH at the top level,
 * and (mssql, generic) TOP on the main SELECT when no set operator follows it.
 * @internal
 */
export function findRowLimits(s: Shape, dialect: SqlDialect): RowLimit[] {
  const { t, depth } = s;
  const out: RowLimit[] = [];
  for (let i = 0; i < t.length; i++) {
    if (depth[i] !== 0 || t[i].type !== 'word') continue;
    const v = t[i].value;
    if (v === 'LIMIT' && isWordAt(t, i, v) && startsCount(t, i + 1, true)) {
      if (isWordAt(t, i + 1, 'ALL')) {
        out.push({ keyword: i, valueStart: i + 1, valueEnd: i + 2, value: null, all: true });
        continue;
      }
      const first = literalAt(t, i + 1);
      const afterFirst = first ? first.next : i + 2;
      if (isPunctAt(t, afterFirst, ',')) {
        // MySQL `LIMIT offset, count`
        const count = literalAt(t, afterFirst + 1);
        out.push(
          count
            ? { keyword: i, valueStart: count.start, valueEnd: count.end, value: count.value, all: false }
            : { keyword: i, valueStart: afterFirst + 1, valueEnd: afterFirst + 1, value: null, all: false }
        );
      } else if (first) {
        out.push({ keyword: i, valueStart: first.start, valueEnd: first.end, value: first.value, all: false });
      } else {
        out.push({ keyword: i, valueStart: i + 1, valueEnd: i + 1, value: null, all: false });
      }
    } else if (v === 'FETCH' && isWordAt(t, i, v) && (isWordAt(t, i + 1, 'FIRST') || isWordAt(t, i + 1, 'NEXT'))) {
      const j = i + 2;
      if (isWordAt(t, j, 'ROW') || isWordAt(t, j, 'ROWS')) {
        out.push({ keyword: i, valueStart: j, valueEnd: j, value: 1, all: false });
        continue;
      }
      const lit = literalAt(t, j);
      if (lit) {
        const percent = isWordAt(t, lit.next, 'PERCENT');
        out.push({ keyword: i, valueStart: lit.start, valueEnd: lit.end, value: percent ? null : lit.value, all: false });
      } else {
        out.push({ keyword: i, valueStart: j, valueEnd: j, value: null, all: false });
      }
    }
  }

  if (dialect === 'mssql' || dialect === 'generic') {
    const h = mainIndex(s);
    if (h >= 0 && isWordAt(t, h, 'SELECT')) {
      let j = h + 1;
      if (isWordAt(t, j, 'ALL') || isWordAt(t, j, 'DISTINCT')) j++;
      const after = t[j + 1];
      if (
        isWordAt(t, j, 'TOP') &&
        after &&
        (after.type === 'number' || after.type === 'param' || isPunctAt(t, j + 1, '(')) &&
        !hasSetOperatorUpTo(s, depth[h])
      ) {
        // `TOP n` takes a constant (a following `*` is the select list); `TOP (expr)` an expression
        let lit: Literal | null = null;
        if (after.type === 'number') {
          const value = Number(after.text);
          if (!Number.isNaN(value)) lit = { value, start: j + 1, end: j + 2, next: j + 2 };
        } else if (after.type === 'punct') {
          lit = literalAt(t, j + 1, false);
        }
        const countEnd = lit ? lit.next : isPunctAt(t, j + 1, '(') && s.pair[j + 1] > 0 ? s.pair[j + 1] + 1 : j + 2;
        const percent = isWordAt(t, countEnd, 'PERCENT');
        out.push(
          lit
            ? { keyword: j, valueStart: lit.start, valueEnd: lit.end, value: percent ? null : lit.value, all: false }
            : { keyword: j, valueStart: j + 1, valueEnd: j + 1, value: null, all: false }
        );
      }
    }
  }
  return out;
}

/** Apply non-overlapping edits to `text` in one pass. @internal */
export function applyEdits(text: string, edits: TextEdit[]): string {
  if (edits.length === 0) return text;
  const sorted = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    out += text.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  return out + text.slice(pos);
}

/** Whether the first significant word (after leading `(`) is one validateSQLSyntax accepts. */
function startsWithStatement(sig: Token[]): boolean {
  let i = 0;
  while (i < sig.length && sig[i].type === 'punct' && sig[i].value === '(') i++;
  const tok = sig[i];
  return !!tok && tok.type === 'word' && VALID_START_SET.has(tok.value);
}

/** validateSQLSyntax error for a lexer failure, with the 0.0.1 wording where 0.0.1 had one. */
function lexErrorMessage(error: SqlLexError): string {
  switch (error.delimiter) {
    case "'":
      return 'Unbalanced single quotes';
    case '"':
    case 'U&"':
      return 'Unbalanced double quotes';
    case '`':
      return 'Unbalanced backticks';
    case '[':
      return 'Unbalanced brackets';
  }
  if (error.kind === 'unterminated_comment') return 'Unterminated block comment';
  return error.message;
}

/**
 * Join tokens back into one line: comments become a single space, whitespace
 * runs outside literals collapse to one space, and everything after the last
 * significant token other than `;` is dropped.
 *
 * In the generic dialect `#` starts a comment only on MySQL; to Postgres it is
 * an operator. Such comments are kept (on their own line) so that validation
 * rejects the ambiguous query instead of the sanitizer silently cutting it.
 */
function renderSanitized(tokens: Token[], keepHashComments: boolean): string {
  let last = tokens.length - 1;
  while (last >= 0) {
    const tok = tokens[last];
    if (tok.type === 'whitespace' || tok.type === 'comment' || (tok.type === 'punct' && tok.value === ';')) last--;
    else break;
  }
  let out = '';
  let gap = '';
  for (let i = 0; i <= last; i++) {
    const tok = tokens[i];
    const kept = tok.type === 'comment' && keepHashComments && tok.text.charCodeAt(0) === 35; /* # */
    if (tok.type === 'whitespace' || (tok.type === 'comment' && !kept)) {
      if (gap === '') gap = ' ';
      continue;
    }
    if (out.length > 0 && gap !== '') out += gap;
    out += tok.text;
    // A kept line comment runs to the end of the line, so a line break must follow it.
    gap = kept ? '\n' : '';
  }
  return out;
}

/**
 * Find the SQL in a Markdown answer: a `sql`-tagged block first, then an
 * untagged block, then any other block, then an unclosed fence. Null when the
 * text has no fence.
 */
function findFencedBlock(text: string): string | null {
  let plain: string | null = null;
  let other: string | null = null;
  let unclosed: string | null = null;
  FENCE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(text)) !== null) {
    const marker = m[0];
    FENCE_TAG.lastIndex = m.index + marker.length;
    const tagMatch = FENCE_TAG.exec(text);
    let tag = tagMatch ? tagMatch[1].toLowerCase() : '';
    let bodyStart: number;
    if (tagMatch && (tagMatch[2] !== undefined || SQL_FENCE_TAGS.has(tag))) {
      bodyStart = FENCE_TAG.lastIndex;
    } else {
      // "```SELECT 1```": the word after the fence is the query, not a tag
      tag = '';
      bodyStart = m.index + marker.length;
    }
    const close = text.indexOf(marker, bodyStart);
    if (close < 0) {
      if (tag === '' || SQL_FENCE_TAGS.has(tag)) unclosed = text.slice(bodyStart);
      break;
    }
    const body = text.slice(bodyStart, close).trim();
    if (SQL_FENCE_TAGS.has(tag)) return body;
    if (tag === '') {
      if (plain === null) plain = body;
    } else if (other === null) {
      other = body;
    }
    FENCE.lastIndex = close + marker.length;
  }
  if (plain !== null) return plain;
  if (other !== null) return other;
  return unclosed !== null ? unclosed.trim() : null;
}

/**
 * Query sanitizer to clean and normalize SQL queries
 */
export class QuerySanitizer {
  private readonly dialect: SqlDialect;

  constructor(private databaseType?: DatabaseType) {
    this.dialect = toSqlDialect(databaseType);
  }

  /**
   * Sanitize a SQL query: remove NUL bytes and comments, drop trailing
   * semicolons and collapse whitespace outside string literals and quoted
   * identifiers. Semicolons between statements are kept, so validation still
   * sees every statement.
   */
  sanitize(query: string): string {
    const input = query.indexOf('\0') >= 0 ? query.replace(NUL, '') : query;
    let tokens: Token[];
    try {
      tokens = tokenize(input, this.dialect);
    } catch (error) {
      if (!(error instanceof SqlLexError)) throw error;
      // An executable comment is code to MySQL: keep it, so validation rejects it.
      return this.legacySanitize(input, error.kind !== 'executable_comment');
    }
    return renderSanitized(tokens, this.dialect === 'generic');
  }

  /** The 0.0.1 sanitizer, for text the lexer cannot read (validation then reports the problem). */
  private legacySanitize(query: string, removeComments: boolean): string {
    let sanitized = query.trim();
    if (removeComments) sanitized = this.removeComments(sanitized);
    sanitized = sanitized.replace(LEGACY_TRAILING_SEMICOLONS, '');
    return this.normalizeWhitespace(sanitized);
  }

  /**
   * Remove SQL comments (0.0.1 regexes; used only when the query cannot be tokenized)
   */
  private removeComments(query: string): string {
    return query.replace(LEGACY_LINE_COMMENT, '').replace(LEGACY_BLOCK_COMMENT, '');
  }

  /**
   * Normalize whitespace in query (0.0.1 behavior; used only when the query cannot be tokenized)
   */
  private normalizeWhitespace(query: string): string {
    return query
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(' ')
      .replace(WHITESPACE_RUN, ' ');
  }

  /**
   * Extract query from markdown code blocks if present.
   *
   * Accepts ``` and ~~~ fences with any language tag (a SQL-tagged block is
   * preferred), an `<sql>...</sql>` wrapper and a leading "sql" line. Text
   * without any of these is returned as is.
   */
  extractFromMarkdown(text: string): string {
    const block = findFencedBlock(text);
    if (block !== null) return block.replace(LEADING_SQL_LINE, '').trim();
    const wrapped = SQL_WRAPPER.exec(text);
    if (wrapped) return wrapped[1].trim().replace(LEADING_SQL_LINE, '').trim();
    return LEADING_SQL_LINE.test(text) ? text.replace(LEADING_SQL_LINE, '') : text;
  }

  /**
   * Validate that the query is a valid SQL statement: it starts with SELECT,
   * INSERT, UPDATE, DELETE or WITH (also after leading `(`), its parentheses
   * balance and every string, quoted identifier and comment is closed.
   */
  validateSQLSyntax(query: string): { valid: boolean; error?: string } {
    let tokens: Token[];
    try {
      tokens = tokenize(query, this.dialect);
    } catch (error) {
      if (!(error instanceof SqlLexError)) throw error;
      // Everything before the failing token lexes, so the first word can still be checked.
      const prefix = significantTokens(tokenize(query.slice(0, error.position), this.dialect));
      if (!startsWithStatement(prefix)) {
        return { valid: false, error: `Query must start with one of: ${VALID_STARTS.join(', ')}` };
      }
      // Not a syntax problem: the security validator rejects it with its own message.
      if (error.kind === 'executable_comment') return { valid: true };
      return { valid: false, error: lexErrorMessage(error) };
    }

    const sig = significantTokens(tokens);
    if (!startsWithStatement(sig)) {
      return { valid: false, error: `Query must start with one of: ${VALID_STARTS.join(', ')}` };
    }

    let depth = 0;
    for (const tok of sig) {
      if (tok.type !== 'punct') continue;
      if (tok.value === '(') depth++;
      else if (tok.value === ')' && --depth < 0) return { valid: false, error: 'Unbalanced parentheses' };
    }
    if (depth !== 0) return { valid: false, error: 'Unbalanced parentheses' };

    return { valid: true };
  }

  /**
   * Escape special characters in values
   */
  escapeValue(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Add a row limit if the main statement has none at its top level (LIMIT,
   * TOP or FETCH; a limit inside a subquery does not count). Appends
   * ` LIMIT n`, or on mssql inserts `TOP n` after `SELECT [DISTINCT|ALL]`.
   */
  addLimitIfMissing(query: string, limit: number): string {
    return this.applyLimit(query, limit, false);
  }

  /**
   * Make sure the query returns at most `limit` rows: add a limit if missing
   * (as addLimitIfMissing) and lower a larger top-level LIMIT, TOP or FETCH
   * count in place. `LIMIT ALL` and negative counts (unlimited in SQLite) are
   * replaced too.
   */
  enforceLimit(query: string, limit: number): string {
    return this.applyLimit(query, limit, true);
  }

  private applyLimit(query: string, limit: number, lower: boolean): string {
    let tokens: Token[];
    try {
      tokens = tokenize(query, this.dialect);
    } catch (error) {
      if (!(error instanceof SqlLexError)) throw error;
      return LEGACY_LIMIT.test(query) ? query : `${query} LIMIT ${limit}`;
    }
    const statements = splitStatements(tokens);
    if (statements.length === 0) return `${query} LIMIT ${limit}`;
    const shape = shapeOf(statements[0]);
    const t = shape.t;
    const limits = findRowLimits(shape, this.dialect);
    const n = String(limit);
    const edits: TextEdit[] = [];

    if (limits.length === 0) {
      if (this.dialect === 'mssql') {
        if (!this.mssqlLimit(shape, n, edits)) return query;
      } else {
        const end = t[t.length - 1].end;
        edits.push({ start: end, end, text: ` LIMIT ${n}` });
      }
    } else if (lower) {
      for (const l of limits) {
        if (l.valueEnd <= l.valueStart) continue;
        if (l.all || (l.value !== null && (l.value > limit || l.value < 0))) {
          edits.push({ start: t[l.valueStart].start, end: t[l.valueEnd - 1].end, text: n });
        }
      }
    }
    return applyEdits(query, edits);
  }

  /**
   * T-SQL has no LIMIT: insert `TOP n` into each SELECT branch, or add
   * `FETCH NEXT n ROWS ONLY` after an OFFSET clause (TOP and OFFSET cannot be
   * combined). Returns false when nothing could be added.
   */
  private mssqlLimit(shape: Shape, n: string, edits: TextEdit[]): boolean {
    const { t, depth } = shape;
    for (let i = 0; i < t.length; i++) {
      if (depth[i] === 0 && isWordAt(t, i, 'OFFSET') && startsCount(t, i + 1, false)) {
        const end = t[t.length - 1].end;
        edits.push({ start: end, end, text: ` FETCH NEXT ${n} ROWS ONLY` });
        return true;
      }
    }
    let j = 0;
    if (isWordAt(t, 0, 'WITH')) {
      j = skipWith(shape, 0);
      if (j < 0) return false;
    }
    for (const [bs, be] of branchesOf(shape, j, t.length)) {
      let k = bs;
      while (k < be && isPunctAt(t, k, '(')) k++;
      if (!isWordAt(t, k, 'SELECT')) continue;
      let m = k + 1;
      if (isWordAt(t, m, 'ALL') || isWordAt(t, m, 'DISTINCT')) m++;
      const at = t[m - 1].end;
      edits.push({ start: at, end: at, text: ` TOP ${n}` });
    }
    return edits.length > 0;
  }
}
