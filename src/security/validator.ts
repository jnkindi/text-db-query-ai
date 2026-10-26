import {
  SecurityConfig,
  UserContext,
  QueryOperation,
  DatabaseType,
  DatabaseSchema,
  TableSchema,
  TextToQueryError,
} from '../types';
import {
  analyzeSql,
  tokenize,
  toSqlDialect,
  significantTokens,
  isBlockedFunction,
  formatIdentifier,
  sqlReadings,
  SqlLexError,
  type LexOptions,
  type SqlAnalysis,
  type SqlDialect,
  type TableReference,
  type Token,
} from '../sql';
import {
  applyEdits,
  branchesOf,
  findRowLimits,
  isNameToken,
  isPunctAt,
  isQueryGroup,
  isWordAt,
  mainIndex,
  nameOf,
  queryScopes,
  shapeOf,
  skipWith,
  type Shape,
  type TextEdit,
} from './sanitizer';

/**
 * Optional context that makes validation dialect- and schema-aware.
 */
export interface SecurityValidatorOptions {
  /** SQL dialect used to tokenize queries. Default: the schema's databaseType, else a generic dialect. */
  databaseType?: DatabaseType;
  /** Schema used to expand `*` for restricted/sensitive column checks and to qualify RLS filters. */
  schema?: DatabaseSchema;
}

const words = (s: string): ReadonlySet<string> => new Set(s.trim().split(/\s+/));

const MULTIPLE_STATEMENTS = 'Multiple statements detected';
const AMBIGUOUS_ESCAPING = 'ambiguous string escaping';

/** Pattern names in the order they are reported: the 0.0.1 names first, as 0.0.1 ordered them. */
const PATTERN_ORDER: readonly string[] = [
  MULTIPLE_STATEMENTS, 'EXEC', 'EXECUTE', 'xp_cmdshell', 'sp_executesql', 'UNION.*SELECT',
  '--', '/*', '#', 'DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE',
];
const PATTERN_ORDER_SET: ReadonlySet<string> = new Set(PATTERN_ORDER);

/** Statement keywords that 0.0.1 reported under their own name. */
const LEGACY_STATEMENT_PATTERNS = words('EXEC EXECUTE DROP TRUNCATE ALTER CREATE GRANT REVOKE');
const DML_OPERATIONS = words('INSERT UPDATE DELETE');

/**
 * T-SQL statements that can follow another statement without a `;`
 * (`SELECT 1 DELETE FROM t`). Checked on mssql and on generic, which may be
 * talking to SQL Server.
 */
const TSQL_STATEMENTS = words(`
  INSERT UPDATE DELETE MERGE DROP CREATE ALTER TRUNCATE GRANT REVOKE DENY EXEC EXECUTE WAITFOR
  SHUTDOWN KILL BACKUP RESTORE DECLARE SET USE DBCC BULK RECONFIGURE CHECKPOINT REVERT SETUSER
  BEGIN COMMIT ROLLBACK IF WHILE READTEXT WRITETEXT UPDATETEXT
`);
/** Words after which no T-SQL statement can start: the next word is an operand or part of the clause. */
const NO_STATEMENT_AFTER = words(`
  SELECT DISTINCT ALL TOP WHERE AND OR NOT ON BY FROM JOIN AS IN IS LIKE ILIKE BETWEEN THEN ELSE
  WHEN CASE SET INTO VALUES HAVING UNION INTERSECT EXCEPT EXISTS ANY SOME OVER PARTITION ORDER
  GROUP INNER LEFT RIGHT FULL OUTER CROSS APPLY FOR OPTION WITH ESCAPE COLLATE DO KEY USING TABLE
  OFFSET FETCH NEXT LIMIT UPDATE INSERT DELETE CHARACTER CHARSET INTERVAL AT DUPLICATE RETURNING
`);
/** T-SQL statements that are complete without any argument. */
const TSQL_COMPLETE_ALONE = words('COMMIT ROLLBACK SHUTDOWN CHECKPOINT RECONFIGURE REVERT SETUSER');

/** Words before INTO in `INSERT [modifiers] INTO`, `MERGE TOP (n) INTO`, `INSERT OR IGNORE INTO`. */
const INTO_PREFIX_WORDS = words('LOW_PRIORITY DELAYED HIGH_PRIORITY IGNORE OR ROLLBACK ABORT FAIL TOP');
const DML_INTO_HEADS = words('INSERT REPLACE MERGE UPSERT');

const FOR_CLAUSES = words('UPDATE SHARE NO KEY XML JSON BROWSE READ');
const PG_SYSTEM_TABLES = words('pg_shadow pg_authid pg_user_mapping pg_user_mappings');
const MSSQL_LOGIN_TABLES = words('sql_logins syslogins');

/** SELECT modifiers before the select list. */
const SELECT_MODIFIERS = words(`
  ALL DISTINCT DISTINCTROW HIGH_PRIORITY STRAIGHT_JOIN SQL_SMALL_RESULT SQL_BIG_RESULT
  SQL_BUFFER_RESULT SQL_NO_CACHE SQL_CACHE SQL_CALC_FOUND_ROWS
`);
/** Words that end a select list. */
const SELECT_LIST_END = words(`
  FROM INTO WHERE GROUP HAVING ORDER LIMIT OFFSET FETCH UNION INTERSECT EXCEPT WINDOW FOR
  RETURNING OPTION
`);

const BACKSLASH = /\\/g;
const SINGLE_QUOTE = /'/g;

/**
 * Second reading (lexed as mysql with these options) for dialects where a
 * backslash in a string may or may not escape the quote: MySQL without
 * NO_BACKSLASH_ESCAPES, and generic, which may be talking to MySQL.
 */
const ALTERNATE_READING: Partial<Record<SqlDialect, LexOptions>> = {
  mysql: { backslashEscapes: false },
  generic: { backslashEscapes: true },
};

/** A configured `table.column` (restricted) or a schema column marked sensitive. */
interface ColumnRule {
  entry: string;
  /** Uppercased table name. */
  table: string;
  /** Uppercased schema, when the entry names one. */
  schema?: string;
  sensitive: boolean;
}

/** Config compiled once per validator. */
interface Rules {
  /** Bare restricted column (uppercased) -> the configured entry. */
  restrictedBare: Map<string, string>;
  /** Uppercased column -> table-specific rules for it. */
  byColumn: Map<string, ColumnRule[]>;
  restrictedOrder: string[];
  sensitiveOrder: string[];
  /** Lowercased allowedTables entries, or null when every table is allowed. */
  allowedTables: Set<string> | null;
  /** Lowercased table name -> schema tables with that name. */
  schemaTables: Map<string, TableSchema[]>;
}

/** One query, lexed and analyzed once, shared by every check. */
interface QueryContext {
  analysis: SqlAnalysis;
  shapes: Shape[];
  /** The query reads differently with and without backslash escapes. */
  ambiguous: boolean;
  /** Uppercased alias or table name -> the base tables it names (built lazily). */
  refIndex?: Map<string, TableReference[]>;
  /** Whether a table-specific column rule's table appears anywhere in the query (memoized per rule). */
  ruleTableSeen?: Map<ColumnRule, boolean>;
}

interface RlsColumn {
  /** Text inserted into the query. */
  text: string;
  /** Identifier name (quotes removed). */
  name: string;
  quoted: boolean;
}

/** A table reference located in a statement. */
interface LocatedTable {
  ref: TableReference;
  /** Token index of the first part of its name. */
  index: number;
  /** Token index of the alias being defined, or -1. */
  aliasIndex: number;
  /** `t AS x(a, b)`: the alias renames the table's columns, so any of them can be read by position. */
  renamesColumns: boolean;
}

interface RlsState {
  sql: string;
  shape: Shape;
  tables: LocatedTable[];
  column: RlsColumn;
  value: string;
  valueType: 'number' | 'string';
  edits: TextEdit[];
  /** Token indexes of tables a WHERE filter covers; every other user table is wrapped. */
  handled: Set<number>;
}

