/**
 * Column candidates: keyword-heavy queries must yield no keyword false
 * candidates and must find the real columns (src/sql/analyze.ts)
 */

import { analyzeSql } from '../../src/sql/analyze';
import { SQL_KEYWORDS } from '../../src/sql/keywords';
import { SqlDialect } from '../../src/sql/lexer';

const uniqueSorted = (xs: string[]): string[] => [...new Set(xs)].sort();

function bare(sql: string, dialect: SqlDialect): string[] {
  return uniqueSorted(analyzeSql(sql, dialect).columns.filter((c) => c.qualifier === undefined).map((c) => c.name));
}

function qualified(sql: string, dialect: SqlDialect): string[] {
  return uniqueSorted(
    analyzeSql(sql, dialect)
      .columns.filter((c) => c.qualifier !== undefined)
      .map((c) => `${c.qualifier}.${c.name}`)
  );
}

// [dialect, sql, expected bare column candidates, expected qualified references (optional)]
type Case = [SqlDialect, string, string[], string[]?];

const CASES: Case[] = [
  ['postgres', 'SELECT EXTRACT(YEAR FROM created_at) AS yr, EXTRACT(EPOCH FROM updated_at) FROM orders', ['created_at', 'updated_at']],
  ['postgres', "SELECT id FROM orders WHERE created_at > NOW() - INTERVAL '1 day'", ['created_at', 'id']],
  ['mysql', 'SELECT id FROM orders WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) AND updated_at < NOW() - INTERVAL 1 HOUR', ['created_at', 'id', 'updated_at']],
  [
    'mssql',
    "SELECT id FROM orders WHERE created_at > DATEADD(day, -7, GETDATE()) AND DATEDIFF(month, created_at, GETDATE()) < 3 AND DATEPART(week, shipped_at) = 1 AND DATENAME(dw, shipped_at) = 'Monday'",
    ['created_at', 'id', 'shipped_at'],
  ],
  ['mysql', 'SELECT CAST(total_amount AS DECIMAL(10,2)), CAST(created_at AS DATE) FROM orders', ['created_at', 'total_amount']],
  [
    'postgres',
    'SELECT created_at::date, total_amount::numeric(12,2), status::text, meta::jsonb, x::public.my_enum, y::timestamp with time zone FROM orders',
    ['created_at', 'meta', 'status', 'total_amount', 'x', 'y'],
  ],
  ['postgres', 'SELECT name COLLATE "C", title COLLATE pg_catalog."default" FROM products ORDER BY name COLLATE "en_US"', ['name', 'title']],
  ['mysql', 'SELECT CONVERT(name USING utf8mb4), CONVERT(bio, CHAR) FROM users', ['bio', 'name']],
  [
    'postgres',
    "SELECT SUM(total_amount) OVER (PARTITION BY status ORDER BY created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running, AVG(total_amount) OVER (ORDER BY created_at RANGE BETWEEN INTERVAL '7 days' PRECEDING AND CURRENT ROW) FROM orders",
    ['created_at', 'status', 'total_amount'],
  ],
  [
    'postgres',
    'SELECT id, rank() OVER w, sum(total_amount) OVER (w ROWS UNBOUNDED PRECEDING) FROM orders WINDOW w AS (PARTITION BY customer_id ORDER BY created_at DESC)',
    ['created_at', 'customer_id', 'id', 'total_amount'],
  ],
  [
    'postgres',
    "SELECT COUNT(*) FILTER (WHERE status = 'paid') AS paid, SUM(total_amount) FILTER (WHERE refunded IS NOT TRUE) FROM invoices",
    ['refunded', 'status', 'total_amount'],
  ],
  ['postgres', 'SELECT id FROM orders ORDER BY shipped_at DESC NULLS LAST, created_at ASC NULLS FIRST FETCH FIRST 10 ROWS ONLY', ['created_at', 'id', 'shipped_at']],
  ['postgres', 'SELECT id FROM orders ORDER BY created_at OFFSET 5 ROWS FETCH NEXT 10 ROWS WITH TIES', ['created_at', 'id']],
  ['postgres', 'SELECT DISTINCT ON (customer_id) customer_id, created_at FROM orders ORDER BY customer_id, created_at DESC', ['created_at', 'customer_id']],
  [
    'postgres',
    "SELECT id FROM users WHERE email ILIKE '%@x.com' AND name SIMILAR TO '(A|B)%' AND nickname IS DISTINCT FROM display_name AND bio NOT ILIKE 'x!%' ESCAPE '!'",
    ['bio', 'display_name', 'email', 'id', 'name', 'nickname'],
  ],
  [
    'postgres',
    "SELECT CASE WHEN total_amount > 100 THEN 'big' WHEN status = 'void' THEN NULL ELSE 'small' END AS size, CASE status WHEN 'a' THEN 1 END FROM orders",
    ['status', 'total_amount'],
  ],
  [
    'postgres',
    "SELECT metadata->>'source', metadata->'a'->>'b', data #>> '{a,b}', tags ? 'vip' FROM events WHERE payload @> '{\"x\":1}'",
    ['data', 'metadata', 'payload', 'tags'],
  ],
  [
    'postgres',
    "SELECT ARRAY[id, parent_id], tags && ARRAY['a','b'] FROM nodes WHERE id = ANY(ARRAY[1,2,3]) AND parent_id = ANY($1) AND kind <> ALL('{a,b}'::text[])",
    ['id', 'kind', 'parent_id', 'tags'],
  ],
  [
    'postgres',
    "SELECT d::date AS day, COUNT(o.id) FROM generate_series(NOW() - INTERVAL '30 days', NOW(), INTERVAL '1 day') AS g(d) LEFT JOIN orders o ON o.created_at::date = d::date GROUP BY d",
    [],
    ['o.created_at', 'o.id'],
  ],
  [
    'postgres',
    'INSERT INTO counters (id, hits) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET hits = counters.hits + excluded.hits',
    ['hits', 'id'],
    ['counters.hits', 'excluded.hits'],
  ],
  ['mssql', 'SELECT TOP 10 id, total_amount FROM orders ORDER BY total_amount DESC', ['id', 'total_amount']],
  ['mssql', 'SELECT TOP (5) PERCENT WITH TIES id FROM orders ORDER BY created_at', ['created_at', 'id']],
  ['mssql', "SELECT o.id, status FROM orders o WITH (NOLOCK, READPAST) WHERE status = 'x'", ['status'], ['o.id']],
  [
    'postgres',
    'SELECT status, region, SUM(total_amount) FROM orders GROUP BY ROLLUP (status, region), CUBE (channel), GROUPING SETS ((status), ())',
    ['channel', 'region', 'status', 'total_amount'],
  ],
  [
    'postgres',
    "SELECT count(*) total, max(created_at) latest, status s, 'x' label, 1 one, total_amount * 2 doubled FROM orders GROUP BY status",
    ['created_at', 'status', 'total_amount'],
  ],
  [
    'mysql',
    "SELECT GROUP_CONCAT(DISTINCT name ORDER BY name SEPARATOR ', '), DATE_FORMAT(created_at, '%Y'), TIMESTAMPDIFF(MINUTE, created_at, updated_at) FROM t WHERE MATCH(title, body) AGAINST ('+a -b' IN BOOLEAN MODE) GROUP BY category WITH ROLLUP",
    ['body', 'category', 'created_at', 'name', 'title', 'updated_at'],
  ],
  [
    'mysql',
    "SELECT id FROM t WHERE MATCH(title) AGAINST ('shoes' IN NATURAL LANGUAGE MODE WITH QUERY EXPANSION)",
    ['id', 'title'],
  ],
  [
    'postgres',
    "SELECT created_at AT TIME ZONE 'UTC', CURRENT_DATE, CURRENT_TIMESTAMP, LOCALTIME, LOCALTIMESTAMP, CURRENT_USER, SESSION_USER FROM t WHERE flag IS TRUE AND other IS NOT FALSE AND x IS UNKNOWN AND y IS NULL",
    ['created_at', 'flag', 'other', 'x', 'y'],
  ],
  ['postgres', "SELECT INTERVAL '1' YEAR, INTERVAL '2 hours 30 minutes', DATE '2025-01-01', TIMESTAMP '2025-01-01 00:00', TIME '10:00' FROM t", []],
  [
    'postgres',
    "SELECT EXTRACT(DOW FROM d1), EXTRACT(DOY FROM d1), EXTRACT(QUARTER FROM d2), EXTRACT(WEEK FROM d2), EXTRACT(ISODOW FROM d3), EXTRACT(MICROSECONDS FROM d3), EXTRACT(MILLISECOND FROM d3), EXTRACT(timezone FROM d4), date_part('month', d4) FROM t",
    ['d1', 'd2', 'd3', 'd4'],
  ],
  [
    'postgres',
    'SELECT LAG(total_amount, 1) OVER (PARTITION BY customer_id ORDER BY created_at), NTILE(4) OVER (ORDER BY total_amount), FIRST_VALUE(status) OVER (ORDER BY created_at ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING EXCLUDE CURRENT ROW) FROM orders',
    ['created_at', 'customer_id', 'status', 'total_amount'],
  ],
  ['postgres', 'SELECT id FROM t LIMIT ALL OFFSET 10', ['id']],
  ['mysql', 'SELECT id FROM t ORDER BY created_at DESC LIMIT 10, 20 FOR UPDATE SKIP LOCKED', ['created_at', 'id']],
  [
    'sqlite',
    "SELECT id FROM t WHERE name LIKE 'a%' COLLATE NOCASE AND path GLOB '*.txt' AND code REGEXP '^x' AND v BETWEEN 1 AND 2 AND w NOT IN (1) AND z ISNULL AND q NOTNULL",
    ['code', 'id', 'name', 'path', 'q', 'v', 'w', 'z'],
  ],
  [
    'postgres',
    'SELECT "u"."firstName", "createdAt" FROM "User" "u" WHERE "u"."deletedAt" IS NULL ORDER BY "createdAt" DESC',
    ['createdAt'],
    ['u.deletedAt', 'u.firstName'],
  ],
  ['postgres', 'SELECT sub.n, n FROM (SELECT count(*) AS n FROM t) sub WHERE n > 1', [], ['sub.n']],
  ['postgres', "SELECT make_interval(days => 3, hours => n_hours), inet '10.0.0.1', jsonb '{}' FROM t", ['n_hours']],
  [
    'mssql',
    "SELECT CONVERT(varchar(10), created_at, 120), TRY_CONVERT(int, code), FORMAT(total_amount, 'N2'), CAST(created_at AS datetime2), ISNULL(status, 'n/a') FROM orders",
    ['code', 'created_at', 'status', 'total_amount'],
  ],
  ['mysql', "SELECT _utf8mb4'abc' COLLATE utf8mb4_bin, name FROM t", ['name']],
  [
    'mysql',
    "SELECT jt.a FROM docs, JSON_TABLE(docs.body, '$[*]' COLUMNS (a INT PATH '$.a', b VARCHAR(20) PATH '$.b' DEFAULT 'x' ON EMPTY, NESTED PATH '$.c[*]' COLUMNS (c INT PATH '$'))) AS jt WHERE b = 'y' AND c > 1",
    [],
    ['docs.body', 'jt.a'],
  ],
  ['postgres', 'SELECT t.tag, count(*) FROM posts p, LATERAL unnest(p.tags) AS t(tag) GROUP BY tag', [], ['p.tags', 't.tag']],
  ['postgres', 'UPDATE accounts SET balance = balance - 10 WHERE id = 1 RETURNING id, balance AS new_balance', ['balance', 'id']],
  ['postgres', 'SELECT created_at AS date, total_amount AS value, status AS type FROM orders ORDER BY date', ['created_at', 'status', 'total_amount']],
  ['postgres', "SELECT id FROM t WHERE created_at >= CURRENT_DATE - INTERVAL '7' DAY AND created_at < CURRENT_DATE + 1", ['created_at', 'id']],
  ['mssql', 'SELECT id FROM t ORDER BY id OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY', ['id']],
  ['postgres', 'SELECT id FROM t WHERE x BETWEEN SYMMETRIC a AND b', ['a', 'b', 'id', 'x']],
  ['postgres', "SELECT id FROM t WHERE (start_at, end_at) OVERLAPS (DATE '2025-01-01', DATE '2025-02-01')", ['end_at', 'id', 'start_at']],
  [
    'postgres',
    "SELECT POSITION('a' IN name), SUBSTRING(name FROM 2 FOR 3), TRIM(LEADING '0' FROM code), OVERLAY(name PLACING 'x' FROM 1 FOR 1) FROM t",
    ['code', 'name'],
  ],
  [
    'postgres',
    'WITH RECURSIVE tree (node_id, depth) AS (SELECT id, 0 FROM nodes UNION ALL SELECT n.id, depth + 1 FROM nodes n JOIN tree ON n.parent_id = tree.node_id) SELECT node_id, depth FROM tree',
    ['id'],
    ['n.id', 'n.parent_id', 'tree.node_id'],
  ],
  ['postgres', 'SELECT row_to_json(u), to_jsonb(orders) FROM users u, orders', []],
  ['postgres', 'SELECT id FROM t WHERE a = 1 UNION ALL SELECT id FROM u EXCEPT SELECT id FROM v INTERSECT SELECT id FROM w', ['a', 'id']],
  ['generic', "SELECT id, status FROM orders WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '1' DAY ORDER BY id DESC LIMIT 10", ['created_at', 'id', 'status']],
];

