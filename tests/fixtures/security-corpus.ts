/**
 * Validation fixtures for the security layer: the research-harness corpus
 * (tests/fixtures/sql-corpus.ts) plus cases written for the token-based
 * validator. Every valid query must be accepted (with requireUserContext:
 * false, allowUnion: true and its operation allowed); every dangerous query
 * must be rejected with the listed message fragment.
 */

import { valid, validEdgeCases, dangerous, CorpusDialect } from './sql-corpus';

export { valid, validEdgeCases, dangerous };
export type { CorpusDialect };

/** Corpus dialects, plus `generic` for validators built the 0.0.1 way (no options). */
export type SecurityDialect = CorpusDialect | 'generic';

export const CORPUS_DIALECTS: CorpusDialect[] = ['postgres', 'mysql', 'sqlite', 'mssql'];
export const ALL_DIALECTS: SecurityDialect[] = ['postgres', 'mysql', 'sqlite', 'mssql', 'generic'];

/**
 * Valid queries whose names, strings, quoted identifiers and operators look
 * like dangerous keywords or comments, and the statements other than SELECT.
 */
export const validLookalikes: Record<SecurityDialect, string[]> = {
  postgres: [
    'SELECT id, created_at, executed_at, dropoff_time, alternate_email, update_count, grant_amount, revoked_at, truncated_text FROM rides LIMIT 10',
    'SELECT * FROM grants LIMIT 5',
    'SELECT "drop", "delete", "exec", "createdAt" FROM "User" LIMIT 5',
    'SELECT t.drop, t.create, t.update FROM audit t LIMIT 5',
    "SELECT id FROM orders WHERE status = 'dropped' OR note = 'DROP TABLE x; DELETE FROM y --' LIMIT 5",
    "SELECT id FROM t WHERE note = 'union select password from users' LIMIT 5",
    "SELECT id FROM t WHERE note LIKE '%/* x */%' LIMIT 5",
    "SELECT id FROM t WHERE body = 'EXEC xp_cmdshell; WAITFOR DELAY' LIMIT 5",
    "SELECT jsonb_path_query(data, '$.items[*] ? (@.qty > 1)') FROM carts LIMIT 5",
    'SELECT id FROM t WHERE a = $1 AND b = $2 LIMIT 1',
    "SELECT $$it's -- not a comment; DROP TABLE x$$ AS s",
    'SELECT tags[1], tags[2:3] FROM posts LIMIT 5',
    'SELECT a FROM t1 EXCEPT SELECT a FROM t2',
    'SELECT id FROM orders ORDER BY id LIMIT 10 OFFSET 5',
    'SELECT id FROM orders WHERE total > 0 FETCH FIRST 10 ROWS ONLY',
    'SELECT count(*) FILTER (WHERE status = \'paid\') FROM invoices',
    'SELECT setting_name FROM settings WHERE set_by = 1 LIMIT 5',
    'SELECT ts_headline(body, q), to_tsvector(body) FROM docs, to_tsquery(\'x\') q LIMIT 5',
    'WITH m AS (SELECT 1 AS x) SELECT x FROM m',
    'UPDATE orders SET status = 1 WHERE id = 2',
    'UPDATE orders SET status = 1 WHERE id = 2 RETURNING id',
    'DELETE FROM orders WHERE id = 2',
    "INSERT INTO orders (id, status) VALUES (1, 'new')",
    'INSERT INTO orders (id) SELECT id FROM drafts',
    'INSERT INTO orders (id) VALUES (1) ON CONFLICT (id) DO NOTHING',
  ],
  mysql: [
    'SELECT `drop`, `select`, `exec` FROM t LIMIT 5',
    'SELECT id, created_at, executed_at, dropoff_time, alternate_email, update_count FROM rides LIMIT 10',
    'SELECT id FROM t WHERE note = "DROP TABLE x; -- " LIMIT 5',
    'SELECT 1--1',
    'SELECT id FROM t USE INDEX (idx_a) WHERE a = 1 LIMIT 5',
    'SELECT id FROM t FORCE INDEX (idx_a) LIMIT 5',
    'SELECT TRUNCATE(price, 2) FROM products LIMIT 5',
    "SELECT INSERT('abc', 1, 1, 'x'), REPLACE(name, 'a', 'b') FROM t LIMIT 5",
    "SELECT IF(a > 1, 'x', 'y') FROM t LIMIT 5",
    "SELECT id FROM t WHERE name = 'O''Brien' LIMIT 5",
    "SELECT id FROM t WHERE path LIKE 'C:\\\\temp\\\\%' LIMIT 5",
    "SELECT id FROM t WHERE note = 'line\\nbreak' LIMIT 5",
    'SELECT id FROM orders LIMIT 10, 20',
    "UPDATE orders SET status = 'x' WHERE id = 1 ORDER BY id LIMIT 1",
    "INSERT INTO orders SET id = 1, status = 'new'",
  ],
  sqlite: [
    'SELECT [drop], [order] FROM [t] LIMIT 5',
    'SELECT `drop` FROM t LIMIT 5',
    "SELECT id FROM t WHERE note = 'x -- y; DROP' LIMIT 5",
    'SELECT id FROM t LIMIT 10 OFFSET 20',
    'SELECT id, created_at, executed_at FROM t LIMIT 5',
    'DELETE FROM orders WHERE id = 1',
  ],
  mssql: [
    'SELECT TOP 10 [drop], [exec], [delete] FROM [t]',
    'SELECT TOP 10 u.id FROM users u INNER MERGE JOIN orders o ON o.user_id = u.id',
    'SELECT TOP 10 id FROM orders OPTION (RECOMPILE)',
    'SELECT TOP 10 id, [open], [close] FROM prices',
    'SELECT TOP 10 id FROM users WHERE email = @email',
    'SELECT TOP 10 CONVERT(varchar(10), created_at, 120) FROM orders',
    'SELECT TOP 10 id FROM orders WITH (NOLOCK) WHERE status = 1',
    "SELECT TOP 10 id FROM t WHERE note = N'EXEC xp_cmdshell'",
    'UPDATE orders SET status = 1 WHERE id = 2',
    'DELETE FROM orders WHERE id = 2',
  ],
  generic: [
    'SELECT open, close, high, low FROM prices ORDER BY close LIMIT 5',
    'SELECT MIN(ts) begin, MAX(ts) finish FROM events',
    'SELECT id, created_at, executed_at, grants, dropoff_time, alternate_email, update_count, "drop" FROM t LIMIT 5',
    'SELECT set_name, use_count FROM stats LIMIT 5',
    "SELECT id FROM t WHERE note = 'a--b; c /* d */' LIMIT 5",
    'SELECT TOP 10 id FROM t',
    'SELECT id FROM t WHERE x = -1 LIMIT 5',
    'SELECT a - -1 FROM t LIMIT 5',
  ],
};

