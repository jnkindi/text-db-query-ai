/**
 * Checks the tables and columns a generated query references against the
 * schema, so invented names ("hallucinations") and wrongly quoted names can be
 * fed back to the model or reported as warnings.
 *
 * Built on the token-based analysis in src/sql. The check is conservative: a
 * reference is reported only when the schema clearly does not contain it.
 * Function names, keywords, aliases, parameters and string contents are never
 * reported, and anything whose columns cannot be known (CTEs, derived tables,
 * table functions, system catalogs) is skipped.
 */

import { ColumnSchema, DatabaseSchema, TableSchema } from '../types';
import {
  analyzeSql,
  isReservedKeyword,
  formatIdentifier,
  quoteIdentifier,
  SqlAnalysis,
  SqlDialect,
  SqlLexError,
  TableReference,
  Token,
  toSqlDialect,
} from '../sql';

export type IdentifierIssueKind = 'unknown_table' | 'unknown_column' | 'needs_quoting';

/**
 * A table or column reference that does not match the schema.
 */
export interface IdentifierIssue {
  kind: IdentifierIssueKind;
  /** The name as written in the query, without quotes (for columns, without the qualifier). */
  name: string;
  /** For columns: the schema table the column was looked up in, when there is exactly one. */
  table?: string;
  /** Close matches from the schema (plain names, without quotes). */
  suggestions?: string[];
  /** A readable description, with names written the way the dialect needs them. */
  message: string;
}

/**
 * Result of inspecting one query: the issues plus what the generator needs to
 * build correction feedback and metadata without analyzing the query again.
 * @internal
 */
export interface IdentifierInspection {
  /** Undefined when the query could not be lexed (the validator reports that). */
  analysis?: SqlAnalysis;
  issues: IdentifierIssue[];
  /** Schema tables the query references, in first-reference order. */
  referencedTables: TableSchema[];
}

/**
 * Schemas whose tables are system catalogs, per dialect: skipped when a
 * reference names them explicitly. Unqualified catalog names (`pg_tables`)
 * are still reported, because nothing tells them apart from a typo.
 */
const COMMON_SYSTEM_SCHEMAS = ['information_schema', 'pg_catalog'];
const SYSTEM_SCHEMAS: Record<SqlDialect, ReadonlySet<string>> = {
  postgres: new Set(COMMON_SYSTEM_SCHEMAS),
  mysql: new Set([...COMMON_SYSTEM_SCHEMAS, 'performance_schema', 'mysql', 'sys']),
  sqlite: new Set(COMMON_SYSTEM_SCHEMAS),
  mssql: new Set([...COMMON_SYSTEM_SCHEMAS, 'sys']),
  generic: new Set([...COMMON_SYSTEM_SCHEMAS, 'performance_schema', 'mysql', 'sys']),
};
/** SQLite catalog tables, skipped by name. */
const SYSTEM_TABLES: ReadonlySet<string> = new Set([
  'sqlite_master',
  'sqlite_schema',
  'sqlite_temp_master',
  'sqlite_temp_schema',
  'sqlite_sequence',
  'sqlite_stat1',
]);
/**
 * Implicit columns and niladic functions that can appear as bare words
 * (lowercase): row ids and system columns, and MySQL's UTC_* values.
 */
const PSEUDO_COLUMNS: ReadonlySet<string> = new Set([
  'rowid', '_rowid_', 'oid', 'ctid', 'xmin', 'xmax', 'cmin', 'cmax', 'tableoid',
  'utc_date', 'utc_time', 'utc_timestamp', 'sysdate', 'rownum',
]);
const SQLITE_ROW_COLUMNS = ['rowid', '_rowid_', 'oid'];
const POSTGRES_SYSTEM_COLUMNS = ['ctid', 'xmin', 'xmax', 'cmin', 'cmax', 'tableoid'];
/**
 * Implicit columns every table has, per dialect (lowercase), accepted when
 * qualified (`t.rowid`): the prompt asks for qualified columns in joins.
 */