/** Alias of the table inside the filtered derived table that replaces a user table. */
const RLS_ALIAS = '__rls';

const EMPTY_COLUMNS = { restricted: [] as string[], sensitive: [] as string[] };

const eqi = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toUpperCase() === b.toUpperCase();

/** End offsets of the strings, quoted identifiers and comments of a token list. */
/**
 * A client placeholder (`?`, `?1`, `$1`, `:name`, optionally in parentheses)
 * alone as a row count, not followed by PERCENT. `@name` and `@@name` are
 * server variables (`@@TEXTSIZE` is 2147483647), not values the application binds.
 */
function isLoneParam(t: Token[], i: number): boolean {
  let k = i;
  if (isPunctAt(t, k, '(')) {
    if (!isPunctAt(t, k + 2, ')')) return false;
    k++;
  }
  const tok = t[k];
  if (!tok || tok.type !== 'param' || tok.text.startsWith('@')) return false;
  const next = t[isPunctAt(t, i, '(') ? k + 2 : k + 1];
  return !(next && (next.type === 'operator' || (next.type === 'word' && next.value === 'PERCENT')));
}

function literalEnds(tokens: Token[]): number[] {
  const out: number[] = [];
  for (const tok of tokens) {
    if (tok.type === 'string' || tok.type === 'quoted' || tok.type === 'comment') out.push(tok.end);
  }
  return out;
}

function hasBackslashInLiteral(tokens: Token[]): boolean {
  for (const tok of tokens) {
    if ((tok.type === 'string' || tok.type === 'quoted') && tok.text.indexOf('\\') >= 0) return true;
  }
  return false;
}

function commentPattern(tok: Token): string {
  if (tok.text.startsWith('--')) return '--';
  if (tok.text.charCodeAt(0) === 35 /* # */) return '#';
  return '/*';
}

/** The protected credential tables a query must never read, as `system table <name>`. */
function systemTable(ref: TableReference): string | null {
  const name = ref.name.toLowerCase();
  const schema = ref.schema?.toLowerCase();
  const full = schema ? `${schema}.${name}` : name;
  if (PG_SYSTEM_TABLES.has(name) && (schema === undefined || schema === 'pg_catalog')) return full;
  if (schema === 'mysql' && name === 'user') return full;
  if (MSSQL_LOGIN_TABLES.has(name) && (schema === 'sys' || (schema === undefined && name === 'syslogins'))) return full;
  return null;
}

/** `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE` at `i`, or null. */
function lockingClause(t: Token[], i: number): string | null {
  let j = i + 1;
  if (isWordAt(t, j, 'NO') && isWordAt(t, j + 1, 'KEY')) j += 2;
  else if (isWordAt(t, j, 'KEY')) j++;
  if (isWordAt(t, j, 'UPDATE')) return 'FOR UPDATE';
  if (isWordAt(t, j, 'SHARE')) return 'FOR SHARE';
  return null;
}

/** What the INTO at `i` does: null for `INSERT ... INTO` and `MERGE INTO`, else the pattern name. */
function intoPattern(s: Shape, i: number): string | null {
  const t = s.t;
  if (isWordAt(t, i + 1, 'OUTFILE')) return 'INTO OUTFILE';
  if (isWordAt(t, i + 1, 'DUMPFILE')) return 'INTO DUMPFILE';
  for (let k = i - 1; k >= 0; k--) {
    const tok = t[k];
    if (tok.type === 'punct' && tok.value === ')') {
      const o = s.pair[k];
      if (o > 0 && isWordAt(t, o - 1, 'TOP')) {
        k = o; // continue before TOP (...)
        continue;
      }
      break;
    }
    if (tok.type === 'number' && isWordAt(t, k - 1, 'TOP')) continue;
    if (tok.type !== 'word') break;
    if (DML_INTO_HEADS.has(tok.value)) return null;
    if (!INTO_PREFIX_WORDS.has(tok.value)) break;
  }
  return 'SELECT INTO';
}

/** Index of the SELECT's FROM at depth `d` in `[from, end)`, skipping `IS [NOT] DISTINCT FROM`; -1 if none. */
function fromAt(s: Shape, from: number, end: number, d: number): number {
  const t = s.t;
  for (let i = from; i < end; i++) {
    if (s.depth[i] !== d || !isWordAt(t, i, 'FROM')) continue;
    if (isWordAt(t, i - 1, 'DISTINCT') && (isWordAt(t, i - 2, 'IS') || isWordAt(t, i - 2, 'NOT'))) continue;
    return i;
  }
  return -1;
}

/** Whether the token at `i` starts a clause that ends a WHERE condition (or the FROM list) of a `head` statement. */
function isClauseBoundary(t: Token[], i: number, head: string): boolean {
  const tok = t[i];
  if (tok.type !== 'word' || !isWordAt(t, i, tok.value)) return false;
  const next = t[i + 1];
  switch (tok.value) {
    case 'GROUP':
      return isWordAt(t, i + 1, 'BY') && !isWordAt(t, i - 1, 'WITHIN');
    case 'ORDER':
      return isWordAt(t, i + 1, 'BY');
    case 'HAVING':
    case 'QUALIFY':
      return head === 'SELECT';
    case 'WINDOW':
      return head === 'SELECT' && isNameToken(next) && isWordAt(t, i + 2, 'AS');
    case 'LIMIT':
    case 'OFFSET':
      return (
        !!next &&
        (next.type === 'number' ||
          next.type === 'param' ||
          isPunctAt(t, i + 1, '(') ||
          (next.type === 'operator' && (next.value === '-' || next.value === '+')) ||
          (tok.value === 'LIMIT' && isWordAt(t, i + 1, 'ALL')))
      );
    case 'FETCH':
      return isWordAt(t, i + 1, 'FIRST') || isWordAt(t, i + 1, 'NEXT');
    case 'FOR':
      return !!next && next.type === 'word' && FOR_CLAUSES.has(next.value);
    case 'RETURNING':
      return (
        !!next &&
        (isNameToken(next) ||
          next.type === 'number' ||
          next.type === 'string' ||
          next.type === 'param' ||
          isPunctAt(t, i + 1, '(') ||
          (next.type === 'operator' && next.value === '*'))
      );
    case 'OPTION':
      return isPunctAt(t, i + 1, '(');
    case 'LOCK':
      return isWordAt(t, i + 1, 'IN');
    case 'INTO':
      return head === 'SELECT';
    default:
      return false;
  }
}

/** Index after the select modifiers (DISTINCT, DISTINCT ON (...), TOP n, ...) of the SELECT at `i`. */
function selectListStart(s: Shape, i: number): number {
  const t = s.t;
  let j = i + 1;
  for (;;) {
    const tok = t[j];
    if (!tok || tok.type !== 'word') return j;
    if (tok.value === 'DISTINCT' && isWordAt(t, j + 1, 'ON') && isPunctAt(t, j + 2, '(')) {
      j = s.pair[j + 2] > 0 ? s.pair[j + 2] + 1 : j + 3;
      continue;
    }
    if (SELECT_MODIFIERS.has(tok.value)) {
      j++;
      continue;
    }
    if (tok.value === 'TOP') {
      j++;
      if (isPunctAt(t, j, '(') && s.pair[j] > 0) j = s.pair[j] + 1;
      else if (t[j] && (t[j].type === 'number' || t[j].type === 'param')) j++;
      if (isWordAt(t, j, 'PERCENT')) j++;
      if (isWordAt(t, j, 'WITH') && isWordAt(t, j + 1, 'TIES')) j += 2;
      continue;
    }
    return j;
  }
}

