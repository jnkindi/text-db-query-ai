import type { QueryOperation } from '../types';
import { tokenize, type LexOptions, type SqlDialect, type Token } from './lexer';
import { SQL_KEYWORDS, STATEMENT_KEYWORDS } from './keywords';

/** A base table referenced by a query. */
export interface TableReference {
  /** Table name as written (quotes removed, case kept). */
  name: string;
  /** Schema (the part right before the name), e.g. `public` or `dbo`. */
  schema?: string;
  /** Anything before the schema (`db` in `db.dbo.t` and in `db..t`). */
  catalog?: string;
  /** Alias the query gives the table. */
  alias?: string;
  /** Whether the table name itself was a quoted identifier. */
  quoted: boolean;
  /** Offset of the first character of the (qualified) name. */
  start: number;
  /** Offset after the last character of the name. */
  end: number;
}

/** A column reference: qualified (`a.b`) or a bare-word candidate. */
export interface ColumnReference {
  name: string;
  /** The part right before the column name (`t` in `s.t.c`). */
  qualifier?: string;
  quoted: boolean;
  start: number;
  end: number;
}

export interface NestedStatement {
  /** Statement keyword, uppercased (e.g. `DELETE`). */
  keyword: string;
  /** Offset of the keyword in the source. */
  start: number;
}

export interface SqlAnalysis {
  dialect: SqlDialect;
  /** Every token, including whitespace and comments. */
  tokens: Token[];
  /** Significant tokens per statement; empty statements are dropped. */
  statements: Token[][];
  hasComments: boolean;
  /** Operation of statement 0, with WITH and leading `(` resolved to the main statement. */
  operation: QueryOperation | null;
  /** Base tables anywhere in the query. CTE names and table functions are excluded. */
  tables: TableReference[];
  cteNames: string[];
  /** Table, derived-table, function, select-list, CTE-column and WINDOW aliases, plus `excluded`. */
  aliases: string[];
  /** Qualified column references and bare-word column candidates. */
  columns: ColumnReference[];
  /** `''` for a bare `*` in a select list, otherwise the qualifier of `t.*`. */
  starQualifiers: string[];
  /** Uppercased names of called functions. */
  functions: string[];
  /** A statement keyword right after `(` (DML in a CTE or subquery). */
  nestedStatements: NestedStatement[];
}

const set = (s: string): ReadonlySet<string> => new Set(s.trim().split(/\s+/));

/** Words that start a query (as opposed to the STATEMENT_KEYWORDS). */
const QUERY_HEADS = set('SELECT WITH VALUES TABLE');

/** Words that start the main statement after a WITH clause. */
const MAIN_HEADS = set('SELECT INSERT UPDATE DELETE MERGE VALUES TABLE REPLACE UPSERT');

/**
 * Words that cannot start a table reference. Only words reserved in every
 * supported dialect: anything else (`offset` in MySQL, `limit` in T-SQL) may be
 * a real table and must be reported.
 */
const NOT_TABLE_START = set(`
  WHERE GROUP HAVING ORDER UNION JOIN INNER LEFT RIGHT OUTER CROSS ON USING SELECT WITH FOR INTO
  AND OR NOT AS WHEN THEN ELSE CASE
`);

/** Clause words that end a FROM/UPDATE table list (some only conditionally, see isRegionEnd). */
const REGION_END = set(`
  WHERE GROUP HAVING ORDER LIMIT OFFSET FETCH UNION INTERSECT EXCEPT WINDOW RETURNING INTO
  SELECT INSERT UPDATE DELETE MERGE FROM ON FOR WITH LOCK PROCEDURE OPTION SET
`);

/** Words that end a select list. */
const SELECT_END = set(`
  FROM INTO WHERE GROUP HAVING ORDER LIMIT OFFSET FETCH UNION INTERSECT EXCEPT MINUS WINDOW
  QUALIFY FOR ON RETURNING SELECT INSERT UPDATE DELETE MERGE OPTION LOCK
`);

/** Words after FOR that make it a locking/temporal/format clause. */
const FOR_CLAUSE = set('UPDATE SHARE NO KEY READ SYSTEM_TIME XML JSON BROWSE');

const SELECT_MODIFIERS = set(`
  ALL DISTINCT DISTINCTROW HIGH_PRIORITY STRAIGHT_JOIN SQL_SMALL_RESULT SQL_BIG_RESULT
  SQL_BUFFER_RESULT SQL_NO_CACHE SQL_CACHE SQL_CALC_FOUND_ROWS
`);

/** Keywords that can end an operand, so a following word may be an implicit alias. */
const VALUE_ENDERS = set(`
  NULL TRUE FALSE UNKNOWN CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP LOCALTIME LOCALTIMESTAMP
  CURRENT_USER SESSION_USER CURRENT_ROLE CURRENT_SCHEMA CURRENT_CATALOG SYSTEM_USER USER END
`);

/** Keywords that may be followed by `(` without being a function call. */
const NON_FUNCTION = set(`
  AS IN EXISTS VALUES OVER FILTER USING ON FROM JOIN AND OR NOT WHERE SELECT WITH ALL ANY SOME
  WITHIN GROUP BY ORDER PARTITION WINDOW INTO TABLE LATERAL ONLY UNION INTERSECT EXCEPT MINUS THEN
  ELSE WHEN CASE IS LIKE ILIKE BETWEEN ROWS RANGE GROUPS ROLLUP CUBE SETS DISTINCT HAVING
  RETURNING SET DO TOP LIMIT OFFSET FETCH KEY CONFLICT MATERIALIZED ARRAY INTERVAL INDEX COLUMNS
  AGAINST OPTION PIVOT UNPIVOT CHECK UNIQUE PRIMARY REFERENCES DEFAULT ESCAPE TO APPLY RECURSIVE
  COLLATE RETURNS OF FOR REPEATABLE
`);

/** Words after `(` that show the column is an expression, not a statement keyword (`(lock IS NULL)`). */
const EXPR_CONTINUATION = set(`
  IS AND OR NOT IN LIKE ILIKE BETWEEN AS ASC DESC COLLATE SIMILAR REGEXP RLIKE GLOB MATCH ESCAPE
  NULLS OVER FILTER WITHIN ISNULL NOTNULL THEN WHEN ELSE END DIV MOD XOR
`);

const CAST_FUNCS = set('CAST TRY_CAST SAFE_CAST');
/** T-SQL functions whose first argument is a date part. */
const DATEPART_FUNCS = set('DATEADD DATEDIFF DATEDIFF_BIG DATEPART DATENAME DATETRUNC DATE_BUCKET');
/** MySQL functions whose first argument is a unit. */
const UNIT_FIRST_FUNCS = set('TIMESTAMPDIFF TIMESTAMPADD');
/** T-SQL date part names and abbreviations. */
const DATEPART_NAMES = set(`
  YEAR YY YYYY QUARTER QQ Q MONTH MM M DAYOFYEAR DY Y DAY DD D WEEK WK WW WEEKDAY DW W HOUR HH
  MINUTE MI N SECOND SS S MILLISECOND MS MICROSECOND MCS NANOSECOND NS TZOFFSET TZ ISO_WEEK ISOWK
  ISOWW
`);
/** T-SQL table hints, for the deprecated `FROM t (NOLOCK)` form. */
const TABLE_HINTS = set(`
  NOLOCK HOLDLOCK UPDLOCK ROWLOCK PAGLOCK TABLOCK TABLOCKX XLOCK READPAST READCOMMITTED
  READCOMMITTEDLOCK READUNCOMMITTED REPEATABLEREAD SERIALIZABLE SNAPSHOT NOWAIT FORCESEEK
  FORCESCAN NOEXPAND INDEX KEEPIDENTITY KEEPDEFAULTS IGNORE_CONSTRAINTS IGNORE_TRIGGERS
`);
const INSERT_MODIFIERS = set('LOW_PRIORITY DELAYED HIGH_PRIORITY IGNORE');
const DELETE_MODIFIERS = set('LOW_PRIORITY QUICK IGNORE');
const DDL_TABLE_STATEMENTS = set('TRUNCATE LOCK COPY DROP ALTER CREATE');