const QUALIFIED_PSEUDO_COLUMNS: Record<SqlDialect, ReadonlySet<string>> = {
  postgres: new Set(POSTGRES_SYSTEM_COLUMNS),
  mysql: new Set(['_rowid']),
  sqlite: new Set(SQLITE_ROW_COLUMNS),
  mssql: new Set(),
  generic: new Set([...SQLITE_ROW_COLUMNS, ...POSTGRES_SYSTEM_COLUMNS, '_rowid']),
};
/** Words before a table item. */
const TABLE_INTRODUCERS: ReadonlySet<string> = new Set(['JOIN', 'APPLY', 'STRAIGHT_JOIN']);
/** Words skipped between a table introducer and the table item. */
const TABLE_ITEM_PREFIXES: ReadonlySet<string> = new Set(['LATERAL', 'ONLY']);
/** Clause words that end a FROM list at the same depth. */
const FROM_LIST_END: ReadonlySet<string> = new Set([
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'WINDOW', 'UNION', 'INTERSECT',
  'EXCEPT', 'MINUS', 'RETURNING', 'SET', 'SELECT', 'QUALIFY', 'FOR', 'INTO', 'VALUES', 'OPTION',
]);
/** Words that start a query inside parentheses. */
const QUERY_HEADS: ReadonlySet<string> = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);

const MAX_SUGGESTIONS = 3;

/**
 * Options for IdentifierChecker.
 */
export interface IdentifierCheckerOptions {
  /**
   * Columns never offered to the model: left out of "did you mean"
   * suggestions, "it exists in" hints and quoting fixes. QueryGenerator hides
   * restricted and sensitive columns. A reference to a hidden column is still
   * checked like any other.
   */
  hideColumn?: (column: ColumnSchema, table: TableSchema) => boolean;
  /**
   * Tables never offered to the model as "did you mean" suggestions or in
   * "it exists in" hints. QueryGenerator hides the tables `allowedTables`
   * leaves out. A query that names a hidden table is still checked (and a
   * wrongly quoted reference to it still gets its quoting fix: the table is
   * already in the query, and the validator decides whether it may be).
   */
  hideTable?: (table: TableSchema) => boolean;
}

interface TableEntry {
  table: TableSchema;
  /** Lowercased table name. */
  key: string;
  /** Lowercased schema, when the table has one. */
  schemaKey?: string;
  /** Lowercased column name -> columns with that name (usually one). */
  columns: Map<string, ColumnSchema[]>;
  /** Never suggested (IdentifierCheckerOptions.hideTable). */
  hidden: boolean;
  /** Columns never suggested (IdentifierCheckerOptions.hideColumn). */
  hiddenColumns: ReadonlySet<ColumnSchema>;
}

/** How a qualifier (`x` in `x.col`) resolves. */
type Source = TableEntry | 'opaque';

/**
 * Checks generated SQL against one schema. The schema index is built on first
 * use and reused; build a new checker when the schema changes.
 */
export class IdentifierChecker {
  private byName?: Map<string, TableEntry[]>;
  /** Names of the tables that may be suggested. */
  private tableNames?: string[];

  /**
   * @param schema - Schema the queries should use
   * @param dialect - SQL dialect of the queries
   * @param options - Columns and tables never to suggest
   */
  constructor(
    private readonly schema: DatabaseSchema,
    private readonly dialect: SqlDialect,
    private readonly options: IdentifierCheckerOptions = {}
  ) {}

  /**
   * Issues in `sql`. Returns an empty list when the query cannot be lexed.
   */
  check(sql: string): IdentifierIssue[] {
    return this.inspect(sql).issues;
  }

  /**
   * Analyze `sql` once and check it.
   * @internal
   */
  inspect(sql: string): IdentifierInspection {
    let analysis: SqlAnalysis;
    try {
      analysis = analyzeSql(sql, this.dialect);
    } catch (error) {
      if (error instanceof SqlLexError) return { issues: [], referencedTables: [] };
      throw error;
    }
    return this.inspectAnalysis(analysis);
  }