/** Dangerous queries per dialect, with a fragment of the expected error. */
export const dangerousCases: Record<SecurityDialect, Array<[string, string]>> = {
  postgres: [
    ['SELECT pg_sleep(10)', 'function PG_SLEEP'],
    ['SELECT * FROM users WHERE id = 1 OR pg_sleep(10) IS NOT NULL', 'function PG_SLEEP'],
    ['SELECT pg_catalog.pg_sleep(1)', 'function PG_CATALOG.PG_SLEEP'],
    ['SELECT "pg_sleep"(1)', 'function PG_SLEEP'],
    ['SELECT pg_sleep  (1)', 'function PG_SLEEP'],
    ["SELECT * FROM ts_stat('SELECT to_tsvector(password) FROM users')", 'function TS_STAT'],
    ["SELECT query_to_xml('DELETE FROM users RETURNING *', true, true, '')", 'function QUERY_TO_XML'],
    ["SELECT nextval('orders_id_seq')", 'function NEXTVAL'],
    ['SELECT usename, passwd FROM pg_shadow', 'system table pg_shadow'],
    ['SELECT rolpassword FROM pg_catalog.pg_authid', 'system table pg_catalog.pg_authid'],
    ['SELECT * FROM pg_user_mappings', 'system table pg_user_mappings'],
    ['SELECT * FROM users FOR SHARE', 'FOR SHARE'],
    ['SELECT * FROM users FOR KEY SHARE', 'FOR SHARE'],
    ['SELECT * FROM users WHERE id = 1 FOR UPDATE SKIP LOCKED', 'FOR UPDATE'],
    ['SELECT * INTO TEMP copy FROM users', 'SELECT INTO'],
    ['WITH x AS (INSERT INTO log VALUES (1) RETURNING *) SELECT * FROM x', 'statement INSERT'],
    ['WITH x AS (MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE) SELECT 1', 'statement MERGE'],
    ['SELECT * FROM (SELECT 1) a WHERE EXISTS (DELETE FROM users)', 'statement DELETE'],
    ['SELECT 1 /* hidden */', '/*'],
    ['SELECT 1 -- hidden', '--'],
    ['SELECT 1--x', '--'],
    ['SELECT * FROM users; SELECT * FROM secrets', 'Multiple statements detected'],
    ['SELECT * FROM users\n;\nUPDATE users SET admin = true', 'Multiple statements detected'],
    ['SELECT a FROM t UNION SELECT password FROM users', 'UNION.*SELECT'],
    ['SELECT {fn NOW()}', 'ODBC escape'],
    ["SELECT 'unterminated", 'Malformed SQL'],
    ['SELECT "unterminated', 'Malformed SQL'],
    ['SELECT 1 /* unterminated', 'Malformed SQL'],
    ['SELECT $tag$ unterminated', 'Malformed SQL'],
    ['SELECT * FROM t WHERE (a = 1', 'Unbalanced parentheses'],
  ],
  mysql: [
    ["SELECT * FROM users INTO DUMPFILE '/tmp/x'", 'INTO DUMPFILE'],
    ['SELECT id INTO @x FROM users', 'SELECT INTO'],
    ['SELECT id FROM users LIMIT 1 INTO @x', 'SELECT INTO'],
    ['SELECT * FROM users LOCK IN SHARE MODE', 'LOCK IN SHARE MODE'],
    ['SELECT /*!50000 SLEEP(5) */ 1', 'executable comment /*!'],
    ['SELECT /*M! SLEEP(5) */ 1', 'executable comment /*M!'],
    ['SELECT 1 # hidden', '#'],
    ["SELECT * FROM t WHERE a = 'O\\'Brien'", 'ambiguous string escaping'],
    ["SELECT * FROM t WHERE a = '\\' AND b = ' OR 1=1 -- '", 'ambiguous string escaping'],
    ['SELECT * FROM t WHERE a = "\\" AND b = " OR 1=1 -- "', 'ambiguous string escaping'],
    ['SELECT user, authentication_string FROM mysql.user', 'system table mysql.user'],
    ["SELECT GET_LOCK('x', 10)", 'function GET_LOCK'],
    ['SELECT * FROM users LIMIT 5, 2000', 'LIMIT 2000 exceeds maximum allowed limit of 1000'],
    ["SELECT {fn CONCAT('a', 'b')}", 'ODBC escape'],
    ["SELECT 'unterminated", 'Malformed SQL'],
  ],
  sqlite: [
    ["SELECT readfile('/etc/passwd')", 'function READFILE'],
    ["SELECT writefile('/tmp/x', 'y')", 'function WRITEFILE'],
    ["SELECT * FROM fsdir('/')", 'function FSDIR'],
    ["SELECT eval('DELETE FROM users')", 'function EVAL'],
    ['SELECT * FROM users LIMIT -1', 'LIMIT -1 exceeds maximum allowed limit of 1000'],
    ["SELECT 1; ATTACH DATABASE '/tmp/x.db' AS x", 'Multiple statements detected'],
    ['SELECT 1 /* hidden */', '/*'],
  ],
  mssql: [
    ['SELECT 1 DELETE FROM users', 'Multiple statements detected'],
    ["SELECT * FROM users WAITFOR DELAY '00:00:10'", 'Multiple statements detected'],
    ["SELECT 1 EXEC('DROP TABLE users')", 'EXEC'],
    ['SELECT 1 DROP TABLE users', 'DROP'],
    ['SELECT name FROM users TRUNCATE TABLE users', 'TRUNCATE'],
    ["SELECT 1 EXEC master..xp_cmdshell 'dir'", 'xp_cmdshell'],
    ['SELECT 1 SHUTDOWN', 'Multiple statements detected'],
    ['SELECT 1 BEGIN TRAN DELETE FROM users COMMIT', 'Multiple statements detected'],
    ['SELECT 1 SET ROWCOUNT 0', 'Multiple statements detected'],
    ['SELECT * FROM t WHERE (1=1) IF 1=1 DELETE FROM users', 'Multiple statements detected'],
    ['UPDATE users SET admin = 1 SET @x = 1', 'Multiple statements detected'],
    ['SELECT name FROM sys.sql_logins', 'system table sys.sql_logins'],
    ['SELECT * FROM syslogins', 'system table syslogins'],
    ['SELECT * INTO #tmp FROM users', 'SELECT INTO'],
    ["SELECT * FROM OPENQUERY(srv, 'SELECT 1')", 'function OPENQUERY'],
    ["SELECT {d '2020-01-01'}", 'ODBC escape'],
    ['SELECT TOP 5000 * FROM users', 'LIMIT 5000 exceeds maximum allowed limit of 1000'],
    ['SELECT TOP (5000) * FROM users', 'LIMIT 5000 exceeds maximum allowed limit of 1000'],
    ['SELECT [unterminated FROM t', 'Malformed SQL'],
  ],
  generic: [
    ['SELECT 1--x', '--'],
    ['SELECT 1 FROM t WHERE a = 1 -->', '--'],
    ['SELECT * FROM t WHERE a <> $x$ ORDER BY $x$', 'ambiguous dollar quoting'],
    ['SELECT $$a$$', 'ambiguous dollar quoting'],
    ["SELECT * FROM t WHERE a = '\\' AND b = ' OR 1=1 -- '", 'ambiguous string escaping'],
    ["SELECT * FROM t WHERE a <> E'\\' AND b <> ' OR 1=1 -- '", 'ambiguous string escaping'],
    ["SELECT 'it\\'s'", 'ambiguous string escaping'],
    ["SELECT a #>> '{a}' FROM t", '#'],
    ['SELECT 1 DELETE FROM t', 'Multiple statements detected'],
    ['SELECT /*! 1 */', 'executable comment /*!'],
    ['SELECT * FROM users; DROP TABLE users', 'Multiple statements detected, DROP'],
  ],
};

