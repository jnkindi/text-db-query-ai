/**
 * Differential tests of the security layer against the published 0.0.1 build
 * (devDependency `text-db-query-ai-legacy`):
 *
 * (a) every query 0.0.1 accepts is still accepted, unless it is listed in
 *     DANGEROUS_NOW_REJECTED with the reason (these are the CHANGELOG lines);
 * (b) for simple single-table queries, addRowLevelSecurity and
 *     addLimitIfMissing produce the 0.0.1 text;
 * (c) sanitize() produces the 0.0.1 text for comment-free input without
 *     significant whitespace inside literals.
 */

import { SecurityValidator } from '../../src/security/validator';
import { QuerySanitizer } from '../../src/security/sanitizer';
import { tokenize, SqlLexError } from '../../src/sql';
import { DatabaseType, SecurityConfig } from '../../src/types';
import {
  ALL_DIALECTS,
  CORPUS_DIALECTS,
  SecurityDialect,
  valid,
  validEdgeCases,
  dangerous,
  validLookalikes,
  dangerousCases,
  odbcEscapes,
  legacyTestQueries,
} from '../fixtures/security-corpus';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('text-db-query-ai-legacy');

jest.setTimeout(60000);

// Reasons, one CHANGELOG line each
const STACKED = 'Stacked statements are rejected even with a trailing ";" (0.0.1 accepted "SELECT 1; DELETE FROM users;").';
const TSQL_STACKED = 'T-SQL statements that follow another without ";" (SELECT 1 DELETE FROM t, ... WAITFOR, SHUTDOWN, SET) count as multiple statements on mssql and in the generic dialect.';
const SELECT_INTO = 'SELECT ... INTO (a new table, a variable, INTO OUTFILE / DUMPFILE) is rejected.';
const LOCKING = 'Locking reads (FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE, FOR KEY SHARE, LOCK IN SHARE MODE) are rejected.';
const FUNCTIONS = 'Calls to functions that sleep, read or write server files, open connections, change settings, take locks, advance sequences or run SQL from a string (DEFAULT_BLOCKED_FUNCTIONS, configurable with blockedFunctions / allowedFunctions) are rejected.';
const SYSTEM_TABLES = 'Reading credential tables (pg_shadow, pg_authid, pg_user_mapping(s), mysql.user, sys.sql_logins, syslogins) is rejected.';
const NESTED_DML = 'Data-modifying statements nested in a query (writable CTEs, (DELETE ...)) need their operation in allowedOperations; upserts (ON CONFLICT DO UPDATE, ON DUPLICATE KEY UPDATE, INSERT OR REPLACE) need UPDATE.';
const ODBC = 'ODBC escape sequences ({fn ...}, {oj ...}, {d ...}, {t ...}, {ts ...}, {call ...}, {escape ...}) are rejected: they are server-side syntax that generated SQL never needs.';
const MALFORMED = 'Malformed SQL (an unterminated string, quoted identifier or comment, or unbalanced parentheses) is rejected by validate() instead of reaching the database.';
const AMBIGUOUS_ESCAPES = 'On MySQL and in the generic dialect, a string whose end depends on backslash escaping (NO_BACKSLASH_ESCAPES) is rejected; write quotes as \'\' instead of \\\'.';
const GENERIC_HASH = 'In the generic dialect (no databaseType) "#" starts a MySQL comment but is an operator to Postgres, so queries with "#" are rejected; set databaseType.';
const GENERIC_DOLLAR = 'In the generic dialect "$...$" is a Postgres dollar-quoted string to the database but code to the validator, so it is rejected; set databaseType.';
const MYSQL_HASH = 'MySQL "#" comments in a query given straight to validate() are reported like "--" and "/*" (the sanitizer removes them in the generator).';
const LIMIT_COUNT = 'The row limit is read per dialect: MySQL LIMIT offset, count; TOP n; FETCH FIRST n ROWS; LIMIT -1 (unlimited in SQLite); hex and exponent counts. 0.0.1 read only the first digits after LIMIT.';
const TABLES = 'allowedTables now sees quoted, backticked, bracketed, schema-qualified and comma-listed tables (0.0.1 missed them, so they bypassed the allowlist).';