  /**
   * Check an analysis made with this checker's dialect.
   * @internal
   */
  inspectAnalysis(analysis: SqlAnalysis): IdentifierInspection {
    const index = this.index();
    const issues = new IssueList();
    const referenced: TableEntry[] = [];
    const sources = new Map<string, Source[]>();
    const addSource = (key: string, source: Source) => {
      const list = sources.get(key);
      if (list) list.push(source);
      else sources.set(key, [source]);
    };

    // Tables. Every reference must resolve for bare columns to be checkable.
    let allTablesKnown = analysis.tables.length > 0;
    const tableAliasKeys = new Set<string>();
    for (const ref of analysis.tables) {
      if (ref.alias !== undefined) tableAliasKeys.add(ref.alias.toLowerCase());
      const entries = this.resolveTable(ref, index, issues);
      if (!entries) {
        allTablesKnown = false;
        addSource(ref.name.toLowerCase(), 'opaque');
        if (ref.alias !== undefined) addSource(ref.alias.toLowerCase(), 'opaque');
        continue;
      }
      for (const entry of entries) {
        if (referenced.indexOf(entry) === -1) referenced.push(entry);
        addSource(ref.name.toLowerCase(), entry);
        if (ref.alias !== undefined) addSource(ref.alias.toLowerCase(), entry);
      }
    }
    // CTE names and every alias that is not a table alias (derived tables,
    // table functions, select-list aliases) have columns we cannot know.
    for (const name of analysis.cteNames) addSource(name.toLowerCase(), 'opaque');
    for (const name of analysis.aliases) {
      const key = name.toLowerCase();
      if (!tableAliasKeys.has(key)) addSource(key, 'opaque');
    }

    const bareCheckable = allTablesKnown && !hasOpaqueSource(analysis.statements);
    const qualifiedPseudoColumns = QUALIFIED_PSEUDO_COLUMNS[this.dialect] ?? QUALIFIED_PSEUDO_COLUMNS.generic;
    let calledNames: Set<string> | undefined;

    for (const col of analysis.columns) {
      if (col.qualifier !== undefined) {
        const list = sources.get(col.qualifier.toLowerCase());
        if (!list || list.some((s) => s === 'opaque')) continue;
        if (!col.quoted && qualifiedPseudoColumns.has(col.name.toLowerCase())) continue;
        this.checkColumn(col.name, col.quoted, `${col.qualifier}.`, list as TableEntry[], issues, true);
        continue;
      }
      if (!bareCheckable) continue;
      const key = col.name.toLowerCase();
      if (PSEUDO_COLUMNS.has(key)) continue;
      // An unaliased call names its output column after the function (`SELECT count FROM (SELECT count(*) ...)`).
      if (!calledNames) calledNames = functionNames(analysis.functions);
      if (calledNames.has(key)) continue;
      this.checkColumn(col.name, col.quoted, '', referenced, issues, false);
    }

    return {
      analysis,
      issues: issues.items,
      referencedTables: referenced.map((e) => e.table),
    };
  }

  /** Render a schema name the way the dialect needs it written. */
  display(name: string): string {
    return formatIdentifier(name, this.dialect, this.schema.exactNames === true);
  }

  /** A reference as written in the query. */
  private written(name: string, quoted: boolean): string {
    return quoted ? quoteIdentifier(name, this.dialect) : name;
  }

  private index(): Map<string, TableEntry[]> {
    if (this.byName) return this.byName;
    const byName = new Map<string, TableEntry[]>();
    const names: string[] = [];
    const { hideColumn, hideTable } = this.options;
    for (const table of this.schema.tables || []) {
      if (!table || typeof table.name !== 'string') continue;
      const columns = new Map<string, ColumnSchema[]>();
      const hiddenColumns = new Set<ColumnSchema>();
      for (const column of table.columns || []) {
        if (!column || typeof column.name !== 'string') continue;
        const key = column.name.toLowerCase();
        const list = columns.get(key);
        if (list) list.push(column);
        else columns.set(key, [column]);
        if (hideColumn && hideColumn(column, table)) hiddenColumns.add(column);
      }
      const entry: TableEntry = {
        table,
        key: table.name.toLowerCase(),
        schemaKey: table.schema ? table.schema.toLowerCase() : undefined,
        columns,
        hidden: !!hideTable && hideTable(table),
        hiddenColumns,
      };
      const list = byName.get(entry.key);
      if (list) list.push(entry);
      else byName.set(entry.key, [entry]);
      if (!entry.hidden) names.push(table.name);
    }
    this.byName = byName;
    this.tableNames = names;
    return byName;
  }