describe('column candidates in keyword-heavy queries', () => {
  // Objects, not arrays: with a missing 4th element jest would pass its `done` callback instead.
  const rows = CASES.map(([dialect, sql, expectedBare, expectedQualified]) => ({ dialect, sql, expectedBare, expectedQualified }));
  it.each(rows)('$dialect: $sql', ({ dialect, sql, expectedBare, expectedQualified }) => {
    const a = analyzeSql(sql, dialect);
    const candidates = a.columns.filter((c) => c.qualifier === undefined);
    // No candidate is a keyword (types, date parts, constants, window/fetch words, hints)
    for (const c of candidates) {
      if (!c.quoted) expect(SQL_KEYWORDS.has(c.name.toUpperCase())).toBe(false);
    }
    expect(bare(sql, dialect)).toEqual(uniqueSorted(expectedBare));
    if (expectedQualified) expect(qualified(sql, dialect)).toEqual(uniqueSorted(expectedQualified));
  });
});

describe('column references', () => {
  it('gives qualifier and name for qualified references, with positions', () => {
    const sql = 'SELECT s.t.c, u."Email" FROM s.t, u';
    const cols = analyzeSql(sql, 'generic').columns;
    expect(cols.map((c) => [c.qualifier, c.name, c.quoted])).toEqual([
      ['t', 'c', false],
      ['u', 'Email', true],
    ]);
    expect(sql.slice(cols[0].start, cols[0].end)).toBe('s.t.c');
    const ms = analyzeSql('SELECT [x].[y] FROM x', 'mssql').columns;
    expect(ms).toEqual([{ name: 'y', qualifier: 'x', quoted: true, start: 7, end: 14 }]);
  });

  it('reports bare candidates with positions and quoting', () => {
    const sql = 'SELECT "Total", amount FROM t';
    expect(analyzeSql(sql, 'postgres').columns).toEqual([
      { name: 'Total', quoted: true, start: 7, end: 14 },
      { name: 'amount', quoted: false, start: 16, end: 22 },
    ]);
  });

  it('sends t.* to starQualifiers, not columns', () => {
    const a = analyzeSql('SELECT o.*, u.id FROM orders o, users u', 'postgres');
    expect(a.starQualifiers).toEqual(['o']);
    expect(a.columns.map((c) => `${c.qualifier}.${c.name}`)).toEqual(['u.id']);
  });

  it('does not report names inside strings or comments', () => {
    expect(analyzeSql("SELECT id FROM t WHERE note = 'password' -- secret_col", 'postgres').columns.map((c) => c.name)).toEqual(['id', 'note']);
  });

  it('keeps columns whose names merely contain keywords', () => {
    expect(bare('SELECT created_at, dropoff, grants, executed_at, alter_ego, update_count, "select" FROM t', 'postgres')).toEqual([
      'alter_ego',
      'created_at',
      'dropoff',
      'executed_at',
      'grants',
      'select',
      'update_count',
    ]);
  });

  it('keeps common column names that are non-reserved keywords somewhere', () => {
    expect(bare('SELECT name, status, type, value, data, level, role, comment, source, text, password, plan, mode, language FROM t', 'postgres')).toEqual(
      ['comment', 'data', 'language', 'level', 'mode', 'name', 'password', 'plan', 'role', 'source', 'status', 'text', 'type', 'value']
    );
  });
});