/**
 * Queries 0.0.1 accepted that are now rejected because they are dangerous or
 * malformed, with the reason. Keyed by the exact query text.
 */
const DANGEROUS_NOW_REJECTED: ReadonlyArray<[string, string]> = [
  ['SELECT 1; DELETE FROM users;', STACKED],

  ['SELECT 1 DELETE FROM users', TSQL_STACKED],
  ['SELECT 1 DELETE FROM t', TSQL_STACKED],
  ["SELECT * FROM users WAITFOR DELAY '00:00:10'", TSQL_STACKED],
  ['SELECT 1 SHUTDOWN', TSQL_STACKED],
  ['SELECT 1 BEGIN TRAN DELETE FROM users COMMIT', TSQL_STACKED],
  ['SELECT 1 SET ROWCOUNT 0', TSQL_STACKED],
  ['SELECT * FROM t WHERE (1=1) IF 1=1 DELETE FROM users', TSQL_STACKED],
  ['UPDATE users SET admin = 1 SET @x = 1', TSQL_STACKED],

  ['SELECT * INTO backup_users FROM users', SELECT_INTO],
  ['SELECT * INTO TEMP copy FROM users', SELECT_INTO],
  ['SELECT * INTO #tmp FROM users', SELECT_INTO],
  ["SELECT * FROM users INTO OUTFILE '/tmp/x'", SELECT_INTO],
  ["SELECT * FROM users INTO DUMPFILE '/tmp/x'", SELECT_INTO],
  ['SELECT id INTO @x FROM users', SELECT_INTO],
  ['SELECT id FROM users LIMIT 1 INTO @x', SELECT_INTO],

  ['SELECT * FROM users FOR UPDATE', LOCKING],
  ['SELECT * FROM users FOR NO KEY UPDATE', LOCKING],
  ['SELECT * FROM users FOR SHARE', LOCKING],
  ['SELECT * FROM users FOR KEY SHARE', LOCKING],
  ['SELECT * FROM users WHERE id = 1 FOR UPDATE SKIP LOCKED', LOCKING],
  ['SELECT * FROM users LOCK IN SHARE MODE', LOCKING],

  ['SELECT pg_sleep(100)', FUNCTIONS],
  ['SELECT pg_sleep(10)', FUNCTIONS],
  ['SELECT * FROM users WHERE id = 1 OR pg_sleep(10) IS NOT NULL', FUNCTIONS],
  ['SELECT pg_catalog.pg_sleep(1)', FUNCTIONS],
  ['SELECT "pg_sleep"(1)', FUNCTIONS],
  ['SELECT pg_sleep  (1)', FUNCTIONS],
  ["SELECT pg_read_file('/etc/passwd')", FUNCTIONS],
  ["SELECT lo_export(1, '/tmp/x')", FUNCTIONS],
  ["SELECT set_config('role', 'admin', false)", FUNCTIONS],
  ["SELECT * FROM dblink('host=x', 'DELETE FROM t') AS t(a int)", FUNCTIONS],
  ['SELECT pg_terminate_backend(123)', FUNCTIONS],
  ["SELECT * FROM ts_stat('SELECT to_tsvector(password) FROM users')", FUNCTIONS],
  ["SELECT query_to_xml('DELETE FROM users RETURNING *', true, true, '')", FUNCTIONS],
  ["SELECT nextval('orders_id_seq')", FUNCTIONS],
  ["SELECT LOAD_FILE('/etc/passwd')", FUNCTIONS],
  ['SELECT SLEEP(100)', FUNCTIONS],
  ["SELECT BENCHMARK(100000000, MD5('x'))", FUNCTIONS],
  ["SELECT GET_LOCK('x', 10)", FUNCTIONS],
  ["SELECT load_extension('/tmp/evil.so')", FUNCTIONS],
  ["SELECT readfile('/etc/passwd')", FUNCTIONS],
  ["SELECT writefile('/tmp/x', 'y')", FUNCTIONS],
  ["SELECT * FROM fsdir('/')", FUNCTIONS],
  ["SELECT eval('DELETE FROM users')", FUNCTIONS],
  ["SELECT * FROM OPENQUERY(srv, 'SELECT 1')", FUNCTIONS],

  ['SELECT usename, passwd FROM pg_shadow', SYSTEM_TABLES],
  ['SELECT rolpassword FROM pg_catalog.pg_authid', SYSTEM_TABLES],
  ['SELECT * FROM pg_user_mappings', SYSTEM_TABLES],
  ['SELECT user, authentication_string FROM mysql.user', SYSTEM_TABLES],
  ['SELECT name FROM sys.sql_logins', SYSTEM_TABLES],
  ['SELECT * FROM syslogins', SYSTEM_TABLES],

  ['SELECT * FROM (SELECT 1) a WHERE EXISTS (DELETE FROM users)', NESTED_DML],
  ['INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 2', NESTED_DML],
  ['INSERT INTO t (id) VALUES (1) ON DUPLICATE KEY UPDATE n = 2', NESTED_DML],
  ['INSERT OR REPLACE INTO t (id) VALUES (1)', NESTED_DML],

  ['SELECT {fn NOW()}', ODBC],
  ['SELECT {fn NOW()} AS now', ODBC],
  ['SELECT * FROM {oj t1 LEFT OUTER JOIN t2 ON t1.id = t2.id}', ODBC],
  ["SELECT * FROM t WHERE at_time = {t '10:00:00'}", ODBC],
  ['SELECT * FROM t WHERE id IN ({call get_ids()})', ODBC],
  ["SELECT * FROM t WHERE name LIKE 'a!%' {escape '!'}", ODBC],
  ['SELECT {fn TIMESTAMPADD(SQL_TSI_DAY, 1, {fn NOW()})}', ODBC],
  ["SELECT {fn CONCAT('a', 'b')}", ODBC],
  ["SELECT {d '2020-01-01'}", ODBC],

  ["SELECT 'unterminated", MALFORMED],
  ['SELECT "unterminated', MALFORMED],
  ['SELECT $tag$ unterminated', MALFORMED],
  ['SELECT [unterminated FROM t', MALFORMED],
  ['SELECT * FROM t WHERE (a = 1', MALFORMED],
  ['SELECT * FROM users WHERE (id = 1', MALFORMED],
  ["SELECT * FROM users WHERE name = 'John", MALFORMED],

  ["SELECT * FROM t WHERE a = 'O\\'Brien'", AMBIGUOUS_ESCAPES],
  ["SELECT 'it\\'s'", AMBIGUOUS_ESCAPES],

  ["SELECT a #>> '{a}' FROM t", GENERIC_HASH],
  ['SELECT * FROM t WHERE a <> $x$ ORDER BY $x$', GENERIC_DOLLAR],
  ['SELECT $$a$$', GENERIC_DOLLAR],
  ['SELECT 1 # hidden', MYSQL_HASH],

  ['SELECT * FROM users LIMIT 5, 2000', LIMIT_COUNT],
  ['SELECT * FROM users LIMIT -1', LIMIT_COUNT],
  ['SELECT TOP 5000 * FROM users', LIMIT_COUNT],
  ['SELECT TOP (5000) * FROM users', LIMIT_COUNT],
  ['SELECT * FROM t FETCH FIRST 5000 ROWS ONLY', LIMIT_COUNT],
  ['SELECT * FROM t LIMIT 1e9', LIMIT_COUNT],
  ['SELECT * FROM t LIMIT 0x7fffffff', LIMIT_COUNT],

  ['SELECT "u"."id" FROM "public"."User" AS "u" LIMIT 5', TABLES],
  ['SELECT * FROM `admin_secrets` LIMIT 10', TABLES],
  ['SELECT * FROM "admin_secrets" LIMIT 10', TABLES],
  ['SELECT * FROM users, admin_secrets LIMIT 10', TABLES],
];
const NOW_REJECTED = new Map(DANGEROUS_NOW_REJECTED);