  /**
   * The schema tables a reference may name (several when the same name exists
   * in more than one schema), or undefined when it names none (with an issue)
   * or a system catalog.
   */
  private resolveTable(ref: TableReference, index: Map<string, TableEntry[]>, issues: IssueList): TableEntry[] | undefined {
    const key = ref.name.toLowerCase();
    const schemaKey = ref.schema !== undefined ? ref.schema.toLowerCase() : undefined;
    const systemSchemas = SYSTEM_SCHEMAS[this.dialect] ?? SYSTEM_SCHEMAS.generic;
    if ((schemaKey !== undefined && systemSchemas.has(schemaKey)) || SYSTEM_TABLES.has(key)) return undefined;
    if (ref.name.charCodeAt(0) === 35 /* # */) return undefined; // T-SQL temporary table

    const written = (ref.schema !== undefined ? `${this.written(ref.schema, false)}.` : '') + this.written(ref.name, ref.quoted);
    const byName = index.get(key) || [];
    const candidates =
      schemaKey === undefined ? byName : byName.filter((e) => e.schemaKey === undefined || e.schemaKey === schemaKey);
    if (candidates.length === 0) {
      const sameName = byName.filter((e) => !e.hidden);
      const suggestions =
        sameName.length > 0
          ? sameName.map((e) => (e.table.schema ? `${e.table.schema}.${e.table.name}` : e.table.name))
          : closestNames(ref.name, this.tableNames!);
      issues.add({
        kind: 'unknown_table',
        name: ref.name,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        message: `Unknown table ${written}${this.didYouMean(suggestions, true)}`,
      });
      return undefined;
    }
    if (this.dialect !== 'postgres') return candidates;
    if (!this.schema.exactNames) {
      // The schema's case may not be the database's (see DatabaseSchema.exactNames):
      // match case-insensitively, as in 0.0.1. A reserved word still needs quotes.
      if (!ref.quoted && ref.schema === undefined && isReservedKeyword(key, 'postgres')) {
        issues.add(this.quotingIssue(ref.name, candidates[0].table.name, undefined, 'Table', '', 'it is a reserved word'));
      }
      return candidates;
    }

    // Postgres folds unquoted names to lower case; quoted names must match exactly.
    const folded = ref.quoted ? ref.name : key;
    const exact = candidates.filter((e) => e.table.name === folded);
    if (exact.length > 0) {
      if (!ref.quoted && ref.schema === undefined && isReservedKeyword(folded, 'postgres')) {
        issues.add(this.quotingIssue(ref.name, exact[0].table.name, undefined, 'Table', '', 'it is a reserved word'));
      }
      return exact;
    }
    const match = candidates[0];
    if (ref.quoted) {
      issues.add({
        kind: 'unknown_table',
        name: ref.name,
        suggestions: [match.table.name],
        message: `Unknown table ${written} (quoted names are case-sensitive)${this.didYouMean([match.table.name], true)}`,
      });
    } else {
      issues.add(this.quotingIssue(ref.name, match.table.name, undefined, 'Table'));
    }
    // Resolve it anyway, so its columns are still checked.
    return candidates;
  }

  /**
   * Check a column against the tables it may belong to. `qualified` columns
   * come from `x.col`, bare ones from every table in the query.
   */
  private checkColumn(
    name: string,
    quoted: boolean,
    prefix: string,
    tables: TableEntry[],
    issues: IssueList,
    qualified: boolean
  ): void {
    const key = name.toLowerCase();
    let match: ColumnSchema | undefined;
    let owner: TableEntry | undefined;
    for (const entry of tables) {
      const list = entry.columns.get(key);
      if (!list) continue;
      // Case-insensitive match is enough, except for Postgres names known to be exact
      if (this.dialect !== 'postgres' || !this.schema.exactNames) return;
      const folded = quoted ? name : key;
      if (list.some((c) => c.name === folded)) return;
      // A hidden column, or any column of a hidden table, is not offered as the quoting fix:
      // the reference is reported as unknown.
      const shown = match || entry.hidden ? undefined : list.find((c) => !entry.hiddenColumns.has(c));
      if (shown) {
        match = shown;
        owner = entry;
      }
    }
    const written = prefix + this.written(name, quoted);
    const single = tables.length === 1 ? tables[0].table.name : undefined;
    if (match) {
      // Postgres: the column exists but is written with the wrong case or without quotes.
      if (quoted) {
        issues.add({
          kind: 'unknown_column',
          name,
          table: owner!.table.name,
          suggestions: [match.name],
          message: `Unknown column ${written} in table ${this.display(owner!.table.name)} (quoted names are case-sensitive)${this.didYouMean([match.name], false)}`,
        });
      } else {
        issues.add(this.quotingIssue(name, match.name, owner!.table.name, 'Column', prefix));
      }
      return;
    }

    // Suggestions come only from tables the model is shown: naming a hidden table in the
    // query must not reveal its columns
    const pool: string[] = [];
    for (const entry of tables) {
      if (entry.hidden) continue;
      for (const list of entry.columns.values()) for (const c of list) if (!entry.hiddenColumns.has(c)) pool.push(c.name);
    }
    const suggestions = closestNames(name, pool);
    let message: string;
    if (qualified) {
      message = `Unknown column ${written} in table ${this.display(single ?? tables[0].table.name)}`;
    } else {
      const used = tables.map((e) => this.display(e.table.name)).join(', ');
      message = `Unknown column ${written}: no table in the query (${used}) has it`;
      const elsewhere = this.tablesWithColumn(key, tables);
      if (elsewhere.length > 0) message += `; it exists in ${elsewhere.map((n) => this.display(n)).join(', ')}`;
    }
    issues.add({
      kind: 'unknown_column',
      name,
      table: qualified ? single ?? tables[0].table.name : single,
      suggestions: suggestions.length > 0 ? suggestions : undefined,
      message: message + this.didYouMean(suggestions, false),
    });
  }