const OPERATIONS: ReadonlyMap<string, QueryOperation> = new Map<string, QueryOperation>([
  ['SELECT', 'SELECT'],
  ['INSERT', 'INSERT'],
  ['UPDATE', 'UPDATE'],
  ['DELETE', 'DELETE'],
]);

/** Remove whitespace and comment tokens. */
export function significantTokens(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (const t of tokens) {
    if (t.type !== 'whitespace' && t.type !== 'comment') out.push(t);
  }
  return out;
}

/**
 * Split tokens into statements at every `;` (at any depth, which is the
 * conservative reading). Whitespace and comments are dropped and empty
 * statements are removed.
 */
export function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  for (const t of tokens) {
    if (t.type === 'whitespace' || t.type === 'comment') continue;
    if (t.type === 'punct' && t.value === ';') {
      if (current.length > 0) statements.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

/**
 * Index of the first token at paren depth 0 (relative to `from`) whose value is
 * one of `words`. -1 if none. The search stops at a `)` that closes a group
 * opened before `from`. Words match word, punct and operator tokens by value
 * (quoted identifiers and strings never match).
 */
export function findTopLevel(tokens: Token[], words: string[], from = 0, to = tokens.length): number {
  let depth = 0;
  const end = Math.min(to, tokens.length);
  for (let i = Math.max(0, from); i < end; i++) {
    const t = tokens[i];
    if (t.type === 'punct') {
      if (t.value === '(') {
        depth++;
        continue;
      }
      if (t.value === ')') {
        if (depth === 0) return -1;
        depth--;
        continue;
      }
    }
    if (depth !== 0) continue;
    if ((t.type === 'word' || t.type === 'punct' || t.type === 'operator') && words.indexOf(t.value) !== -1) {
      return i;
    }
  }
  return -1;
}

// Token roles assigned during analysis (one per significant token).
const R_NONE = 0;
const R_TABLE = 1; // part of a table name
const R_ALIAS = 2; // alias being defined
const R_CTE = 3; // CTE name being defined
const R_FUNC = 4; // function name (or its qualifier)
const R_SKIP = 5; // not a column: types, date parts, hints, consumed keywords
const R_COLREF = 6; // part of a qualified column reference

const isName = (t: Token | undefined): boolean => !!t && (t.type === 'word' || t.type === 'quoted');
const isWord = (t: Token | undefined, v: string): boolean => !!t && t.type === 'word' && t.value === v;
const isPunct = (t: Token | undefined, v: string): boolean => !!t && t.type === 'punct' && t.value === v;
const isOperator = (t: Token | undefined, v: string): boolean => !!t && t.type === 'operator' && t.value === v;
const nameOf = (t: Token): string => (t.type === 'quoted' ? t.value : t.text);

/** Accumulates results across the statements of one analysis. */
class Collector {
  tables: TableReference[] = [];
  cteNames: string[] = [];
  private cteSeen = new Set<string>();
  aliases: string[] = [];
  aliasKeys = new Set<string>();
  /** Qualified references, in source order per statement. */
  qualified: ColumnReference[] = [];
  /** Bare-word candidates, in source order per statement. */
  bare: ColumnReference[] = [];
  starQualifiers: string[] = [];
  private starSeen = new Set<string>();
  functions: string[] = [];
  private functionSeen = new Set<string>();
  nestedStatements: NestedStatement[] = [];

  addAlias(name: string): void {
    const key = name.toUpperCase();
    if (this.aliasKeys.has(key)) return;
    this.aliasKeys.add(key);
    this.aliases.push(name);
  }

  addCte(name: string): void {
    if (this.cteSeen.has(name)) return;
    this.cteSeen.add(name);
    this.cteNames.push(name);
  }

  addStar(qualifier: string): void {
    if (this.starSeen.has(qualifier)) return;
    this.starSeen.add(qualifier);
    this.starQualifiers.push(qualifier);
  }

  addFunction(name: string): void {
    if (this.functionSeen.has(name)) return;
    this.functionSeen.add(name);
    this.functions.push(name);
  }
}

interface PendingTable {
  ref: TableReference;
  /** Index of the name token, for CTE scoping. */
  index: number;
  /** UPDATE/DELETE target, which may turn out to be an alias. */
  target: boolean;
}

interface CteScope {
  key: string;
  from: number;
  to: number;
}

/**
 * Analysis of one statement's significant tokens. The passes run in a fixed
 * order; each assigns roles to tokens so later passes (aliases, functions,
 * qualified columns, bare candidates) skip what earlier ones explained.
 */
class StatementAnalyzer {
  private readonly n: number;
  /** Index of the matching `)`/`]` for an opener and vice versa; -1 if unbalanced. */
  private readonly pair: Int32Array;
  /** Index of the innermost enclosing `(`/`[`, or -1 at the top level. */
  private readonly parent: Int32Array;
  /** For a CASE token, the index of its END. */
  private readonly caseEnd: Int32Array;
  private readonly role: Uint8Array;
  private readonly dispatched: Uint8Array;
  /** groupIsQuery() results per opener: 0 unknown, 1 query, 2 not a query. */
  private readonly queryGroup: Uint8Array;
  /** Pending table-list regions as [start, limit, isUpdate] triples (keeps nesting off the call stack). */
  private readonly regions: number[] = [];
  private readonly withMain = new Map<number, number>();
  private readonly scopes: CteScope[] = [];
  private readonly pending: PendingTable[] = [];

  // Token indexes collected by link(), so each pass visits only the tokens it needs.
  private readonly withIdx: number[] = [];
  private readonly fromIdx: number[] = [];
  private readonly joinIdx: number[] = [];
  private readonly intoIdx: number[] = [];
  private readonly listIdx: number[] = [];
  private readonly asIdx: number[] = [];
  private readonly miscIdx: number[] = [];
  /** `(` tokens. */
  private readonly parenIdx: number[] = [];
  /** Names followed by `(`. */
  private readonly callIdx: number[] = [];
  /** Names followed by `.`. */
  private readonly qualIdx: number[] = [];
  /** Every word and quoted identifier. */
  private readonly nameIdx: number[] = [];

  constructor(
    private readonly t: Token[],
    private readonly dialect: SqlDialect,
    private readonly out: Collector
  ) {
    const n = t.length;
    this.n = n;
    this.pair = new Int32Array(n).fill(-1);
    this.parent = new Int32Array(n);
    this.caseEnd = new Int32Array(n).fill(-1);
    this.role = new Uint8Array(n);
    this.dispatched = new Uint8Array(n);
    this.queryGroup = new Uint8Array(n);
    this.link();
  }

  /** Match parentheses, brackets and CASE/END, and index the tokens each pass needs, in one pass. */
  private link(): void {
    const { t, pair, parent, caseEnd } = this;
    const stack: number[] = [];
    const cases: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const tok = t[i];
      parent[i] = stack.length > 0 ? stack[stack.length - 1] : -1;
      switch (tok.type) {
        case 'punct': {
          const v = tok.value;
          if (v === '(' || v === '[') {
            stack.push(i);
            if (v === '(') {
              this.parenIdx.push(i);
              if (i > 0 && isName(t[i - 1])) this.callIdx.push(i - 1);
            }
          } else if (v === ')' || v === ']') {
            if (stack.length > 0) {
              const o = stack[stack.length - 1];
              if (t[o].value === (v === ')' ? '(' : '[')) {
                stack.pop();
                pair[o] = i;
                pair[i] = o;
                parent[i] = parent[o];
              }
            }
          } else if (v === '.' && i > 0 && isName(t[i - 1])) {
            this.qualIdx.push(i - 1);
          }
          break;
        }
        case 'word':
          this.nameIdx.push(i);
          switch (tok.value) {
            case 'CASE':
              cases.push(i);
              break;
            case 'END':
              if (cases.length > 0 && parent[cases[cases.length - 1]] === parent[i]) caseEnd[cases.pop()!] = i;
              break;
            case 'WITH':
              this.withIdx.push(i);
              break;
            case 'FROM':
              this.fromIdx.push(i);
              break;
            case 'JOIN':
            case 'APPLY':
            case 'STRAIGHT_JOIN':
              this.joinIdx.push(i);
              break;
            case 'INTO':
              this.intoIdx.push(i);
              break;
            case 'SELECT':
            case 'RETURNING':
              this.listIdx.push(i);
              break;
            case 'AS':
              this.asIdx.push(i);
              break;
            case 'COLLATE':
            case 'CONSTRAINT':
            case 'USING':
            case 'ON':
            case 'WINDOW':
            case 'OVER':
            case 'AGAINST':
            case 'COLUMNS':
              this.miscIdx.push(i);
              break;
          }
          break;
        case 'quoted':
          this.nameIdx.push(i);
          break;
        case 'operator':
          if (tok.value === '::' || tok.value === '=>') this.miscIdx.push(i);
          break;
        case 'string':
          if (i > 0 && t[i - 1].type === 'word') this.miscIdx.push(i);
          break;
      }
    }
  }

  private groupEnd(o: number): number {
    const c = this.pair[o];
    return c >= 0 ? c : this.n;
  }

  /** Exclusive end of the tokens at the same level as `i`. */
  private levelEnd(i: number): number {
    const p = this.parent[i];
    return p >= 0 ? this.groupEnd(p) : this.n;
  }

  private prevIsDot(k: number): boolean {
    return k > 0 && isPunct(this.t[k - 1], '.');
  }

  /** `IS [NOT] DISTINCT FROM`: this FROM is an operator, not a clause. */
  private isDistinctFrom(k: number): boolean {
    const t = this.t;
    return k >= 2 && isWord(t[k - 1], 'DISTINCT') && (isWord(t[k - 2], 'IS') || isWord(t[k - 2], 'NOT'));
  }

  private isQueryHead(k: number): boolean {
    const tok = this.t[k];
    if (!tok || tok.type !== 'word') return false;
    if (QUERY_HEADS.has(tok.value)) return true;
    return STATEMENT_KEYWORDS.has(tok.value) && this.isStatementUse(k);
  }

  /** A statement keyword used as a statement: followed by a name or literal, not `(` or an operator. */
  private isStatementUse(k: number): boolean {
    const next = this.t[k + 1];
    if (!next) return false;
    if (next.type === 'word') {
      // T-SQL join hint `OPTION (MERGE JOIN)` is not a MERGE statement
      if (next.value === 'JOIN' && this.t[k].value === 'MERGE') return false;
      return !EXPR_CONTINUATION.has(next.value);
    }
    return next.type === 'quoted' || next.type === 'string' || next.type === 'number' || next.type === 'param';
  }

  /** Whether the group opened at `o` holds a query or statement (as opposed to function arguments). */
  private groupIsQuery(o: number): boolean {
    const memo = this.queryGroup;
    if (memo[o] !== 0) return memo[o] === 1;
    let k = o + 1;
    while (k < this.n && isPunct(this.t[k], '(')) k++;
    const result = k < this.n && this.isQueryHead(k) ? 1 : 2;
    // Every opener in a run of `(((` shares the same first token.
    for (let m = o; m < k; m++) memo[m] = result;
    return result === 1;
  }

  /** If `k` opens a balanced group, the index of its closer; otherwise `k`. */
  private skipGroup(k: number): number {
    const c = this.pair[k];
    return c > k ? c : k;
  }

  /**
   * Name used to match table references with CTE names. Postgres folds
   * unquoted names to lower case and SQLite compares names case-insensitively.
   * MySQL and SQL Server may compare them case-sensitively (lower_case_table_names,
   * a _CS collation), so there a reference that only matches a CTE after
   * folding stays a table. Generic needs the exact and the Postgres-folded
   * names to match together.
   */
  private foldName(tok: Token): string {
    const pgFold = tok.type === 'quoted' ? tok.value : tok.text.toLowerCase();
    if (this.dialect === 'postgres') return pgFold;
    if (this.dialect === 'sqlite') return nameOf(tok).toLowerCase();
    if (this.dialect === 'generic') return `${nameOf(tok)}\u0000${pgFold}`;
    return nameOf(tok);
  }

  private markAlias(k: number): void {
    this.role[k] = R_ALIAS;
    this.out.addAlias(nameOf(this.t[k]));
  }

  /** Mark a dotted name starting at `j` as not-a-column (types, collations, charsets). */
  private skipName(j: number): void {
    const t = this.t;
    if (!isName(t[j])) return;
    this.role[j] = R_SKIP;
    while (isPunct(t[j + 1], '.') && isName(t[j + 2])) {
      this.role[j + 1] = R_SKIP;
      this.role[j + 2] = R_SKIP;
      j += 2;
    }
  }

  /** Read `a`, `a.b`, `a.b.c` or `db..t` starting at `j`. Returns token indexes (-1 for an empty part). */
  private readName(j: number): { parts: number[]; next: number } {
    const t = this.t;
    const parts = [j];
    let k = j + 1;
    while (k < this.n && isPunct(t[k], '.')) {
      if (isPunct(t[k + 1], '.')) {
        parts.push(-1);
        k += 1;
        continue;
      }
      if (isName(t[k + 1])) {
        parts.push(k + 1);
        k += 2;
        continue;
      }
      break;
    }
    while (parts.length > 1 && parts[parts.length - 1] < 0) parts.pop();
    return { parts, next: k };
  }

  private addTable(parts: number[], target: boolean): PendingTable | null {
    const t = this.t;
    if (this.role[parts[0]] === R_TABLE) return null; // already recorded by another pass
    const last = parts[parts.length - 1];
    const nameTok = t[last];
    for (let k = parts[0]; k <= last; k++) this.role[k] = R_TABLE;
    if (this.dialect === 'mysql' && parts.length === 1 && nameTok.type === 'word' && nameTok.value === 'DUAL') {
      return null;
    }
    const ref: TableReference = {
      name: nameOf(nameTok),
      quoted: nameTok.type === 'quoted',
      start: t[parts[0]].start,
      end: nameTok.end,
    };
    if (parts.length >= 2) {
      const s = parts[parts.length - 2];
      if (s >= 0) ref.schema = nameOf(t[s]);
    }
    if (parts.length >= 3) {
      ref.catalog = parts
        .slice(0, -2)
        .map((p) => (p >= 0 ? nameOf(t[p]) : ''))
        .join('.');
    }
    const p: PendingTable = { ref, index: last, target };
    this.pending.push(p);
    return p;
  }

  /** Words of a parenthesized name list: the first word of each element is an alias, the rest (types) are skipped. */
  private markColumnList(o: number): void {
    const { t, parent } = this;
    const close = this.groupEnd(o);
    let elementStart = o + 1;
    for (let k = o + 1; k < close; k++) {
      const tok = t[k];
      if (parent[k] === o) {
        if (isPunct(tok, ',')) {
          elementStart = k + 1;
        } else if (isName(tok)) {
          if (k === elementStart) this.markAlias(k);
          else this.role[k] = R_SKIP;
        }
      } else if (isName(tok)) {
        this.role[k] = R_SKIP;
      }
    }
  }

  /** Skip `TOP n`, `TOP (expr)`, optional PERCENT and WITH TIES. Returns the next index. */
  private skipTop(j: number): number {
    const t = this.t;
    this.role[j] = R_SKIP;
    j++;
    if (isPunct(t[j], '(')) j = this.groupEnd(j) + 1;
    else if (t[j] && (t[j].type === 'number' || t[j].type === 'param')) j++;
    if (isWord(t[j], 'PERCENT')) j++;
    if (isWord(t[j], 'WITH') && isWord(t[j + 1], 'TIES')) j += 2;
    return j;
  }

  /**
   * Parse `WITH [RECURSIVE] name [(cols)] AS [[NOT] MATERIALIZED] (...) [, ...]`.
   * Records CTE names, their column lists and the token ranges in which each
   * name refers to the CTE. Returns the index of the main statement, or -1 if
   * this WITH does not start a CTE list (T-SQL hints, WITH ROLLUP, ...).
   */
  private parseWith(w: number): number {
    const t = this.t;
    const limit = this.levelEnd(w);
    let j = w + 1;
    let recursive = false;
    if (isWord(t[j], 'RECURSIVE')) {
      recursive = true;
      j++;
    }
    const defs: { name: number; cols: number; as: number; open: number; close: number }[] = [];
    for (;;) {
      if (j >= limit || !isName(t[j])) break;
      const name = j;
      let k = j + 1;
      let cols = -1;
      if (isPunct(t[k], '(')) {
        cols = k;
        k = this.groupEnd(k) + 1;
      }
      if (!isWord(t[k], 'AS')) break;
      const as = k;
      k++;
      if (isWord(t[k], 'NOT') && isWord(t[k + 1], 'MATERIALIZED')) k += 2;
      else if (isWord(t[k], 'MATERIALIZED')) k++;
      if (!isPunct(t[k], '(')) break;
      const close = this.groupEnd(k);
      defs.push({ name, cols, as, open: k, close });
      k = close + 1;
      while (k < limit && (isWord(t[k], 'SEARCH') || isWord(t[k], 'CYCLE'))) k = this.skipSearchCycle(k, limit);
      if (isPunct(t[k], ',')) {
        j = k + 1;
        continue;
      }
      j = k;
      break;
    }
    if (defs.length === 0) return -1;

    this.role[w] = R_SKIP;
    const selfVisible = recursive || this.dialect === 'mssql' || this.dialect === 'sqlite';
    for (const d of defs) {
      this.role[d.name] = R_CTE;
      this.role[d.as] = R_SKIP;
      this.out.addCte(nameOf(t[d.name]));
      if (d.cols >= 0) this.markColumnList(d.cols);
      // RECURSIVE makes every CTE of the list visible everywhere in it. T-SQL and
      // SQLite allow a self-reference without it. Otherwise a name only refers
      // to the CTE after its own body (inside it, it is the real table).
      const from = recursive ? w : selfVisible ? d.open : d.close + 1;
      this.scopes.push({ key: this.foldName(t[d.name]), from, to: limit });
    }
    return j;
  }

  /** Skip a Postgres SEARCH or CYCLE clause; the columns it creates (after SET/USING) are aliases. */
  private skipSearchCycle(k: number, limit: number): number {
    const t = this.t;
    k++;
    while (k < limit) {
      const tok = t[k];
      if (tok.type === 'punct' && (tok.value === ',' || tok.value === '(')) break;
      if (tok.type === 'word' && MAIN_HEADS.has(tok.value)) break;
      if (isWord(tok, 'SET') || isWord(tok, 'USING')) {
        if (isName(t[k + 1])) this.markAlias(k + 1);
        k += 2;
        continue;
      }
      if (isName(tok)) this.role[k] = R_SKIP;
      k++;
    }
    return k;
  }

  /**
   * Handle the statement starting at `k` (leading parens and a WITH clause are
   * skipped). Returns the main statement keyword, or null.
   */
  private dispatch(k: number): string | null {
    const t = this.t;
    let j = k;
    while (j < this.n && isPunct(t[j], '(')) j++;
    if (j >= this.n || this.dispatched[j]) return null;
    this.dispatched[j] = 1;
    if (isWord(t[j], 'WITH')) {
      const m = this.withMain.get(j);
      if (m === undefined) return null;
      j = m;
      while (j < this.n && isPunct(t[j], '(')) j++;
      if (j >= this.n) return null;
      this.dispatched[j] = 1;
    }
    const tok = t[j];
    if (tok.type !== 'word') return null;
    switch (tok.value) {
      case 'INSERT':
      case 'UPSERT':
        this.insertStatement(j);
        break;
      case 'REPLACE':
        if (!isPunct(t[j + 1], '(')) this.insertStatement(j);
        break;
      case 'UPDATE':
        this.updateStatement(j);
        break;
      case 'DELETE':
        this.deleteStatement(j);
        break;
      case 'MERGE':
        this.mergeStatement(j);
        break;
      case 'TABLE':
        if (isName(t[j + 1])) this.addTable(this.readName(j + 1).parts, false);
        break;
      default:
        if (DDL_TABLE_STATEMENTS.has(tok.value)) this.ddlStatement(j);
    }
    return tok.value;
  }

  private insertStatement(s: number): void {
    const t = this.t;
    let j = s + 1;
    while (t[j] && t[j].type === 'word' && INSERT_MODIFIERS.has(t[j].value)) j++;
    if (isWord(t[j], 'OR') && t[j + 1] && t[j + 1].type === 'word') j += 2; // SQLite INSERT OR REPLACE
    if (isWord(t[j], 'TOP')) j = this.skipTop(j);
    if (isWord(t[j], 'INTO')) {
      this.role[j] = R_SKIP;
      j++;
    }
    const tok = t[j];
    if (!isName(tok)) return;
    if (tok.type === 'word' && (QUERY_HEADS.has(tok.value) || tok.value === 'DEFAULT' || tok.value === 'SET')) return;
    const nm = this.readName(j);
    const p = this.addTable(nm.parts, false);
    j = nm.next;
    if (isWord(t[j], 'AS') && isName(t[j + 1])) {
      this.role[j] = R_SKIP;
      this.markAlias(j + 1);
      if (p) p.ref.alias = nameOf(t[j + 1]);
    }
    // A following `(a, b)` column list keeps its names as column candidates.
  }

  private updateStatement(s: number): void {
    const t = this.t;
    let j = s + 1;
    while (isWord(t[j], 'LOW_PRIORITY') || isWord(t[j], 'IGNORE')) j++;
    if (isWord(t[j], 'OR') && t[j + 1] && t[j + 1].type === 'word') j += 2;
    if (isWord(t[j], 'TOP')) j = this.skipTop(j);
    const before = this.pending.length;
    this.scanTableList(j, this.levelEnd(s), true);
    for (let k = before; k < this.pending.length; k++) this.pending[k].target = true;
  }

  private deleteStatement(s: number): void {
    const t = this.t;
    let j = s + 1;
    while (t[j] && t[j].type === 'word' && DELETE_MODIFIERS.has(t[j].value)) j++;
    if (isWord(t[j], 'TOP')) j = this.skipTop(j);
    if (isWord(t[j], 'FROM')) return; // the FROM pass reads the table list
    // MySQL `DELETE t1, t2 FROM ...`, T-SQL `DELETE u FROM users u` / `DELETE users WHERE ...`
    const before = this.pending.length;
    this.scanTableList(j, this.levelEnd(s), false);
    for (let k = before; k < this.pending.length; k++) this.pending[k].target = true;
  }

  private mergeStatement(s: number): void {
    const t = this.t;
    const limit = this.levelEnd(s);
    let j = s + 1;
    if (isWord(t[j], 'TOP')) j = this.skipTop(j);
    if (isWord(t[j], 'INTO')) {
      this.role[j] = R_SKIP;
      j++;
    }
    j = this.parseTableItem(j, limit);
    const level = this.parent[s];
    while (j < limit) {
      if (this.parent[j] === level && isWord(t[j], 'USING')) break;
      j = isPunct(t[j], '(') ? this.groupEnd(j) + 1 : j + 1;
    }
    if (j < limit) {
      this.role[j] = R_SKIP;
      this.parseTableItem(j + 1, limit);
    }
    this.drainRegions();
  }

  /** TRUNCATE/LOCK/COPY/DROP/ALTER/CREATE: record the tables they name. */
  private ddlStatement(s: number): void {
    const t = this.t;
    const v = t[s].value;
    const limit = this.levelEnd(s);
    let j = s + 1;
    if (v === 'COPY') {
      if (isName(t[j]) && !(t[j].type === 'word' && SQL_KEYWORDS.has(t[j].value))) {
        this.addTable(this.readName(j).parts, false);
      }
      return;
    }
    if (v === 'TRUNCATE' || v === 'LOCK') {
      if (isWord(t[j], 'TABLE') || isWord(t[j], 'TABLES')) j++;
    } else {
      const stop = Math.min(limit, j + 6);
      while (j < stop && !isWord(t[j], 'TABLE')) j++;
      if (j >= stop) return;
      j++;
    }
    if (isWord(t[j], 'IF')) {
      j++;
      if (isWord(t[j], 'NOT')) j++;
      if (isWord(t[j], 'EXISTS')) j++;
    }
    if (isWord(t[j], 'ONLY')) j++;
    for (;;) {
      const tok = t[j];
      if (!isName(tok) || (tok.type === 'word' && SQL_KEYWORDS.has(tok.value))) return;
      const nm = this.readName(j);
      this.addTable(nm.parts, false);
      j = nm.next;
      if (!isPunct(t[j], ',')) return;
      j++;
    }
  }

  /**
   * Scan a table list (after FROM, UPDATE, DELETE or USING) between `start` and
   * `limit`: comma-separated items, JOIN/APPLY items and their ON conditions,
   * until a clause keyword at this level ends the list.
   */
  private scanTableList(start: number, limit: number, isUpdate: boolean): void {
    this.scanRegion(start, limit, isUpdate);
    this.drainRegions();
  }

  /** Scan queued regions (parenthesized joins) until none are left. */
  private drainRegions(): void {
    const q = this.regions;
    while (q.length > 0) {
      const isUpdate = q.pop() === 1;
      const limit = q.pop() as number;
      const start = q.pop() as number;
      this.scanRegion(start, limit, isUpdate);
    }
  }

  private scanRegion(start: number, limit: number, isUpdate: boolean): void {
    const t = this.t;
    let k = start;
    let expectItem = true;
    let joinItem = false;
    while (k < limit) {
      if (expectItem) {
        expectItem = false;
        const next = this.parseTableItem(k, limit);
        if (next > k) {
          k = next;
          continue;
        }
      }
      const tok = t[k];
      if (tok.type === 'punct') {
        if (tok.value === ',') {
          expectItem = true;
          joinItem = false;
          k++;
        } else if (tok.value === '(' || tok.value === '[') {
          k = this.groupEnd(k) + 1;
        } else {
          k++;
        }
        continue;
      }
      if (tok.type === 'word' && this.role[k] === R_NONE && !this.prevIsDot(k)) {
        const v = tok.value;
        if (v === 'JOIN' || v === 'APPLY' || v === 'STRAIGHT_JOIN') {
          this.role[k] = R_SKIP;
          expectItem = true;
          joinItem = true;
          k++;
          continue;
        }
        if (v === 'CASE') {
          const e = this.caseEnd[k];
          k = e > k ? e + 1 : k + 1;
          continue;
        }
        if (v === 'USING') {
          this.role[k] = R_SKIP;
          if (joinItem && isPunct(t[k + 1], '(')) {
            k = this.groupEnd(k + 1) + 1; // JOIN ... USING (col): columns, not tables
          } else {
            expectItem = true; // DELETE ... USING other_table
            joinItem = false;
            k++;
          }
          continue;
        }
        if (v === 'TABLESAMPLE') {
          this.role[k] = R_SKIP;
          if (t[k + 1] && t[k + 1].type === 'word') this.role[k + 1] = R_SKIP;
          k += 2;
          continue;
        }
        if (this.isRegionEnd(k, isUpdate)) return;
      }
      k++;
    }
  }

  private isRegionEnd(k: number, isUpdate: boolean): boolean {
    const t = this.t;
    const v = t[k].value;
    if (!REGION_END.has(v)) return false;
    const next = t[k + 1];
    switch (v) {
      case 'SET':
        return isUpdate;
      case 'FROM':
        return !this.isDistinctFrom(k);
      case 'GROUP':
        return !isWord(t[k - 1], 'WITHIN');
      case 'ON':
        return isWord(next, 'CONFLICT') || isWord(next, 'DUPLICATE');
      case 'FOR':
        return !!next && next.type === 'word' && FOR_CLAUSE.has(next.value);
      case 'WITH':
        // Only a following CTE ends the list; WITH (NOLOCK) and `timestamp WITH TIME ZONE` do not.
        return (
          isWord(next, 'RECURSIVE') ||
          (isName(next) && !isWord(next, 'ORDINALITY') && (isWord(t[k + 2], 'AS') || isPunct(t[k + 2], '(')))
        );
      case 'LOCK':
        return isWord(next, 'IN');
      case 'PROCEDURE':
        return !!next && next.type === 'word';
      case 'OPTION':
        return isPunct(next, '(');
      default:
        return true;
    }
  }

  /**
   * Parse one table item at `k`: `[LATERAL|ONLY] name [alias]`, a derived table,
   * a parenthesized join or a table function. Returns the index after it (`k`
   * when there is no item here).
   */
  private parseTableItem(k: number, limit: number): number {
    const t = this.t;
    let j = k;
    while (j < limit && (isWord(t[j], 'LATERAL') || isWord(t[j], 'ONLY'))) {
      this.role[j] = R_SKIP;
      j++;
    }
    // ODBC outer join escape `{oj t1 LEFT JOIN t2 ON ...}` (MySQL, T-SQL): the
    // tables inside are read like any other join.
    if (j < limit && isOperator(t[j], '{')) {
      this.role[j] = R_SKIP;
      j++;
      if (j < limit && isWord(t[j], 'OJ')) this.role[j++] = R_SKIP;
    }
    if (j >= limit) return j;
    const tok = t[j];
    if (isPunct(tok, '(')) {
      const close = this.groupEnd(j);
      // Derived tables are read by the passes that see their own FROM; a
      // parenthesized join is a table list of its own.
      if (!this.groupIsQuery(j)) this.regions.push(j + 1, close, 0);
      return this.parseAlias(Math.min(close + 1, limit), limit, true, null);
    }
    if (!isName(tok) || (tok.type === 'word' && NOT_TABLE_START.has(tok.value))) return j;
    const nm = this.readName(j);
    let after = nm.next;
    if (after < limit && isPunct(t[after], '(') && !this.isHintGroup(after)) {
      // Table function: generate_series(...), unnest(...), json_each(...), dblink(...)
      for (const p of nm.parts) if (p >= 0) this.role[p] = R_FUNC;
      after = this.groupEnd(after) + 1;
      if (isWord(t[after], 'WITH') && isWord(t[after + 1], 'ORDINALITY')) after += 2;
      return this.parseAlias(Math.min(after, limit), limit, true, null);
    }
    const p = this.addTable(nm.parts, false);
    if (after < limit && isPunct(t[after], '(')) after = this.groupEnd(after) + 1; // FROM t (NOLOCK)
    return this.parseAlias(Math.min(after, limit), limit, true, p);
  }

  /** The deprecated T-SQL hint form `FROM t (NOLOCK)`: a group holding only table hints. */
  private isHintGroup(o: number): boolean {
    if (this.dialect !== 'mssql' && this.dialect !== 'generic') return false;
    const t = this.t;
    const close = this.groupEnd(o);
    if (close <= o + 1) return false;
    for (let k = o + 1; k < close; k++) {
      const tok = t[k];
      if (isPunct(tok, ',')) continue;
      if (tok.type === 'word' && TABLE_HINTS.has(tok.value)) continue;
      if (isPunct(tok, '(') && isWord(t[k - 1], 'INDEX')) {
        k = this.groupEnd(k);
        continue;
      }
      return false;
    }
    return true;
  }

  /** Parse `[AS] alias [(col, ...)]` at `j`. */
  private parseAlias(j: number, limit: number, allowColumns: boolean, p: PendingTable | null): number {
    const t = this.t;
    if (j >= limit) return j;
    const tok = t[j];
    let a = -1;
    if (isWord(tok, 'AS')) {
      if (j + 1 >= limit || !isName(t[j + 1])) return j;
      this.role[j] = R_SKIP;
      a = j + 1;
    } else if (tok.type === 'quoted') {
      a = j;
    } else if (tok.type === 'word' && !SQL_KEYWORDS.has(tok.value) && !isPunct(t[j + 1], '.')) {
      a = j;
    }
    if (a < 0) return j;
    this.markAlias(a);
    if (p) p.ref.alias = nameOf(t[a]);
    let k = a + 1;
    if (allowColumns && k < limit && isPunct(t[k], '(')) {
      if (!this.isHintGroup(k)) this.markColumnList(k); // T-SQL `FROM t x (NOLOCK)` is a hint, not columns
      k = this.groupEnd(k) + 1;
    }
    return Math.min(k, limit);
  }

  /** FROM clauses (not `IS DISTINCT FROM`, not `EXTRACT(x FROM y)` and other function arguments). */
  private fromPass(): void {
    const { role, parent } = this;
    for (const i of this.fromIdx) {
      if (role[i] !== R_NONE || this.prevIsDot(i)) continue;
      if (this.isDistinctFrom(i)) continue;
      const g = parent[i];
      if (g >= 0 && !this.groupIsQuery(g)) continue;
      role[i] = R_SKIP;
      this.scanTableList(i + 1, this.levelEnd(i), false);
    }
  }

  /** JOINs that no table list covered (defensive: every joined table is reported). */
  private joinFallbackPass(): void {
    const { t, role } = this;
    for (const i of this.joinIdx) {
      if (role[i] !== R_NONE || this.prevIsDot(i)) continue;
      const v = t[i].value;
      if (v === 'STRAIGHT_JOIN' && i > 0 && t[i - 1].type === 'word' && (t[i - 1].value === 'SELECT' || SELECT_MODIFIERS.has(t[i - 1].value))) {
        continue; // MySQL SELECT STRAIGHT_JOIN modifier
      }
      role[i] = R_SKIP;
      this.scanTableList(i + 1, this.levelEnd(i), false);
    }
  }

  /** `SELECT ... INTO t` (INSERT INTO and MERGE INTO are consumed by their statements). */
  private intoPass(): void {
    const { t, role } = this;
    for (const i of this.intoIdx) {
      if (role[i] !== R_NONE || this.prevIsDot(i)) continue;
      role[i] = R_SKIP;
      let j = i + 1;
      while (
        isWord(t[j], 'TEMP') ||
        isWord(t[j], 'TEMPORARY') ||
        isWord(t[j], 'UNLOGGED') ||
        isWord(t[j], 'TABLE') ||
        isWord(t[j], 'GLOBAL') ||
        isWord(t[j], 'LOCAL')
      ) {
        role[j] = R_SKIP;
        j++;
      }
      const tok = t[j];
      if (!isName(tok) || (tok.type === 'word' && SQL_KEYWORDS.has(tok.value))) continue; // INTO OUTFILE, INTO @var
      this.addTable(this.readName(j).parts, false);
    }
  }

  /** Local patterns: casts, collations, charsets, date-part arguments, named arguments, WINDOW names, ... */
  private miscPass(): void {
    const { t, role, parent, dialect } = this;
    for (const i of this.miscIdx) {
      const tok = t[i];
      if (tok.type === 'operator') {
        if (tok.value === '::') {
          this.skipName(i + 1);
        } else if (tok.value === '=>' && i > 0 && t[i - 1].type === 'word' && role[i - 1] === R_NONE) {
          role[i - 1] = R_SKIP; // named argument: make_interval(days => 3)
        }
        continue;
      }
      if (tok.type === 'string') {
        const w = t[i - 1];
        if (i > 0 && w.type === 'word' && role[i - 1] === R_NONE && !this.prevIsDot(i - 1)) {
          if (dialect === 'postgres') role[i - 1] = R_SKIP; // typed literal: inet '10.0.0.1'
          else if (dialect === 'mysql' && w.text.charCodeAt(0) === 95 && w.end === tok.start) role[i - 1] = R_SKIP; // _utf8mb4'x'
        }
        continue;
      }
      if (tok.type !== 'word' || role[i] !== R_NONE || this.prevIsDot(i)) continue;
      const v = tok.value;
      const next = t[i + 1];
      switch (v) {
        case 'COLLATE':
        case 'CONSTRAINT':
          this.skipName(i + 1);
          break;
        case 'USING':
          // CONVERT(x USING utf8mb4); table USING lists were consumed earlier
          if (next && !isPunct(next, '(') && role[i + 1] === R_NONE) this.skipName(i + 1);
          break;
        case 'ON':
          if (isWord(next, 'CONFLICT')) this.out.addAlias('excluded');
          break;
        case 'WINDOW':
          this.windowDefinitions(i);
          break;
        case 'OVER':
          if (isName(next) && role[i + 1] === R_NONE) role[i + 1] = R_SKIP; // OVER w
          break;
        case 'AGAINST':
          // MATCH (...) AGAINST ('x' IN NATURAL LANGUAGE MODE)
          if (isPunct(next, '(')) {
            const close = this.groupEnd(i + 1);
            for (let k = i + 2; k < close; k = this.skipGroup(k) + 1) if (t[k].type === 'word') role[k] = R_SKIP;
          }
          break;
        case 'COLUMNS':
          if (isPunct(next, '(') && parent[i] > 0 && (isWord(t[parent[i] - 1], 'JSON_TABLE') || isWord(t[parent[i] - 1], 'COLUMNS'))) {
            this.jsonTableColumns(i + 1);
          }
          break;
      }
    }
    // Functions whose arguments hold types or date parts
    for (const i of this.callIdx) {
      const tok = t[i];
      if (tok.type !== 'word' || role[i] !== R_NONE || this.prevIsDot(i)) continue;
      const v = tok.value;
      if (CAST_FUNCS.has(v)) this.castType(i + 1);
      else if (v === 'EXTRACT') this.firstArgument(i + 1, true);
      else if (DATEPART_FUNCS.has(v)) this.firstArgument(i + 1, false);
      else if (UNIT_FIRST_FUNCS.has(v) && (dialect === 'mysql' || dialect === 'generic')) this.firstArgument(i + 1, true);
      else if ((v === 'CONVERT' || v === 'TRY_CONVERT') && dialect === 'mssql') this.firstArgument(i + 1, true, true);
    }
  }

  /** `WINDOW w AS (...), w2 AS (...)`: window names are aliases. */
  private windowDefinitions(i: number): void {
    const t = this.t;
    this.role[i] = R_SKIP;
    let k = i + 1;
    while (isName(t[k])) {
      this.markAlias(k);
      k++;
      if (isWord(t[k], 'AS')) {
        this.role[k] = R_SKIP;
        k++;
      }
      if (isPunct(t[k], '(')) k = this.groupEnd(k) + 1;
      if (!isPunct(t[k], ',')) return;
      k++;
    }
  }

  /** JSON_TABLE(... COLUMNS (name type PATH '...', NESTED PATH '...' COLUMNS (...))). */
  private jsonTableColumns(o: number): void {
    const t = this.t;
    const close = this.groupEnd(o);
    let elementStart = o + 1;
    for (let k = o + 1; k < close; k = this.skipGroup(k) + 1) {
      const tok = t[k];
      if (isPunct(tok, ',')) {
        elementStart = k + 1;
      } else if (isName(tok) && this.role[k] === R_NONE) {
        // The nested COLUMNS keyword stays unmarked so its own list is handled when the pass reaches it.
        if (k === elementStart && !isWord(tok, 'NESTED')) this.markAlias(k);
        else if (!isWord(tok, 'COLUMNS')) this.role[k] = R_SKIP;
      }
    }
  }

  /** CAST(x AS type): everything after AS is a type. */
  private castType(o: number): void {
    const t = this.t;
    const close = this.groupEnd(o);
    for (let k = o + 1; k < close; k = this.skipGroup(k) + 1) {
      if (!isWord(t[k], 'AS')) continue;
      this.role[k] = R_SKIP;
      for (let m = k + 1; m < close; m = this.skipGroup(m) + 1) if (isName(t[m])) this.role[m] = R_SKIP;
      return;
    }
  }

  /** First argument of EXTRACT(part FROM x), DATEADD(part, ...), TIMESTAMPDIFF(unit, ...), CONVERT(type, ...). */
  private firstArgument(o: number, always: boolean, typeArgument = false): void {
    const t = this.t;
    const k = o + 1;
    const tok = t[k];
    if (!isName(tok)) return;
    const next = t[k + 1];
    if (!(isPunct(next, ',') || isWord(next, 'FROM') || (typeArgument && isPunct(next, '(')))) return;
    if (always || this.dialect === 'mssql' || (tok.type === 'word' && DATEPART_NAMES.has(tok.value))) {
      this.role[k] = R_SKIP;
    }
  }

  /** Select list of the SELECT at `s`: modifiers, `*`, implicit aliases. */
  private selectList(s: number): void {
    const t = this.t;
    const limit = this.levelEnd(s);
    let j = s + 1;
    while (j < limit && t[j].type === 'word') {
      const v = t[j].value;
      if (v === 'DISTINCT' && isWord(t[j + 1], 'ON') && isPunct(t[j + 2], '(')) {
        this.role[j + 1] = R_SKIP;
        j = this.groupEnd(j + 2) + 1;
        continue;
      }
      if (SELECT_MODIFIERS.has(v)) {
        this.role[j] = R_SKIP;
        j++;
        continue;
      }
      const next = t[j + 1];
      if (v === 'TOP' && next && (isPunct(next, '(') || next.type === 'number' || next.type === 'param')) {
        j = this.skipTop(j);
        continue;
      }
      break;
    }
    this.itemList(j, limit);
  }

  /**
   * Items of a select or RETURNING list. A bare `*` item is a star; a word that
   * ends an item and follows an operand (`count(*) total`, `a.b c`, `'x' y`) is
   * an implicit alias.
   */
  private itemList(start: number, limit: number): void {
    const { t, role } = this;
    let itemStart = start;
    let k = start;
    while (k < limit) {
      const tok = t[k];
      if (tok.type === 'punct') {
        if (tok.value === ',') {
          itemStart = k + 1;
          k++;
        } else if (tok.value === '(' || tok.value === '[') {
          k = this.groupEnd(k) + 1;
        } else {
          k++;
        }
        continue;
      }
      if (tok.type === 'word' && !this.prevIsDot(k)) {
        if (tok.value === 'CASE') {
          const e = this.caseEnd[k];
          k = e > k ? e + 1 : k + 1;
          continue;
        }
        if (this.isSelectEnd(k)) return;
      }
      if (tok.type === 'operator') {
        if (tok.value === '*' && k === itemStart && this.isItemEnd(k + 1, limit)) this.out.addStar('');
      } else if (
        k > itemStart &&
        isName(tok) &&
        role[k] === R_NONE &&
        (tok.type === 'quoted' || !SQL_KEYWORDS.has(tok.value)) &&
        !this.prevIsDot(k) &&
        !isPunct(t[k + 1], '.') &&
        this.isItemEnd(k + 1, limit) &&
        this.isOperandEnd(k - 1)
      ) {
        this.markAlias(k);
      }
      k++;
    }
  }

  private isSelectEnd(k: number): boolean {
    const t = this.t;
    const v = t[k].value;
    if (!SELECT_END.has(v)) return false;
    const next = t[k + 1];
    switch (v) {
      case 'FROM':
        return !this.isDistinctFrom(k);
      case 'GROUP':
        return !isWord(t[k - 1], 'WITHIN');
      case 'FOR':
        return !!next && next.type === 'word' && FOR_CLAUSE.has(next.value);
      case 'OPTION':
        return isPunct(next, '(');
      case 'LOCK':
        return isWord(next, 'IN');
      default:
        return true;
    }
  }

  private isItemEnd(k: number, limit: number): boolean {
    if (k >= limit) return true;
    const tok = this.t[k];
    if (isPunct(tok, ',')) return true;
    return tok.type === 'word' && !this.prevIsDot(k) && this.isSelectEnd(k);
  }

  /** Whether the token at `p` can end an operand (so a following word may be an alias). */
  private isOperandEnd(p: number): boolean {
    const tok = this.t[p];
    switch (tok.type) {
      case 'string':
      case 'number':
      case 'param':
      case 'quoted':
        return true;
      case 'punct':
        return tok.value === ')' || tok.value === ']';
      case 'word':
        return (
          this.prevIsDot(p) ||
          this.role[p] === R_SKIP ||
          !SQL_KEYWORDS.has(tok.value) ||
          VALUE_ENDERS.has(tok.value)
        );
      default:
        return false;
    }
  }

  private listPass(): void {
    const { t, role } = this;
    for (const i of this.listIdx) {
      if (role[i] !== R_NONE || this.prevIsDot(i)) continue;
      if (t[i].value === 'SELECT') this.selectList(i);
      else this.itemList(i + 1, this.levelEnd(i));
    }
  }

  /** `expr AS alias` wherever the structural passes did not already consume the AS. */
  private asPass(): void {
    const { t, role } = this;
    for (const i of this.asIdx) {
      if (role[i] !== R_NONE) continue;
      const next = t[i + 1];
      if (!isName(next) || role[i + 1] !== R_NONE) continue;
      if (next.type === 'word' && QUERY_HEADS.has(next.value)) continue; // CREATE TABLE x AS SELECT
      role[i] = R_SKIP;
      this.markAlias(i + 1);
      if (isPunct(t[i + 2], '(')) this.markColumnList(i + 2);
    }
  }

  /**
   * Uppercased name of the call whose last part is at `i`, with its qualifiers
   * (`PG_CATALOG.PG_SLEEP`), so qualified block patterns such as `DBMS_*` match.
   */
  private callName(i: number): string {
    const t = this.t;
    let name = t[i].value.toUpperCase();
    for (let k = i; k >= 2 && isPunct(t[k - 1], '.') && isName(t[k - 2]); k -= 2) {
      name = `${t[k - 2].value.toUpperCase()}.${name}`;
    }
    return name;
  }

  /** Function calls: a name followed by `(` that no earlier pass explained. */
  private functionPass(): void {
    const { t, role } = this;
    for (const i of this.callIdx) {
      const tok = t[i];
      const r = role[i];
      if (r === R_FUNC) {
        this.out.addFunction(this.callName(i));
        continue;
      }
      if (r !== R_NONE || (tok.type === 'word' && NON_FUNCTION.has(tok.value))) continue;
      if (isWord(tok, 'INSERT') && isWord(t[i - 1], 'THEN')) continue; // MERGE ... THEN INSERT (cols)
      role[i] = R_FUNC;
      this.out.addFunction(this.callName(i));
      for (let k = i; k >= 2 && isPunct(t[k - 1], '.') && isName(t[k - 2]); k -= 2) {
        role[k - 1] = R_FUNC;
        role[k - 2] = R_FUNC;
      }
    }
  }

  /** Qualified column references `a.b`, `s.t.c` and qualified stars `t.*`. */
  private qualifiedPass(): void {
    const { t, role } = this;
    for (const i of this.qualIdx) {
      const tok = t[i];
      if (role[i] !== R_NONE || this.prevIsDot(i)) continue;
      let last = i;
      let k = i + 1;
      let star = false;
      while (isPunct(t[k], '.')) {
        const next = t[k + 1];
        if (isName(next) && role[k + 1] === R_NONE) {
          last = k + 1;
          k += 2;
          continue;
        }
        if (next && next.type === 'operator' && next.value === '*') star = true;
        break;
      }
      if (star) {
        this.out.addStar(nameOf(t[last]));
        for (let m = i; m <= last; m++) role[m] = R_COLREF;
        role[k] = R_COLREF;
        role[k + 1] = R_COLREF;
        continue;
      }
      if (last === i || isPunct(t[last + 1], '(')) continue;
      const nameTok = t[last];
      this.out.qualified.push({
        name: nameOf(nameTok),
        qualifier: nameOf(t[last - 2]),
        quoted: nameTok.type === 'quoted',
        start: tok.start,
        end: nameTok.end,
      });
      for (let m = i; m <= last; m++) role[m] = R_COLREF;
    }
  }

  /** Run every pass except the bare-column one. Returns the main statement keyword of this statement. */
  run(): string | null {
    const { t, n } = this;
    for (const i of this.withIdx) {
      if (this.role[i] !== R_NONE) continue;
      const m = this.parseWith(i);
      if (m >= 0) this.withMain.set(i, m);
    }

    const head = n > 0 ? this.dispatch(0) : null;
    for (const i of this.parenIdx) {
      const k = i + 1;
      const tok = t[k];
      if (!tok || tok.type !== 'word') continue;
      if (STATEMENT_KEYWORDS.has(tok.value) && this.isStatementUse(k)) {
        this.out.nestedStatements.push({ keyword: tok.value, start: tok.start });
      }
      if (tok.value === 'WITH' || this.isQueryHead(k)) this.dispatch(k);
    }
    for (const [w, m] of this.withMain) {
      let j = m;
      while (j < n && isPunct(t[j], '(')) j++;
      if (this.parent[w] >= 0 && j < n && t[j].type === 'word' && STATEMENT_KEYWORDS.has(t[j].value)) {
        this.out.nestedStatements.push({ keyword: t[j].value, start: t[j].start });
      }
      this.dispatch(m);
    }

    this.fromPass();
    this.joinFallbackPass();
    this.intoPass();
    this.miscPass();
    this.listPass();
    this.asPass();
    this.functionPass();
    this.qualifiedPass();
    return head;
  }

  /** Move table references to the output, dropping CTE references and UPDATE/DELETE targets that are aliases. */
  finishTables(): void {
    const scopesByName = new Map<string, CteScope[]>();
    for (const s of this.scopes) {
      const list = scopesByName.get(s.key);
      if (list) list.push(s);
      else scopesByName.set(s.key, [s]);
    }
    for (const p of this.pending) {
      const ref = p.ref;
      if (ref.schema === undefined && ref.catalog === undefined) {
        const scopes = scopesByName.size > 0 ? scopesByName.get(this.foldName(this.t[p.index])) : undefined;
        let isCte = false;
        if (scopes) {
          for (const s of scopes) {
            if (p.index >= s.from && p.index < s.to) {
              isCte = true;
              break;
            }
          }
        }
        if (isCte) continue;
        if (p.target && this.out.aliasKeys.has(ref.name.toUpperCase())) continue;
      }
      this.out.tables.push(ref);
    }
  }

  /** Bare-word column candidates (see the design rules in docs/design/v0.1.0.md, section 5.1). */
  collectCandidates(excluded: ReadonlySet<string>): void {
    const { t, role } = this;
    for (const i of this.nameIdx) {
      const tok = t[i];
      if (role[i] !== R_NONE) continue;
      if (tok.type === 'word') {
        if (SQL_KEYWORDS.has(tok.value) || tok.value.charCodeAt(0) === 35 /* # */) continue;
      } else if (tok.type !== 'quoted') {
        continue;
      }
      if (this.prevIsDot(i) || isPunct(t[i + 1], '.') || isPunct(t[i + 1], '(')) continue;
      const key = tok.type === 'word' ? tok.value : tok.value.toUpperCase();
      if (this.out.aliasKeys.has(key) || excluded.has(key)) continue;
      this.out.bare.push({ name: nameOf(tok), quoted: tok.type === 'quoted', start: tok.start, end: tok.end });
    }
  }
}

const byStart = (a: { start: number }, b: { start: number }): number => a.start - b.start;

/** Merge two lists that are each sorted by `start`. */
function mergeByStart<T extends { start: number }>(a: T[], b: T[]): T[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out: T[] = new Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < a.length && j < b.length) out[k++] = a[i].start <= b[j].start ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/**
 * Lex and analyze SQL: statements, operation, tables, CTEs, aliases, columns,
 * stars, functions and nested statements. The analysis never executes or
 * fully parses SQL; it is a conservative, token-based reading.
 *
 * @param sql - SQL text
 * @param dialect - Dialect used for lexing and dialect-specific rules. Default `generic`.
 * @param options - Lexer options (MySQL backslash escapes)
 * @throws SqlLexError when the SQL has an unterminated string, quoted identifier or comment
 */
export function analyzeSql(sql: string, dialect: SqlDialect = 'generic', options: LexOptions = {}): SqlAnalysis {
  const tokens = tokenize(sql, dialect, options);
  const statements = splitStatements(tokens);
  let hasComments = false;
  for (const tok of tokens) {
    if (tok.type === 'comment') {
      hasComments = true;
      break;
    }
  }

  const out = new Collector();
  const analyzers = statements.map((st) => new StatementAnalyzer(st, dialect, out));
  let operation: QueryOperation | null = null;
  for (let i = 0; i < analyzers.length; i++) {
    const head = analyzers[i].run();
    if (i === 0 && head !== null) operation = OPERATIONS.get(head) ?? null;
  }
  for (const a of analyzers) a.finishTables();

  // Whole-row references (`to_jsonb(users)`) and CTE names are not columns.
  const excluded = new Set<string>();
  for (const ref of out.tables) excluded.add(ref.name.toUpperCase());
  for (const name of out.cteNames) excluded.add(name.toUpperCase());
  for (const a of analyzers) a.collectCandidates(excluded);

  out.tables.sort(byStart);
  // Both lists are already in source order unless there were several statements.
  const columns =
    analyzers.length === 1 ? mergeByStart(out.qualified, out.bare) : out.qualified.concat(out.bare).sort(byStart);
  out.nestedStatements.sort(byStart);

  return {
    dialect,
    tokens,
    statements,
    hasComments,
    operation,
    tables: out.tables,
    cteNames: out.cteNames,
    aliases: out.aliases,
    columns,
    starQualifiers: out.starQualifiers,
    functions: out.functions,
    nestedStatements: out.nestedStatements,
  };
}