/** Every ODBC escape form, each of which is rejected in every dialect. */
export const odbcEscapes: Array<[string, string]> = [
  ['fn', 'SELECT {fn NOW()} AS now'],
  ['oj', 'SELECT * FROM {oj t1 LEFT OUTER JOIN t2 ON t1.id = t2.id}'],
  ['d', "SELECT * FROM t WHERE created = {d '2020-01-01'}"],
  ['t', "SELECT * FROM t WHERE at_time = {t '10:00:00'}"],
  ['ts', "SELECT * FROM t WHERE created > {ts '2020-01-01 00:00:00'}"],
  ['call', 'SELECT * FROM t WHERE id IN ({call get_ids()})'],
  ['escape', "SELECT * FROM t WHERE name LIKE 'a!%' {escape '!'}"],
  ['interval', "SELECT {fn TIMESTAMPADD(SQL_TSI_DAY, 1, {fn NOW()})}"],
];

/** Queries from the 0.0.1 test files (tests/security/*.test.ts as published). */
export const legacyTestQueries: string[] = [
  'SELECT * FROM users; DROP TABLE users',
  'SELECT * FROM users UNION SELECT * FROM passwords',
  'DROP TABLE users',
  'EXEC sp_executesql @sql',
  "EXEC xp_cmdshell 'dir'",
  'SELECT * FROM users WHERE id = 1',
  'SELECT * FROM users',
  'INSERT INTO users VALUES (1)',
  'SELECT * FROM admin_secrets',
  'SELECT id, name FROM users',
  'SELECT password FROM users',
  'SELECT * FROM users LIMIT 50',
  'SELECT * FROM users LIMIT 500',
  'SELECT * FROM orders',
  'SELECT * FROM orders WHERE user_id = 123',
  'SELECT * FROM users -- comment here',
  'SELECT * /* comment */ FROM users',
  'SELECT * FROM users;;',
  'SELECT   *\n  FROM\n  users',
  'SELECT * FROM users\0',
  "INSERT INTO users (name) VALUES ('John')",
  'INVALID QUERY',
  'SELECT * FROM users WHERE (id = 1',
  "SELECT * FROM users WHERE name = 'John",
];