/** Token indexes of bare `*` items in select lists and RETURNING lists (nested groups are skipped). */
function bareStars(s: Shape): number[] {
  const { t, depth, pair } = s;
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const isSelect = isWordAt(t, i, 'SELECT');
    if (!isSelect && !isWordAt(t, i, 'RETURNING')) continue;
    const d = depth[i];
    let k = isSelect ? selectListStart(s, i) : i + 1;
    let itemStart = k;
    for (; k < t.length; k++) {
      if (depth[k] < d) break;
      const tok = t[k];
      if (tok.type === 'punct') {
        if (tok.value === ',') itemStart = k + 1;
        else if ((tok.value === '(' || tok.value === '[') && pair[k] > k) k = pair[k];
        continue;
      }
      if (k === itemStart && tok.type === 'operator' && tok.value === '*') {
        const nx = t[k + 1];
        if (!nx || nx.type === 'word' || isPunctAt(t, k + 1, ',') || isPunctAt(t, k + 1, ')')) out.push(k);
        continue;
      }
      if (tok.type === 'word' && SELECT_LIST_END.has(tok.value) && isWordAt(t, k, tok.value)) break;
    }
  }
  return out;
}

/** Locate the base tables of statement `s` (tables are sorted by start offset). */
function locateTables(s: Shape, tables: TableReference[]): LocatedTable[] {
  const t = s.t;
  const out: LocatedTable[] = [];
  if (t.length === 0) return out;
  const first = t[0].start;
  const last = t[t.length - 1].end;
  let i = 0;
  for (const ref of tables) {
    if (ref.start < first || ref.start >= last) continue;
    while (i < t.length && t[i].start < ref.start) i++;
    if (i >= t.length) break;
    let aliasIndex = -1;
    if (ref.alias !== undefined) {
      let e = i;
      while (e < t.length && t[e].end < ref.end) e++;
      let k = e + 1;
      if (isWordAt(t, k, 'AS')) k++;
      if (isNameToken(t[k]) && nameOf(t[k]) === ref.alias) aliasIndex = k;
    }
    out.push({ ref, index: i, aliasIndex, renamesColumns: aliasIndex >= 0 && isPunctAt(t, aliasIndex + 1, '(') });
  }
  return out;
}

/**
 * Security validator for database queries
 */
export class SecurityValidator {
  private config: SecurityConfig;
  private options: SecurityValidatorOptions;
  private readonly dialect: SqlDialect;
  private readonly rules: Rules;
  private rlsColumnCache?: RlsColumn;
  /** Generic dialect only: one validator per database the query may run on (built on first use). */
  private readingValidators?: SecurityValidator[];

  constructor(config: SecurityConfig = {}, options: SecurityValidatorOptions = {}) {
    this.options = options;
    this.config = {
      allowedOperations: ['SELECT'],
      allowedTables: [],
      restrictedColumns: [],
      maxRowLimit: 1000,
      requireUserContext: true,
      enableRowLevelSecurity: true,
      ...config,
    };
    this.dialect = toSqlDialect(options.databaseType ?? options.schema?.databaseType);
    this.rules = this.compileRules();
  }