  private quotingIssue(
    name: string,
    actual: string,
    table: string | undefined,
    what: string,
    prefix = '',
    reason = 'unquoted names are folded to lower case'
  ): IdentifierIssue {
    const issue: IdentifierIssue = {
      kind: 'needs_quoting',
      name,
      suggestions: [actual],
      message: `${what} ${prefix}${name} must be written ${prefix}${quoteIdentifier(actual, this.dialect)} (${reason})`,
    };
    if (table !== undefined) issue.table = table;
    return issue;
  }

  /** Schema tables outside `exclude` that have a column named `key` (lowercase), hidden ones left out. */
  private tablesWithColumn(key: string, exclude: TableEntry[]): string[] {
    const found: string[] = [];
    for (const list of this.byName!.values()) {
      for (const entry of list) {
        if (entry.hidden || exclude.indexOf(entry) !== -1) continue;
        const columns = entry.columns.get(key);
        if (columns && columns.some((c) => !entry.hiddenColumns.has(c))) found.push(entry.table.name);
        if (found.length >= MAX_SUGGESTIONS) return found;
      }
    }
    return found;
  }

  private didYouMean(names: string[], tables: boolean): string {
    if (names.length === 0) return '';
    const shown = names.map((n) => (tables ? n.split('.').map((p) => this.display(p)).join('.') : this.display(n)));
    return `; did you mean ${shown.join(' or ')}?`;
  }
}

/**
 * Check the tables and columns `sql` references against `schema`.
 *
 * Reports unknown tables (schema-qualified, case-insensitive matching), unknown
 * qualified columns (resolved through aliases), unknown bare columns (only when
 * every table in the query is known) and, for Postgres, names that must be
 * quoted (`FROM User` when the table is `"User"`). CTEs, derived tables, table
 * functions and system catalogs are skipped.
 *
 * @param sql - Query to check
 * @param schema - Schema the query should use
 * @param dialect - SQL dialect (default: from `schema.databaseType`)
 * @returns The issues found; empty when there are none or the query cannot be lexed
 */
export function checkIdentifiers(sql: string, schema: DatabaseSchema, dialect?: SqlDialect): IdentifierIssue[] {
  return new IdentifierChecker(schema, dialect ?? toSqlDialect(schema.databaseType)).check(sql);
}

/** Issues deduplicated by kind, name and table. */
class IssueList {
  items: IdentifierIssue[] = [];
  private seen = new Set<string>();