/** Queries for behavior changes the corpora do not contain. */
const EXTRA: Array<[SecurityDialect, string]> = [
  ['postgres', 'INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 2'],
  ['mysql', 'INSERT INTO t (id) VALUES (1) ON DUPLICATE KEY UPDATE n = 2'],
  ['sqlite', 'INSERT OR REPLACE INTO t (id) VALUES (1)'],
  ['postgres', 'SELECT * FROM t FETCH FIRST 5000 ROWS ONLY'],
  ['postgres', 'SELECT * FROM t LIMIT 1e9'],
  ['mysql', 'SELECT * FROM t LIMIT 0x7fffffff'],
  ['mysql', 'SELECT * FROM `admin_secrets` LIMIT 10'],
  ['postgres', 'SELECT * FROM "admin_secrets" LIMIT 10'],
  ['postgres', 'SELECT * FROM users, admin_secrets LIMIT 10'],
];

const CONFIGS: Array<[string, SecurityConfig]> = [
  ['SELECT only', { requireUserContext: false }],
  ['all operations', { requireUserContext: false, allowedOperations: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] }],
  ['INSERT only', { requireUserContext: false, allowedOperations: ['INSERT'] }],
  ['0.0.1 test settings', { requireUserContext: false, allowedTables: ['users', 'orders'], restrictedColumns: ['password', 'ssn'], maxRowLimit: 100 }],
];