  /**
   * Validate a query against security rules.
   *
   * The query is tokenized once (twice for MySQL and the generic dialect when
   * a string contains a backslash, to compare both escaping modes) and every
   * check reads that analysis. Names, quoted identifiers, strings and comments
   * never match keyword checks.
   */
  async validate(
    query: string,
    userContext?: UserContext
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check if user context is required
    if (this.config.requireUserContext && !userContext) {
      errors.push('User context is required but not provided');
      return { valid: false, errors, warnings };
    }

    // Tokenize; any lexer failure is a rejection
    const ctx = this.lex(query);
    if (typeof ctx === 'string') {
      errors.push(ctx);
      return { valid: false, errors, warnings };
    }

    // Detect query operation
    const operation = this.detectOperation(ctx);
    if (!operation) {
      errors.push('Could not determine query operation');
      return { valid: false, errors, warnings };
    }

    // Check if operation is allowed
    if (
      this.config.allowedOperations &&
      !this.config.allowedOperations.includes(operation)
    ) {
      errors.push(
        `Operation ${operation} is not allowed. Allowed operations: ${this.config.allowedOperations.join(', ')}`
      );
    }

    // Check for dangerous patterns
    const dangerousPatterns = this.detectDangerousPatterns(ctx);
    if (dangerousPatterns.length > 0) {
      errors.push(
        `Query contains dangerous patterns: ${dangerousPatterns.join(', ')}`
      );
    }

    // Unbalanced parentheses would make row-level security unreliable
    if (ctx.shapes.some((s) => !s.balanced)) {
      errors.push('Malformed SQL: Unbalanced parentheses');
    }

    // Check for restricted and sensitive columns
    const columns = this.findRestrictedColumns(ctx);
    if (columns.restricted.length > 0) {
      errors.push(
        `Query accesses restricted columns: ${columns.restricted.join(', ')}`
      );
    }
    if (columns.sensitive.length > 0) {
      const message = `Query accesses sensitive columns: ${columns.sensitive.join(', ')}`;
      if (this.config.enforceSensitiveColumns) errors.push(message);
      else warnings.push(message);
    }

    // Check for table restrictions
    if (this.config.allowedTables && this.config.allowedTables.length > 0) {
      const unauthorizedTables = this.extractTableNames(ctx);
      if (unauthorizedTables.length > 0) {
        errors.push(
          `Query accesses unauthorized tables: ${unauthorizedTables.join(', ')}`
        );
      }
    }

    // Check for row limit in SELECT queries (top level only)
    if (operation === 'SELECT') {
      this.checkRowLimit(ctx, errors, warnings);
    }

    // Without a database type the query may run on any database, so it must also
    // pass as each one reads it: T-SQL [a'] identifiers, for one, hide code from
    // the generic reading. Only consulted when the generic checks pass, so the
    // messages of a rejected query do not change.
    if (this.dialect === 'generic' && errors.length === 0) {
      for (const v of this.databaseValidators()) {
        const r = await v.validate(query, userContext);
        for (const e of r.errors) if (!errors.includes(e)) errors.push(e);
      }
    }

    // Run custom validator if provided
    if (this.config.customValidator) {
      try {
        const customValid = await this.config.customValidator(
          query,
          userContext
        );
        if (!customValid) {
          errors.push('Custom validation failed');
        }
      } catch (error: any) {
        errors.push(`Custom validation error: ${error.message}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validators with this configuration for every database in sqlReadings('generic')
   * (the mysql one compares both backslash modes itself). They skip the user
   * context requirement and customValidator, which validate() handles once.
   */
  private databaseValidators(): SecurityValidator[] {
    if (!this.readingValidators) {
      const { customValidator: _custom, ...config } = this.config;
      const dialects = [...new Set(sqlReadings('generic').map((r) => r.dialect))];
      this.readingValidators = dialects.map(
        (databaseType) =>
          new SecurityValidator({ ...config, requireUserContext: false }, { ...this.options, databaseType })
      );
    }
    return this.readingValidators;
  }

  /**
   * Add row-level security filter to query.
   *
   * Adds `col = <user id>` (column `rowLevelSecurityColumn`, default
   * `user_id`) to the WHERE clause of the main SELECT, UPDATE or DELETE and of
   * every top-level UNION/INTERSECT/EXCEPT branch, before GROUP BY, ORDER BY,
   * LIMIT and similar clauses. An existing condition with a top-level OR is
   * wrapped in parentheses. The filter is skipped only when the WHERE is an
   * AND-chain that already contains the same `col = value`. With several
   * tables the filter is qualified with the first table that has the column.
   * Queries that cannot be tokenized are returned unchanged (validation
   * rejects them).
   *
   * @throws TextToQueryError (SECURITY_VALIDATION_FAILED) when the user id is
   *   not a finite number or a string without NUL characters, or when
   *   rowLevelSecurityColumn is not a single identifier
   */
  addRowLevelSecurity(query: string, userContext: UserContext): string {
    if (!this.config.enableRowLevelSecurity || !userContext) {
      return query;
    }

    let analysis: SqlAnalysis;
    try {
      analysis = analyzeSql(query, this.dialect);
    } catch (error) {
      if (error instanceof SqlLexError) return query;
      throw error;
    }

    // SELECT, UPDATE and DELETE get a WHERE filter; INSERT only when it reads tables (INSERT ... SELECT)
    const operation = analysis.operation;
    if (operation !== 'SELECT' && operation !== 'UPDATE' && operation !== 'DELETE' && operation !== 'INSERT') {
      return query;
    }
    const shape = shapeOf(analysis.statements[0]);
    if (!shape.balanced) return query;
    const located = locateTables(shape, analysis.tables);
    let insertTarget = -1;
    if (operation === 'INSERT') {
      const main = mainIndex(shape);
      const target = located.find((l) => l.index > main);
      insertTarget = target ? target.index : -1;
      if (located.every((l) => l.index === insertTarget)) return query;
    }

    const column = this.rlsColumn();
    const userId: unknown = userContext.userId;
    const state: RlsState = {
      sql: query,
      shape,
      tables: located,
      column,
      value: this.rlsValue(userId),
      valueType: typeof userId === 'string' ? 'string' : 'number',
      edits: [],
      handled: new Set(insertTarget >= 0 ? [insertTarget] : []),
    };

    const t = shape.t;
    const work: Array<[number, number]> = operation === 'INSERT' ? [] : [[0, t.length]];
    while (work.length > 0) {
      const [start, end] = work.pop()!;
      let j = start;
      if (isWordAt(t, j, 'WITH')) {
        j = skipWith(shape, j);
        if (j < 0 || j >= end) continue;
      }
      for (const [bs, be] of branchesOf(shape, j, end)) {
        if (bs >= be) continue;
        if (isPunctAt(t, bs, '(')) {
          // A parenthesized branch: filter the query inside it
          const close = shape.pair[bs];
          if (close > bs && close < be) work.push([bs + 1, close]);
          continue;
        }
        const head = t[bs];
        if (head.type !== 'word') continue;
        if (head.value === 'SELECT' || head.value === 'UPDATE' || head.value === 'DELETE') {
          this.filterBranch(state, bs, be);
        } else if (head.value === 'TABLE') {
          this.filterTableBranch(state, bs, be);
        }
        // VALUES branches hold no rows of any table
      }
    }
    this.wrapUserTables(state);
    return applyEdits(query, state.edits);
  }

  /**
   * Detect the query operation type: the main statement of the first
   * statement, past a WITH clause and leading parentheses.
   */
  private detectOperation(ctx: QueryContext): QueryOperation | null {
    return ctx.analysis.operation;
  }

  /**
   * Detect dangerous SQL patterns. Keywords are matched as tokens at the
   * positions where they act (statement starts, clauses), never as substrings.
   */
  private detectDangerousPatterns(ctx: QueryContext): string[] {
    const found = new Set<string>();
    const { analysis } = ctx;

    if (analysis.statements.length > 1) found.add(MULTIPLE_STATEMENTS);
    if (ctx.ambiguous) found.add(AMBIGUOUS_ESCAPING);
    if (analysis.hasComments) {
      for (const tok of analysis.tokens) if (tok.type === 'comment') found.add(commentPattern(tok));
    }

    for (let si = 0; si < ctx.shapes.length; si++) this.scanStatement(ctx.shapes[si], si, found);

    for (const nested of analysis.nestedStatements) {
      const kw = nested.keyword;
      if (LEGACY_STATEMENT_PATTERNS.has(kw)) found.add(kw);
      else if (!(DML_OPERATIONS.has(kw) && this.operationAllowed(kw))) found.add(`statement ${kw}`);
    }

    for (const f of analysis.functions) {
      if (isBlockedFunction(f, this.config.blockedFunctions, this.config.allowedFunctions)) {
        found.add(`function ${f}`);
      }
    }

    for (const ref of analysis.tables) {
      const name = systemTable(ref);
      if (name) found.add(`system table ${name}`);
    }

    const ordered = PATTERN_ORDER.filter((p) => found.has(p));
    for (const p of found) if (!PATTERN_ORDER_SET.has(p)) ordered.push(p);
    return ordered;
  }

  /** Token-level checks of one statement. */
  private scanStatement(s: Shape, index: number, found: Set<string>): void {
    const { t } = s;
    const n = t.length;
    const generic = this.dialect === 'generic';
    const stacking = this.dialect === 'mssql' || generic;
    const allowUnion = this.config.allowUnion === true;
    const head = mainIndex(s);
    const headWord = head >= 0 && t[head].type === 'word' ? t[head].value : '';
    // The first SET of UPDATE ... SET / MySQL INSERT ... SET belongs to the statement
    let setPending = headWord === 'UPDATE' || headWord === 'INSERT';
    // The first top-level query of INSERT ... SELECT is its source, unless VALUES came first
    let insertSource = headWord === 'INSERT';

    if (index > 0 && LEGACY_STATEMENT_PATTERNS.has(headWord)) found.add(headWord);

    for (let i = 0; i < n; i++) {
      const tok = t[i];
      if (tok.type === 'operator') {
        if (tok.value === '{' || tok.value === '}') {
          found.add('ODBC escape'); // {fn ...}, {oj ...}, {d ...}, {ts ...}, {call ...}
        } else if (generic) {
          const next = t[i + 1];
          if (tok.value === '$') {
            found.add('ambiguous dollar quoting'); // $$...$$ is a string to Postgres, code to us
          } else if (
            tok.value === '-' &&
            next &&
            next.type === 'operator' &&
            next.start === tok.end &&
            next.text.charCodeAt(0) === 45 /* - */
          ) {
            found.add('--'); // a comment to Postgres, SQLite and SQL Server
          }
        }
        continue;
      }
      // T-SQL runs `... (SELECT ...)` after a complete expression as a statement of its own
      if (stacking && tok.type === 'punct' && tok.value === '(' && s.depth[i] === 0 && i > head && isQueryGroup(s, i)) {
        const prev = t[i - 1];
        const afterExpression =
          prev.type === 'number' || prev.type === 'string' || (prev.type === 'punct' && (prev.value === ')' || prev.value === ']'));
        if (afterExpression) {
          if (insertSource) insertSource = false;
          else found.add(MULTIPLE_STATEMENTS);
        }
        continue;
      }
      if (tok.type !== 'word' && tok.type !== 'quoted') continue;
      const upper = tok.type === 'word' ? tok.value : tok.value.toUpperCase();
      if (upper === 'XP_CMDSHELL' || upper === 'SP_EXECUTESQL') {
        found.add(upper.toLowerCase());
        continue;
      }
      if (tok.type !== 'word' || !isWordAt(t, i, tok.value)) continue;

      const v = tok.value;
      switch (v) {
        case 'UNION':
          if (!allowUnion) found.add('UNION.*SELECT');
          break;
        case 'INTO': {
          const p = intoPattern(s, i);
          if (p) found.add(p);
          break;
        }
        case 'FOR': {
          const p = lockingClause(t, i);
          if (p) found.add(p);
          break;
        }
        case 'NEXT':
          // Advances a sequence, like the blocked NEXTVAL (T-SQL, standard SQL)
          if (isWordAt(t, i + 1, 'VALUE') && isWordAt(t, i + 2, 'FOR')) found.add('NEXT VALUE FOR');
          break;
        case 'LOCK':
          if (isWordAt(t, i + 1, 'IN') && isWordAt(t, i + 2, 'SHARE') && isWordAt(t, i + 3, 'MODE')) {
            found.add('LOCK IN SHARE MODE');
          }
          break;
        case 'UPDATE':
          // Upserts update existing rows: ON CONFLICT DO UPDATE, ON DUPLICATE KEY UPDATE
          if (
            (isWordAt(t, i - 1, 'DO') || (isWordAt(t, i - 1, 'KEY') && isWordAt(t, i - 2, 'DUPLICATE'))) &&
            !this.operationAllowed('UPDATE')
          ) {
            found.add('statement UPDATE');
          }
          break;
        case 'REPLACE':
          // SQLite INSERT OR REPLACE deletes the conflicting rows
          if (
            isWordAt(t, i - 1, 'OR') &&
            isWordAt(t, i - 2, 'INSERT') &&
            !(this.operationAllowed('UPDATE') && this.operationAllowed('DELETE'))
          ) {
            found.add('statement REPLACE');
          }
          break;
      }

      // A second top-level SELECT or WITH starts a new T-SQL statement (SQL Server needs no ";",
      // and the driver returns the first statement's rows, which row-level security did not filter)
      if (stacking && i > head && s.depth[i] === 0) {
        if (v === 'VALUES') insertSource = false;
        if ((v === 'SELECT' || v === 'WITH') && this.startsQueryStatement(s, i)) {
          if (insertSource && v === 'SELECT') insertSource = false;
          else found.add(MULTIPLE_STATEMENTS);
        }
      }

      if (stacking && i !== head && TSQL_STATEMENTS.has(v)) {
        if (v === 'SET' && setPending && s.depth[i] === 0) {
          setPending = false;
        } else if (this.startsStatement(t, i)) {
          found.add(MULTIPLE_STATEMENTS);
          if (LEGACY_STATEMENT_PATTERNS.has(v)) found.add(v);
        }
      }
    }
  }

  /**
   * Whether the T-SQL statement keyword at `i` starts a new statement: it
   * follows the end of an operand (a name, literal, `)` or `*`) and is followed
   * by something a statement can start with.
   */
  /**
   * Whether the top-level SELECT or WITH at `i` begins a new statement rather
   * than continuing this one: it does not follow a set operator, `(`, `,`, an
   * operator or another word that needs a query after it, and a WITH opens a
   * CTE (`WITH [RECURSIVE] x [(cols)] AS (`), not a table hint, WITH TIES,
   * WITH ORDINALITY or WITH TIME ZONE.
   */
  private startsQueryStatement(s: Shape, i: number): boolean {
    const t = s.t;
    const prev = t[i - 1];
    if (!prev || prev.type === 'operator') return false;
    if (prev.type === 'punct' && prev.value !== ')' && prev.value !== ']') return false;
    if (prev.type === 'word' && NO_STATEMENT_AFTER.has(prev.value) && isWordAt(t, i - 1, prev.value)) return false;
    if (t[i].value === 'SELECT') return true;
    let k = i + 1;
    if (isWordAt(t, k, 'RECURSIVE')) k++;
    if (!isNameToken(t[k])) return false;
    k++;
    if (isPunctAt(t, k, '(')) {
      const close = s.pair[k];
      if (close <= k) return false;
      k = close + 1;
    }
    return isWordAt(t, k, 'AS') && isPunctAt(t, k + 1, '(');
  }

  private startsStatement(t: Token[], i: number): boolean {
    const v = t[i].value;
    const prev = t[i - 1];
    if (!prev) return false;
    if (prev.type === 'punct') {
      if (prev.value !== ')' && prev.value !== ']') return false;
    } else if (prev.type === 'operator') {
      if (prev.value !== '*') return false;
    } else if (prev.type === 'word' && NO_STATEMENT_AFTER.has(prev.value) && isWordAt(t, i - 1, prev.value)) {
      return false;
    }
    const next = t[i + 1];
    if (!next) return TSQL_COMPLETE_ALONE.has(v);
    if (next.type === 'operator') return false;
    if (next.type === 'punct' && (next.value === ',' || next.value === ')' || next.value === '.')) return false;
    if (next.type === 'word') {
      if (next.value === 'FROM' && v !== 'DELETE') return false; // `MAX(x) begin FROM t`: an alias
      if (next.value === 'JOIN' && v === 'MERGE') return false; // join hint
      if ((next.value === 'INDEX' || next.value === 'KEY') && v === 'USE') return false; // MySQL index hint
    }
    return true;
  }

  /**
   * Find restricted and sensitive columns in the query: exact identifier
   * matches (bare, or the last part of a qualified name), `table.column`
   * entries resolved through aliases, and, with a schema, columns reached
   * through `*`, `t.*` and whole-row references such as `row_to_json(t)`.
   */
  private findRestrictedColumns(ctx: QueryContext): { restricted: string[]; sensitive: string[] } {
    const rules = this.rules;
    if (rules.restrictedBare.size === 0 && rules.byColumn.size === 0) return EMPTY_COLUMNS;
    const restricted = new Set<string>();
    const sensitive = new Set<string>();
    const flag = (rule: ColumnRule): void => {
      (rule.sensitive ? sensitive : restricted).add(rule.entry);
    };
    const tables = ctx.analysis.tables;

    // Explicit references
    let ti = 0;
    for (const s of ctx.shapes) {
      const t = s.t;
      for (let i = 0; i < t.length; i++) {
        const tok = t[i];
        if (tok.type !== 'word' && tok.type !== 'quoted') continue;
        while (ti < tables.length && tables[ti].end <= tok.start) ti++;
        if (ti < tables.length && tables[ti].start <= tok.start) continue; // part of a table name
        if (isPunctAt(t, i + 1, '(') || isPunctAt(t, i + 1, '.')) continue; // function or qualifier
        const prev = t[i - 1];
        if (prev && prev.type === 'operator' && prev.value === '::') continue; // type name
        const column = (tok.type === 'quoted' ? tok.value : tok.text).toUpperCase();
        const bare = rules.restrictedBare.get(column);
        if (bare !== undefined) restricted.add(bare);
        const specific = rules.byColumn.get(column);
        if (specific) {
          const qualifier = isPunctAt(t, i - 1, '.') && isNameToken(t[i - 2]) ? nameOf(t[i - 2]) : undefined;
          for (const rule of specific) if (this.columnRuleApplies(ctx, rule, qualifier)) flag(rule);
        }
      }
    }

    // Columns reached through *, t.* and whole-row references (needs a schema)
    if (rules.schemaTables.size > 0 && tables.length > 0) {
      for (const ref of this.expandedTables(ctx)) {
        for (const table of this.schemaTablesFor(ref)) {
          for (const col of table.columns) {
            const column = col.name.toUpperCase();
            const bare = rules.restrictedBare.get(column);
            if (bare !== undefined) restricted.add(bare);
            const specific = rules.byColumn.get(column);
            if (specific) for (const rule of specific) if (this.tableMatches(rule, ref)) flag(rule);
          }
        }
      }
    }

    return {
      restricted: rules.restrictedOrder.filter((e) => restricted.has(e)),
      sensitive: rules.sensitiveOrder.filter((e) => sensitive.has(e)),
    };
  }

  /** Whether a `table.column` rule applies to a reference with this qualifier (or none). */
  private columnRuleApplies(ctx: QueryContext, rule: ColumnRule, qualifier: string | undefined): boolean {
    if (qualifier !== undefined) {
      const refs = this.resolveName(ctx, qualifier);
      if (refs.length > 0) return refs.some((r) => this.tableMatches(rule, r));
      // A derived table, CTE or unknown qualifier: it may expose the column
    }
    if (!ctx.ruleTableSeen) ctx.ruleTableSeen = new Map();
    let seen = ctx.ruleTableSeen.get(rule);
    if (seen === undefined) {
      seen = ctx.analysis.tables.some((r) => this.tableMatches(rule, r));
      ctx.ruleTableSeen.set(rule, seen);
    }
    return seen;
  }

  private tableMatches(rule: ColumnRule, ref: TableReference): boolean {
    if (ref.name.toUpperCase() !== rule.table) return false;
    return rule.schema === undefined || ref.schema === undefined || ref.schema.toUpperCase() === rule.schema;
  }

  /** Base tables an alias or table name refers to. */
  private resolveName(ctx: QueryContext, name: string): TableReference[] {
    if (!ctx.refIndex) {
      const index = new Map<string, TableReference[]>();
      const add = (key: string, ref: TableReference): void => {
        const list = index.get(key);
        if (!list) index.set(key, [ref]);
        else if (list[list.length - 1] !== ref) list.push(ref);
      };
      for (const ref of ctx.analysis.tables) {
        if (ref.alias !== undefined) add(ref.alias.toUpperCase(), ref);
        add(ref.name.toUpperCase(), ref);
      }
      ctx.refIndex = index;
    }
    return ctx.refIndex.get(name.toUpperCase()) ?? [];
  }

  /** Tables whose every column the query may read: bare `*`, `t.*` and whole-row references. */
  private expandedTables(ctx: QueryContext): Set<TableReference> {
    const out = new Set<TableReference>();
    const { analysis } = ctx;

    for (const q of analysis.starQualifiers) {
      if (q !== '') for (const ref of this.resolveName(ctx, q)) out.add(ref);
    }

    // Columns of the query's tables, so `SELECT status FROM status` is a column, not the row
    const queryColumns = new Set<string>();
    for (const ref of analysis.tables) {
      for (const table of this.schemaTablesFor(ref)) for (const c of table.columns) queryColumns.add(c.name.toUpperCase());
    }

    for (const s of ctx.shapes) {
      const located = locateTables(s, analysis.tables);
      if (located.length === 0) continue;
      const t = s.t;

      for (const l of located) if (l.renamesColumns) out.add(l.ref);

      if (analysis.starQualifiers.includes('')) {
        // A bare * reads the tables of its own query level
        const scope = queryScopes(s);
        const byScope = new Map<number, TableReference[]>();
        for (const l of located) {
          const list = byScope.get(scope[l.index]);
          if (list) list.push(l.ref);
          else byScope.set(scope[l.index], [l.ref]);
        }
        for (const star of bareStars(s)) for (const ref of byScope.get(scope[star]) ?? []) out.add(ref);
      }

      // Whole-row references: row_to_json(u), to_jsonb(users), SELECT u FROM users u
      const skip = new Set<number>();
      for (const l of located) if (l.aliasIndex >= 0) skip.add(l.aliasIndex);
      let li = 0;
      for (let i = 0; i < t.length; i++) {
        const tok = t[i];
        if (tok.type !== 'word' && tok.type !== 'quoted') continue;
        while (li < located.length && located[li].ref.end <= tok.start) li++;
        if (li < located.length && located[li].ref.start <= tok.start) continue; // part of a table name
        if (skip.has(i) || isPunctAt(t, i + 1, '.') || isPunctAt(t, i + 1, '(') || isPunctAt(t, i - 1, '.')) continue;
        const prev = t[i - 1];
        if (prev && prev.type === 'word' && (prev.value === 'AS' || prev.value === 'UPDATE' || prev.value === 'DELETE')) continue;
        const name = nameOf(tok);
        if (queryColumns.has(name.toUpperCase())) continue;
        for (const ref of this.resolveName(ctx, name)) out.add(ref);
      }
    }
    return out;
  }

  private schemaTablesFor(ref: TableReference): TableSchema[] {
    const list = this.rules.schemaTables.get(ref.name.toLowerCase());
    if (!list) return [];
    if (ref.schema === undefined) return list;
    return list.filter((t) => t.schema === undefined || eqi(t.schema, ref.schema));
  }

  /**
   * Extract the tables the query accesses that allowedTables does not list.
   * Matching is case-insensitive and exact in qualification: `schema.table`
   * matches only a `schema.table` entry and `table` only a `table` entry.
   * CTE names are not tables.
   */
  private extractTableNames(ctx: QueryContext): string[] {
    const allowed = this.rules.allowedTables;
    if (!allowed) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const ref of ctx.analysis.tables) {
      // An entry matches a reference written with the same qualification only:
      // `users` is whatever the connection resolves the bare name to, and
      // `tenant_b.users` or `otherdb..users` is a different table.
      const display =
        ref.catalog !== undefined
          ? `${ref.catalog}.${ref.schema ?? ''}.${ref.name}`
          : ref.schema !== undefined
            ? `${ref.schema}.${ref.name}`
            : ref.name;
      const key = display.toLowerCase();
      if (allowed.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(display);
    }
    return out;
  }

  /** LIMIT check of a SELECT: the top-level LIMIT, TOP or FETCH count against maxRowLimit. */
  private checkRowLimit(ctx: QueryContext, errors: string[], warnings: string[]): void {
    const shape = ctx.shapes[0];
    const max = this.config.maxRowLimit;
    const limits = findRowLimits(shape, this.dialect);
    if (typeof max === 'number') {
      // A count that is not a plain number (an expression, a subquery, PERCENT) can be
      // neither checked nor lowered, so it is refused. LIMIT ALL is the same as no limit
      // (enforceLimit replaces it), and a lone parameter is bound by the application, not
      // the model: both only warn, as in 0.0.1.
      let refused = false;
      for (const l of limits) {
        if (l.value !== null || l.all || isLoneParam(shape.t, l.valueStart)) continue;
        errors.push(`${shape.t[l.keyword].value} value must be a plain number no greater than ${max}`);
        refused = true;
      }
      if (refused) return;
    }
    const counts = limits.filter((l) => l.value !== null);
    if (counts.length === 0) {
      warnings.push(
        `Query does not have a LIMIT clause. Maximum ${this.config.maxRowLimit} rows will be enforced.`
      );
      return;
    }
    if (typeof max !== 'number') return;
    for (const l of counts) {
      // A negative count means "no limit" in SQLite
      if (l.value! > max || l.value! < 0) {
        const text = shape.t.slice(l.valueStart, l.valueEnd).map((x) => x.text).join('');
        errors.push(`LIMIT ${text} exceeds maximum allowed limit of ${max}`);
      }
    }
  }

  private operationAllowed(op: string): boolean {
    const allowed = this.config.allowedOperations;
    return !allowed || (allowed as string[]).includes(op);
  }

  /**
   * Lex and analyze once. Returns the error message when the query cannot be
   * read safely: an unterminated literal, a MySQL executable comment, or a
   * string whose extent depends on backslash escaping.
   */
  private lex(query: string): QueryContext | string {
    const alternate = ALTERNATE_READING[this.dialect];
    let analysis: SqlAnalysis;
    try {
      analysis = analyzeSql(query, this.dialect);
    } catch (error) {
      if (!(error instanceof SqlLexError)) throw error;
      if (error.kind === 'executable_comment') {
        return `Query contains dangerous patterns: executable comment ${error.delimiter}`;
      }
      // Generic `--x`: a comment to Postgres, SQLite and SQL Server, code to MySQL
      if (error.kind === 'ambiguous_syntax') return `Query contains dangerous patterns: ${error.delimiter}`;
      if (alternate && this.lexes(query, alternate)) {
        return `Query contains dangerous patterns: ${AMBIGUOUS_ESCAPING}`;
      }
      return `Malformed SQL: ${error.message}`;
    }

    const ctx: QueryContext = {
      analysis,
      shapes: analysis.statements.map(shapeOf),
      ambiguous: false,
    };
    if (alternate && hasBackslashInLiteral(analysis.tokens)) {
      let other: Token[] | null = null;
      try {
        other = tokenize(query, 'mysql', alternate);
      } catch (error) {
        if (!(error instanceof SqlLexError)) throw error;
      }
      if (!other) return `Query contains dangerous patterns: ${AMBIGUOUS_ESCAPING}`;
      const a = literalEnds(analysis.tokens);
      const b = literalEnds(other);
      ctx.ambiguous = a.length !== b.length || a.some((end, k) => end !== b[k]);
    }
    return ctx;
  }

  private lexes(query: string, options: LexOptions): boolean {
    try {
      tokenize(query, 'mysql', options);
      return true;
    } catch (error) {
      if (error instanceof SqlLexError) return false;
      throw error;
    }
  }

  private compileRules(): Rules {
    const restrictedBare = new Map<string, string>();
    const byColumn = new Map<string, ColumnRule[]>();
    const restrictedOrder: string[] = [];
    const sensitiveOrder: string[] = [];
    const addRule = (column: string, rule: ColumnRule): void => {
      const key = column.toUpperCase();
      const list = byColumn.get(key);
      if (list) list.push(rule);
      else byColumn.set(key, [rule]);
    };

    for (const raw of this.config.restrictedColumns ?? []) {
      if (typeof raw !== 'string') continue;
      const entry = raw.trim();
      if (!entry) continue;
      restrictedOrder.push(raw);
      const dot = entry.lastIndexOf('.');
      if (dot < 0) {
        const key = entry.toUpperCase();
        if (!restrictedBare.has(key)) restrictedBare.set(key, raw);
        continue;
      }
      const tablePart = entry.slice(0, dot).split('.');
      addRule(entry.slice(dot + 1), {
        entry: raw,
        table: tablePart[tablePart.length - 1].toUpperCase(),
        schema: tablePart.length > 1 ? tablePart[tablePart.length - 2].toUpperCase() : undefined,
        sensitive: false,
      });
    }

    const schemaTables = new Map<string, TableSchema[]>();
    for (const table of this.options.schema?.tables ?? []) {
      if (!table || typeof table.name !== 'string') continue;
      const key = table.name.toLowerCase();
      const list = schemaTables.get(key);
      if (list) list.push(table);
      else schemaTables.set(key, [table]);
      for (const col of table.columns ?? []) {
        if (!col.sensitive) continue;
        const entry = `${table.name}.${col.name}`;
        sensitiveOrder.push(entry);
        addRule(col.name, {
          entry,
          table: table.name.toUpperCase(),
          schema: table.schema?.toUpperCase(),
          sensitive: true,
        });
      }
    }

    let allowedTables: Set<string> | null = null;
    if (this.config.allowedTables && this.config.allowedTables.length > 0) {
      allowedTables = new Set();
      for (const entry of this.config.allowedTables) {
        const e = String(entry).trim().toLowerCase();
        allowedTables.add(e);
      }
    }

    return { restrictedBare, byColumn, restrictedOrder, sensitiveOrder, allowedTables, schemaTables };
  }

  /** The configured RLS column as a single identifier token. */
  private rlsColumn(): RlsColumn {
    if (this.rlsColumnCache) return this.rlsColumnCache;
    const raw = (this.config.rowLevelSecurityColumn ?? 'user_id').trim();
    let toks: Token[] = [];
    try {
      toks = significantTokens(tokenize(raw, this.dialect));
    } catch (error) {
      if (!(error instanceof SqlLexError)) throw error;
    }
    const tok = toks.length === 1 ? toks[0] : undefined;
    if (!tok || (tok.type !== 'word' && tok.type !== 'quoted')) {
      throw new TextToQueryError(
        `Invalid rowLevelSecurityColumn ${JSON.stringify(raw)}: expected a single column name`,
        'SECURITY_VALIDATION_FAILED'
      );
    }
    this.rlsColumnCache = { text: tok.text, name: nameOf(tok), quoted: tok.type === 'quoted' };
    return this.rlsColumnCache;
  }

  /** The user id as a SQL literal: a finite number inlined, a string single-quoted and escaped. */
  private rlsValue(userId: unknown): string {
    const fail = (reason: string): never => {
      throw new TextToQueryError(`Row-level security: user id ${reason}`, 'SECURITY_VALIDATION_FAILED');
    };
    if (typeof userId === 'number') {
      if (!Number.isFinite(userId)) fail('must be a finite number');
      return String(userId);
    }
    if (typeof userId === 'bigint') return userId.toString();
    if (typeof userId === 'string') {
      if (userId.indexOf('\0') >= 0) fail('contains a NUL character');
      let s = userId;
      if (this.dialect === 'mysql') {
        s = s.replace(BACKSLASH, '\\\\');
      } else if (this.dialect === 'generic' && s.indexOf('\\') >= 0) {
        // MySQL reads a backslash as an escape, other databases do not: no literal is safe for both
        fail('contains a backslash; set databaseType so it can be escaped for your database');
      }
      return `'${s.replace(SINGLE_QUOTE, "''")}'`;
    }
    return fail(`must be a string or a number, not ${userId === null ? 'null' : typeof userId}`);
  }

  /** Add the filter to one SELECT, UPDATE or DELETE branch `[bs, be)`. */
  private filterBranch(st: RlsState, bs: number, be: number): void {
    const { shape } = st;
    const { t, depth } = shape;
    const d = depth[bs];
    const head = t[bs].value;

    let scan = bs + 1;
    let from = -1;
    if (head === 'SELECT') {
      from = fromAt(shape, bs + 1, be, d);
      if (from >= 0) scan = from + 1;
    }
    let where = -1;
    let boundary = be;
    for (let i = scan; i < be; i++) {
      if (depth[i] !== d || t[i].type !== 'word') continue;
      if (where < 0 && isWordAt(t, i, 'WHERE')) {
        where = i;
        continue;
      }
      // A second SELECT on this level is a T-SQL statement of its own: keep the filter in this one
      if (isWordAt(t, i, 'SELECT')) {
        boundary = i;
        break;
      }
      if (isClauseBoundary(t, i, head)) {
        boundary = i;
        break;
      }
    }

    const chosen = this.rlsTarget(st, bs, be, d, head === 'SELECT' && from >= 0 ? from : -1, where >= 0 ? where : boundary);
    if (chosen) for (const l of chosen.covered) st.handled.add(l.index);
    const qualifier = chosen && chosen.qualify ? `${this.tableText(st, chosen.table)}.` : '';
    // An existing qualified `t.col = v` only stands in for the filter on a single-table
    // level without joins; anywhere else only an unqualified `col = v` (the same predicate
    // the filter would add) does.
    const sameAs = chosen && !chosen.qualify && chosen.direct.length === 1 ? chosen.table : undefined;
    const filter = `${qualifier}${st.column.text} = ${st.value}`;

    if (where < 0) {
      const at = t[boundary - 1].end;
      st.edits.push({ start: at, end: at, text: ` WHERE ${filter}` });
      return;
    }
    const condStart = where + 1;
    const condEnd = boundary;
    if (condEnd <= condStart) {
      const at = t[where].end;
      st.edits.push({ start: at, end: at, text: ` ${filter}` });
      return;
    }

    // Split the condition into top-level conjuncts
    let caseDepth = 0;
    let betweens = 0;
    let orLike = false;
    let broken = false;
    const conjuncts: Array<[number, number]> = [];
    let cs = condStart;
    for (let i = condStart; i < condEnd; i++) {
      if (depth[i] !== d) continue;
      const tok = t[i];
      if (tok.type === 'operator') {
        // Lower precedence than AND in MySQL: `||` (OR unless PIPES_AS_CONCAT) and `:=`
        if (tok.value === '||' || tok.value === ':=') orLike = true;
        continue;
      }
      if (tok.type !== 'word' || !isWordAt(t, i, tok.value)) continue;
      switch (tok.value) {
        case 'CASE':
          caseDepth++;
          break;
        case 'END':
          if (caseDepth > 0) caseDepth--;
          else broken = true;
          break;
        case 'OR':
        case 'XOR':
          orLike = true;
          break;
        case 'BETWEEN':
          if (caseDepth === 0) betweens++;
          break;
        case 'AND':
          if (caseDepth > 0) break;
          if (betweens > 0) {
            betweens--; // the AND of BETWEEN x AND y
            break;
          }
          conjuncts.push([cs, i]);
          cs = i + 1;
          break;
      }
    }
    conjuncts.push([cs, condEnd]);
    // A pure AND-chain can take ` AND filter` as is; anything else is wrapped, so a
    // malformed condition (dangling BETWEEN, unclosed CASE) stays malformed.
    const pure = !orLike && !broken && caseDepth === 0 && betweens === 0;

    if (pure && conjuncts.some(([a, b]) => this.isSameFilter(st, a, b, sameAs))) return;

    const end = t[condEnd - 1].end;
    if (pure) {
      st.edits.push({ start: end, end, text: ` AND ${filter}` });
    } else {
      const begin = t[condStart].start;
      st.edits.push({ start: begin, end: begin, text: '(' });
      st.edits.push({ start: end, end, text: `) AND ${filter}` });
    }
  }

  /** `TABLE name` (Postgres, MySQL) is `SELECT * FROM name`: rewrite it so it can take a WHERE. */
  private filterTableBranch(st: RlsState, bs: number, be: number): void {
    const t = st.shape.t;
    let k = bs + 1;
    if (!isNameToken(t[k])) return;
    while (k + 2 < be && isPunctAt(t, k + 1, '.') && isNameToken(t[k + 2])) k += 2;
    const filter = `${st.column.text} = ${st.value}`;
    st.handled.add(bs + 1);
    st.edits.push({ start: t[bs].start, end: t[bs].end, text: 'SELECT * FROM' });
    st.edits.push({ start: t[k].end, end: t[k].end, text: ` WHERE ${filter}` });
  }

  /**
   * The table the filter belongs to, whether it must be qualified, and the
   * tables of the branch it covers. With more than one table (or a join) in
   * the branch: the first table that has the column according to the schema,
   * else the first table. Without a schema, a branch with several tables keeps
   * the unqualified 0.0.1 filter: it filters the one table that has the column,
   * and makes the query fail as ambiguous when several have it. A table whose
   * alias renames its columns is never covered that way (the name would bind
   * elsewhere), so it gets wrapped instead.
   */
  private rlsTarget(
    st: RlsState,
    bs: number,
    be: number,
    d: number,
    from: number,
    fromEnd: number
  ): { table: LocatedTable; qualify: boolean; covered: LocatedTable[]; direct: LocatedTable[] } | undefined {
    const { shape } = st;
    // Tables of this branch's own query level (parenthesized joins included, subqueries not)
    const scope = queryScopes(shape);
    const level = scope[bs];
    const direct: LocatedTable[] = [];
    let lo = 0;
    let hi = st.tables.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (st.tables[mid].index < bs) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < st.tables.length && st.tables[k].index < be; k++) {
      if (scope[st.tables[k].index] === level) direct.push(st.tables[k]);
    }
    if (direct.length === 0) return undefined;
    if (direct.length > 1 && this.rules.schemaTables.size === 0) {
      return { table: direct[0], qualify: false, covered: direct.filter((l) => !l.renamesColumns), direct };
    }
    let qualify = direct.length > 1;
    if (!qualify && from >= 0) {
      const t = shape.t;
      for (let i = from + 1; i < fromEnd; i++) {
        if (shape.depth[i] !== d) continue;
        if (isPunctAt(t, i, ',') || isWordAt(t, i, 'JOIN') || isWordAt(t, i, 'APPLY') || isWordAt(t, i, 'STRAIGHT_JOIN')) {
          qualify = true;
          break;
        }
      }
    }
    const column = st.column.name.toUpperCase();
    const withColumn = qualify
      ? direct.find((l) => this.schemaTablesFor(l.ref).some((tb) => tb.columns.some((c) => c.name.toUpperCase() === column)))
      : undefined;
    const table = withColumn ?? direct[0];
    return { table, qualify, covered: [table], direct };
  }

  /**
   * Replace every table that holds user rows and that no WHERE filter covers
   * (subqueries, CTE bodies, derived tables, further joined tables, the source
   * of INSERT ... SELECT) with a filtered derived table:
   * `orders o` -> `(SELECT id, ... FROM orders AS __rls WHERE __rls.user_id = 5) o`.
   * The filter is bound to the table itself, so it cannot resolve to an outer
   * query's column, and outer joins keep their meaning.
   */
  private wrapUserTables(st: RlsState): void {
    const t = st.shape.t;
    for (const l of st.tables) {
      if (st.handled.has(l.index) || !this.holdsUserRows(l.ref, st.column)) continue;
      const ref = l.ref;
      let last = l.index;
      while (last + 1 < t.length && t[last + 1].end <= ref.end) last++;
      const alias = ref.alias !== undefined ? '' : ` ${t[last].text}`;
      const name = st.sql.slice(ref.start, ref.end);
      st.edits.push({
        start: ref.start,
        end: ref.end,
        text: `(SELECT ${this.wrapColumns(ref)} FROM ${name} AS ${RLS_ALIAS} WHERE ${RLS_ALIAS}.${st.column.text} = ${st.value})${alias}`,
      });
    }
  }

  /**
   * Whether row-level security applies to the table: it has the column in the
   * schema. Without a schema, or for a table the schema does not list, every
   * table is assumed to hold user rows (the query then fails rather than leaks).
   */
  private holdsUserRows(ref: TableReference, column: RlsColumn): boolean {
    if (this.rules.schemaTables.size === 0) return true;
    const tables = this.schemaTablesFor(ref);
    if (tables.length === 0) return true;
    const name = column.name.toUpperCase();
    return tables.some((tb) => (tb.columns ?? []).some((c) => c.name.toUpperCase() === name));
  }

  /**
   * Select list of a wrapped table: its schema columns without restricted or
   * sensitive ones, so validating the rewritten query does not see them through
   * a `*`. `*` when the schema does not pin down one table.
   */
  private wrapColumns(ref: TableReference): string {
    const tables = this.schemaTablesFor(ref);
    if (tables.length !== 1) return '*';
    const columns = (tables[0].columns ?? [])
      .map((c) => c.name)
      .filter((name) => {
        const key = name.toUpperCase();
        if (this.rules.restrictedBare.has(key)) return false;
        return !(this.rules.byColumn.get(key) ?? []).some((rule) => this.tableMatches(rule, ref));
      });
    if (columns.length === 0) return '*';
    const exact = this.options.schema?.exactNames === true;
    return columns.map((name) => formatIdentifier(name, this.dialect, exact)).join(', ');
  }

  /** How the query names a table: its alias as written, else its (qualified) name as written. */
  private tableText(st: RlsState, l: LocatedTable): string {
    if (l.aliasIndex >= 0) return st.shape.t[l.aliasIndex].text;
    if (l.ref.alias !== undefined) return l.ref.alias;
    return st.sql.slice(l.ref.start, l.ref.end);
  }

  /** Whether conjunct `[a, b)` is exactly `[q.]col = <value>` for the filter about to be added. */
  private isSameFilter(st: RlsState, a: number, b: number, target: LocatedTable | undefined): boolean {
    const t = st.shape.t;
    let k = a;
    if (b - a === 5) {
      if (!isPunctAt(t, a + 1, '.') || !isNameToken(t[a]) || !target) return false;
      // A table with an alias is known by its alias only
      if (!eqi(nameOf(t[a]), target.ref.alias ?? target.ref.name)) return false;
      k = a + 2;
    } else if (b - a !== 3) {
      return false;
    }
    const col = t[k];
    const op = t[k + 1];
    const val = t[k + 2];
    if (op.type !== 'operator' || op.value !== '=') return false;
    if (st.valueType === 'string' ? val.type !== 'string' : val.type !== 'number') return false;
    if (val.text !== st.value) return false;
    const c = st.column;
    if (c.quoted) return col.type === 'quoted' && col.value === c.name;
    if (col.type === 'word') return col.value === c.name.toUpperCase();
    return col.type === 'quoted' && (col.value === c.name || col.value === c.name.toLowerCase());
  }
}