  add(issue: IdentifierIssue): void {
    const key = `${issue.kind}\u0000${issue.name.toLowerCase()}\u0000${(issue.table ?? '').toLowerCase()}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(issue);
  }
}

/** Lowercased last parts of called function names. */
function functionNames(functions: string[]): Set<string> {
  const names = new Set<string>();
  for (const f of functions) {
    const dot = f.lastIndexOf('.');
    names.add((dot >= 0 ? f.slice(dot + 1) : f).toLowerCase());
  }
  return names;
}

const isWordToken = (t: Token | undefined, v?: string): boolean =>
  !!t && t.type === 'word' && (v === undefined || t.value === v);
const isPunctToken = (t: Token | undefined, v: string): boolean => !!t && t.type === 'punct' && t.value === v;
const isNameToken = (t: Token | undefined): boolean => !!t && (t.type === 'word' || t.type === 'quoted');

/**
 * Whether a FROM list (or a JOIN/APPLY) contains a table function or a
 * VALUES list, whose columns the schema cannot describe. One pass per
 * statement, tracking the current clause per parenthesis depth.
 */
function hasOpaqueSource(statements: Token[][]): boolean {
  for (const t of statements) {
    // Per open group: is it a query (its FROM is a clause), and are we in its FROM list?
    const isQuery: boolean[] = [true];
    const inFrom: boolean[] = [false];
    for (let i = 0; i < t.length; i++) {
      const tok = t[i];
      const depth = isQuery.length - 1;
      if (tok.type === 'punct') {
        if (tok.value === '(') {
          const next = t[i + 1];
          isQuery.push(isWordToken(next) && QUERY_HEADS.has(next.value));
          inFrom.push(false);
        } else if (tok.value === ')') {
          if (isQuery.length > 1) {
            isQuery.pop();
            inFrom.pop();
          }
        } else if (tok.value === ',' && inFrom[depth] && tableItemIsOpaque(t, i + 1)) {
          return true;
        }
        continue;
      }
      if (tok.type !== 'word' || isPunctToken(t[i - 1], '.')) continue;
      const v = tok.value;
      if (v === 'FROM') {
        // Not `IS [NOT] DISTINCT FROM` and not a function argument (EXTRACT(x FROM y)).
        if (!isQuery[depth] || isWordToken(t[i - 1], 'DISTINCT')) continue;
        inFrom[depth] = true;
        if (tableItemIsOpaque(t, i + 1)) return true;
      } else if (TABLE_INTRODUCERS.has(v)) {
        if (tableItemIsOpaque(t, i + 1)) return true;
      } else if (inFrom[depth] && FROM_LIST_END.has(v)) {
        inFrom[depth] = false;
      }
    }
  }
  return false;
}

/** Whether the table item starting at `k` is a table function or `(VALUES ...)`. */
function tableItemIsOpaque(t: Token[], k: number): boolean {
  while (isWordToken(t[k]) && TABLE_ITEM_PREFIXES.has(t[k].value)) k++;
  const tok = t[k];
  if (!tok) return false;
  if (isPunctToken(tok, '(')) {
    let j = k + 1;
    while (isPunctToken(t[j], '(')) j++;
    return isWordToken(t[j], 'VALUES');
  }
  if (!isNameToken(tok)) return false;
  let j = k + 1;
  while (isPunctToken(t[j], '.') && isNameToken(t[j + 1])) j += 2;
  return isPunctToken(t[j], '(');
}

const UNDERSCORES = /_/g;

/** Lowercase, without underscores, so `created_at` and `createdAt` compare equal. */
function normalizeName(name: string): string {
  const lower = name.toLowerCase();
  return lower.indexOf('_') === -1 ? lower : lower.replace(UNDERSCORES, '');
}

/**
 * Up to three names from `candidates` that look like `name`: equal once case
 * and underscores are ignored, within a small edit distance, or containing one
 * another.
 */
function closestNames(name: string, candidates: string[]): string[] {
  const target = normalizeName(name);
  if (target.length === 0) return [];
  const scored: Array<{ name: string; score: number }> = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const other = normalizeName(candidate);
    if (other.length === 0) continue;
    const limit = Math.max(1, Math.floor(Math.max(target.length, other.length) / 3));
    let score: number;
    if (other === target) {
      score = 0;
    } else {
      score = boundedEditDistance(target, other, limit);
      if (score > limit) {
        const shorter = Math.min(target.length, other.length);
        if (shorter < 3 || !(other.includes(target) || target.includes(other))) continue;
        score = limit + 1;
      }
    }
    scored.push({ name: candidate, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length || (a.name < b.name ? -1 : 1));
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.name);
}

/** Three rows of the edit-distance table, reused across calls (grown when needed). */
let rows = new Int32Array(3 * 64);

/**
 * Edit distance counting a swap of two adjacent letters as one edit
 * (optimal string alignment), or `limit + 1` as soon as it must exceed `limit`.
 */
function boundedEditDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const width = b.length + 1;
  if (rows.length < 3 * width) rows = new Int32Array(3 * width);
  // Row offsets: two rows back, previous row, current row.
  let before = 0;
  let prev = width;
  let curr = 2 * width;
  for (let j = 0; j < width; j++) {
    rows[before + j] = 0;
    rows[prev + j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    rows[curr] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j < width; j++) {
      const cb = b.charCodeAt(j - 1);
      let value = Math.min(rows[prev + j] + 1, rows[curr + j - 1] + 1, rows[prev + j - 1] + (ca === cb ? 0 : 1));
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) {
        value = Math.min(value, rows[before + j - 2] + 1);
      }
      rows[curr + j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    const oldest = before;
    before = prev;
    prev = curr;
    curr = oldest;
  }
  return rows[prev + b.length];
}