function corpusQueries(): Array<[SecurityDialect, string]> {
  const out: Array<[SecurityDialect, string]> = [];
  for (const d of CORPUS_DIALECTS) for (const q of [...valid[d], ...validEdgeCases[d], ...dangerous[d]]) out.push([d, q]);
  for (const d of ALL_DIALECTS) {
    for (const q of validLookalikes[d]) out.push([d, q]);
    for (const [q] of dangerousCases[d]) out.push([d, q]);
    for (const [, q] of odbcEscapes) out.push([d, q]);
  }
  for (const q of legacyTestQueries) out.push(['generic', q]);
  return out.concat(EXTRA);
}

const optionsFor = (d: SecurityDialect) => (d === 'generic' ? {} : { databaseType: d as DatabaseType });

describe('(a) what 0.0.1 accepts is still accepted, unless listed as dangerous', () => {
  const used = new Set<string>();

  it.each(CONFIGS)('%s', async (_name, config) => {
    const problems: string[] = [];
    for (const [dialect, sql] of corpusQueries()) {
      const before = await new legacy.SecurityValidator(config).validate(sql);
      if (!before.valid) continue;
      // The query's own dialect, and the generic dialect a 0.0.1-style constructor gets
      for (const d of new Set<SecurityDialect>([dialect, 'generic'])) {
        const after = await new SecurityValidator(config, optionsFor(d)).validate(sql);
        if (after.valid) continue;
        if (NOW_REJECTED.has(sql)) used.add(sql);
        else problems.push(`[${d}] ${sql}\n    ${after.errors.join(' | ')}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every DANGEROUS_NOW_REJECTED entry is a real change', () => {
    expect(DANGEROUS_NOW_REJECTED.map(([sql]) => sql).filter((sql) => !used.has(sql))).toEqual([]);
  });
});

describe('(b) row-level security and limits keep the 0.0.1 text for simple queries', () => {
  const v = new SecurityValidator({ enableRowLevelSecurity: true });
  const old = new legacy.SecurityValidator({ enableRowLevelSecurity: true });

  const EXACT = [
    'SELECT * FROM orders',
    'SELECT id, total FROM orders',
    "SELECT * FROM orders WHERE status = 'paid'",
    'SELECT * FROM orders WHERE total > 10 AND status = 1',
    'SELECT * FROM orders WHERE user_id = 123',
    'SELECT * FROM orders o',
    'UPDATE orders SET status = 1',
    'UPDATE orders SET status = 1 WHERE id = 2',
    'DELETE FROM orders',
    'DELETE FROM orders WHERE id = 2',
    'INSERT INTO orders (id) VALUES (1)',
  ];
  // 0.0.1 put an extra space before ORDER BY / LIMIT (" AND user_id = 1" + " ORDER BY")
  const MODULO_SPACES = [
    'SELECT * FROM orders ORDER BY id',
    'SELECT * FROM orders LIMIT 10',
    "SELECT * FROM orders WHERE status = 'paid' ORDER BY id LIMIT 5",
    'SELECT id FROM orders WHERE total > 1 LIMIT 5',
  ];
  const collapse = (s: string) => s.replace(/\s+/g, ' ');

  // `WHERE user_id = 123` for user 'abc-123' is the 0.0.1 bypass (any user_id in the WHERE skipped the filter)
  const cases = EXACT.flatMap((q) => (q.includes('user_id') ? [[q, 123]] : [[q, 123], [q, 'abc-123']]));

  it.each(cases)('%s (user %p)', (q, userId) => {
    const ctx = { userId: userId as string | number, role: 'user' };
    expect(v.addRowLevelSecurity(q as string, ctx)).toBe(old.addRowLevelSecurity(q, ctx));
  });

  it.each(MODULO_SPACES)('%s (same text up to spaces)', (q) => {
    const ctx = { userId: 123, role: 'user' };
    expect(v.addRowLevelSecurity(q, ctx)).toBe(collapse(old.addRowLevelSecurity(q, ctx)));
  });

  it.each([
    ['SELECT * FROM users', 100],
    ['SELECT * FROM users LIMIT 50', 100],
    ['SELECT * FROM users LIMIT 5000', 100],
    ['SELECT id FROM orders WHERE total > 5 ORDER BY id', 10],
    ["SELECT * FROM users WHERE name = 'x'", 1000],
  ])('addLimitIfMissing(%j, %p)', (q, n) => {
    const expected = new legacy.QuerySanitizer().addLimitIfMissing(q, n);
    expect(new QuerySanitizer().addLimitIfMissing(q as string, n as number)).toBe(expected);
    for (const d of ['postgres', 'mysql', 'sqlite'] as DatabaseType[]) {
      expect(new QuerySanitizer(d).addLimitIfMissing(q as string, n as number)).toBe(expected);
    }
  });
});

describe('(c) sanitize() keeps the 0.0.1 text for comment-free input', () => {
  /** No comment for the 0.0.1 regexes, no '#', no NUL, and no run of whitespace inside a literal. */
  function comparable(sql: string, dialect: SecurityDialect): boolean {
    if (/--|\/\*|#|\0/.test(sql)) return false;
    try {
      return !tokenize(sql, dialect === 'generic' ? 'generic' : dialect).some(
        (t) => (t.type === 'string' || t.type === 'quoted') && /\s\s|\n|\r|\t/.test(t.text)
      );
    } catch (error) {
      if (error instanceof SqlLexError) return true; // both fall back to the 0.0.1 steps
      throw error;
    }
  }

  const MULTILINE: Array<[SecurityDialect, string]> = [
    ['postgres', 'SELECT id,\n       total\n  FROM orders\n WHERE status = 1\n ORDER BY id;\n'],
    ['mysql', '\n\tSELECT `id`\n\tFROM `orders`\n\tLIMIT 10 ;  '],
    ['mssql', 'SELECT TOP 5 [id]\r\nFROM [orders]\r\n'],
    ['generic', '  WITH x AS (\n    SELECT 1 AS a\n  )\n  SELECT a FROM x;;'],
  ];

  it('for the corpora and the 0.0.1 test queries, in every dialect', () => {
    const old = new legacy.QuerySanitizer();
    const problems: string[] = [];
    let compared = 0;
    for (const [dialect, sql] of corpusQueries().concat(MULTILINE)) {
      for (const d of new Set<SecurityDialect>([dialect, 'generic'])) {
        if (!comparable(sql, d)) continue;
        compared++;
        const expected = old.sanitize(sql);
        const actual = new QuerySanitizer(d === 'generic' ? undefined : (d as DatabaseType)).sanitize(sql);
        if (actual !== expected) problems.push(`[${d}] ${JSON.stringify(sql)}\n    0.0.1: ${JSON.stringify(expected)}\n    now:   ${JSON.stringify(actual)}`);
      }
    }
    expect(problems).toEqual([]);
    expect(compared).toBeGreaterThan(300);
  });
});
