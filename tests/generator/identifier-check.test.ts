/**
 * checkIdentifiers(): unknown tables and columns, wrongly quoted names, and
 * (above all) no false positives on valid queries
 * (src/generator/identifier-check.ts)
 */

import { checkIdentifiers, IdentifierChecker, IdentifierIssue } from '../../src/generator/identifier-check';
import { DatabaseSchema, DatabaseType, TableSchema } from '../../src/types';
import { SqlDialect } from '../../src/sql';
import { valid, validEdgeCases, CorpusDialect } from '../fixtures/sql-corpus';

/** A schema from `{ table: 'col1 col2', 'schema.table': '...' }`. */
/** Names in these schemas are exact, as introspection and parsePrismaSchema produce them. */
function schemaOf(databaseType: DatabaseType, tables: Record<string, string>): DatabaseSchema {
  return {
    databaseType,
    exactNames: true,
    tables: Object.entries(tables).map(([qualified, columns]): TableSchema => {
      const dot = qualified.indexOf('.');
      const table: TableSchema = {
        name: dot >= 0 ? qualified.slice(dot + 1) : qualified,
        columns: columns.split(/\s+/).filter(Boolean).map((name) => ({ name, type: 'text' })),
      };
      if (dot >= 0) table.schema = qualified.slice(0, dot);
      return table;
    }),
  };
}

const kinds = (issues: IdentifierIssue[]) => issues.map((i) => `${i.kind}:${i.table ? `${i.table}.` : ''}${i.name}`);

/** Schemas that hold exactly the tables and columns the corpus queries use. */
const CORPUS_SCHEMAS: Record<CorpusDialect, DatabaseSchema> = {
  postgres: schemaOf('postgres', {
    orders: 'id user_id total created_at status region',
    'public.User': 'id email createdAt',
    users: 'id email name nickname first_name last_name deleted_at tags birth_date active created_at',
    products: 'name',
    events: 'id metadata',
    invoices: 'status total',
    tags: 'name',
    a: 'id name',
    b: 'id name',
    tickets: 'id note',
    rides: 'dropoff_address executed_at alternate_email grant_amount',
    categories: 'id parent_id',
    t: 'a b',
    carts: 'data',
    flags: 'user_id status',
    refunds: 'order_id',
    trucks: 'load lock copy call comment analyze_score update',
    audit: 'update delete',
  }),
  mysql: schemaOf('mysql', {
    orders: 'id user_id total created_at status note title',
    users: 'id email created_at nickname first_name last_name',
    tags: 'name',
    events: 'id metadata',
    products: 'name',
    a: 'name',
    b: 'name',
    rides: 'dropoff_address executed_at',
    t: 'drop select',
  }),
  sqlite: schemaOf('sqlite', {
    orders: 'id created_at total user_id status note',
    users: 'id created_at first_name last_name nickname name email',
    tags: 'name',
    events: 'metadata',
    User: 'id createdAt',
    invoices: 'status',
    refunds: 'order_id',
  }),
  mssql: schemaOf('mssql', {
    orders: 'id created_at user_id total status',
    'dbo.Users': 'id email CreatedAt nickname first_name last_name created_at name',
    tags: 'name',
    events: 'metadata',
    t: 'drop delete',
  }),
};

const DIALECTS: CorpusDialect[] = ['postgres', 'mysql', 'sqlite', 'mssql'];

describe('no false positives on the valid corpus', () => {
  const rows = DIALECTS.flatMap((d) => [...valid[d], ...validEdgeCases[d]].map((sql) => ({ dialect: d, sql })));
  it.each(rows)('[$dialect] $sql', ({ dialect, sql }) => {
    expect(checkIdentifiers(sql, CORPUS_SCHEMAS[dialect], dialect)).toEqual([]);
  });

  it('still finds a misspelled column in every corpus dialect', () => {
    for (const d of DIALECTS) {
      const issues = checkIdentifiers('SELECT o.totl FROM orders o', CORPUS_SCHEMAS[d], d);
      expect(kinds(issues)).toEqual(['unknown_column:orders.totl']);
      expect(issues[0].suggestions).toEqual(['total']);
    }
  });
});

describe('no false positives on keyword-heavy queries', () => {
  // [dialect, sql, schema tables] — the schema holds exactly the real columns.
  const CASES: Array<[SqlDialect, string, Record<string, string>]> = [
    ['postgres', 'SELECT EXTRACT(YEAR FROM created_at) AS yr, EXTRACT(EPOCH FROM updated_at) FROM orders ORDER BY yr', { orders: 'created_at updated_at' }],
    ['mysql', 'SELECT id FROM orders WHERE created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) AND updated_at < NOW() - INTERVAL 1 HOUR', { orders: 'id created_at updated_at' }],
    [
      'mssql',
      "SELECT id FROM orders WHERE created_at > DATEADD(day, -7, GETDATE()) AND DATEDIFF(month, created_at, GETDATE()) < 3 AND DATEPART(week, shipped_at) = 1 AND DATENAME(dw, shipped_at) = 'Monday'",
      { orders: 'id created_at shipped_at' },
    ],
    ['mysql', 'SELECT CAST(total_amount AS DECIMAL(10,2)), CAST(created_at AS DATE) FROM orders', { orders: 'total_amount created_at' }],
    [
      'postgres',
      'SELECT created_at::date, total_amount::numeric(12,2), status::text, meta::jsonb, x::public.my_enum, y::timestamp with time zone FROM orders',
      { orders: 'created_at total_amount status meta x y' },
    ],
    ['postgres', 'SELECT name COLLATE "C", title COLLATE pg_catalog."default" FROM products ORDER BY name COLLATE "en_US"', { products: 'name title' }],
    ['mysql', 'SELECT CONVERT(name USING utf8mb4), CONVERT(bio, CHAR) FROM users', { users: 'name bio' }],
    [
      'postgres',
      "SELECT SUM(total_amount) OVER (PARTITION BY status ORDER BY created_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running, AVG(total_amount) OVER (ORDER BY created_at RANGE BETWEEN INTERVAL '7 days' PRECEDING AND CURRENT ROW) FROM orders",
      { orders: 'total_amount status created_at' },
    ],
    [
      'postgres',
      'SELECT id, rank() OVER w, sum(total_amount) OVER (w ROWS UNBOUNDED PRECEDING) FROM orders WINDOW w AS (PARTITION BY customer_id ORDER BY created_at DESC)',
      { orders: 'id total_amount customer_id created_at' },
    ],
    [
      'postgres',
      "SELECT COUNT(*) FILTER (WHERE status = 'paid') AS paid, SUM(total_amount) FILTER (WHERE refunded IS NOT TRUE) FROM invoices",
      { invoices: 'status total_amount refunded' },
    ],
    ['postgres', 'SELECT id FROM orders ORDER BY shipped_at DESC NULLS LAST, created_at ASC NULLS FIRST FETCH FIRST 10 ROWS ONLY', { orders: 'id shipped_at created_at' }],
    [
      'postgres',
      "SELECT id FROM users WHERE email ILIKE '%@x.com' AND name SIMILAR TO '(A|B)%' AND nickname IS DISTINCT FROM display_name AND bio NOT ILIKE 'x!%' ESCAPE '!'",
      { users: 'id email name nickname display_name bio' },
    ],
    [
      'postgres',
      "SELECT CASE WHEN total_amount > 100 THEN 'big' WHEN status = 'void' THEN NULL ELSE 'small' END AS size, CASE status WHEN 'a' THEN 1 END FROM orders",
      { orders: 'total_amount status' },
    ],
    [
      'postgres',
      "SELECT metadata->>'source', metadata->'a'->>'b', data #>> '{a,b}', tags ? 'vip' FROM events WHERE payload @> '{\"x\":1}'",
      { events: 'metadata data tags payload' },
    ],
    [
      'postgres',
      "SELECT ARRAY[id, parent_id], tags && ARRAY['a','b'] FROM nodes WHERE id = ANY(ARRAY[1,2,3]) AND parent_id = ANY($1) AND kind <> ALL('{a,b}'::text[])",
      { nodes: 'id parent_id tags kind' },
    ],
    [
      'postgres',
      'INSERT INTO counters (id, hits) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET hits = counters.hits + excluded.hits',
      { counters: 'id hits' },
    ],
    ['mssql', 'SELECT TOP (5) PERCENT WITH TIES id FROM orders ORDER BY created_at', { orders: 'id created_at' }],
    ['mssql', "SELECT o.id, status FROM orders o WITH (NOLOCK, READPAST) WHERE status = 'x'", { orders: 'id status' }],
    [
      'postgres',
      'SELECT status, region, SUM(total_amount) FROM orders GROUP BY ROLLUP (status, region), CUBE (channel), GROUPING SETS ((status), ())',
      { orders: 'status region total_amount channel' },
    ],
    [
      'postgres',
      "SELECT count(*) total, max(created_at) latest, status s, 'x' label, 1 one, total_amount * 2 doubled FROM orders GROUP BY status ORDER BY latest",
      { orders: 'created_at status total_amount' },
    ],
    [
      'mysql',
      "SELECT GROUP_CONCAT(DISTINCT name ORDER BY name SEPARATOR ', '), DATE_FORMAT(created_at, '%Y'), TIMESTAMPDIFF(MINUTE, created_at, updated_at) FROM t WHERE MATCH(title, body) AGAINST ('+a -b' IN BOOLEAN MODE) GROUP BY category WITH ROLLUP",
      { t: 'name created_at updated_at title body category' },
    ],
    [
      'postgres',
      "SELECT created_at AT TIME ZONE 'UTC', CURRENT_DATE, CURRENT_TIMESTAMP, LOCALTIME, LOCALTIMESTAMP, CURRENT_USER, SESSION_USER FROM t WHERE flag IS TRUE AND other IS NOT FALSE AND x IS UNKNOWN AND y IS NULL",
      { t: 'created_at flag other x y' },
    ],
    ['postgres', "SELECT INTERVAL '1' YEAR, INTERVAL '2 hours 30 minutes', DATE '2025-01-01', TIMESTAMP '2025-01-01 00:00', TIME '10:00' FROM t", { t: 'id' }],
    [
      'postgres',
      "SELECT EXTRACT(DOW FROM d1), EXTRACT(QUARTER FROM d2), EXTRACT(ISODOW FROM d3), EXTRACT(timezone FROM d4), date_part('month', d4) FROM t",
      { t: 'd1 d2 d3 d4' },
    ],
    ['mysql', 'SELECT id FROM t ORDER BY created_at DESC LIMIT 10, 20', { t: 'id created_at' }],
    [
      'sqlite',
      "SELECT id FROM t WHERE name LIKE 'a%' COLLATE NOCASE AND path GLOB '*.txt' AND code REGEXP '^x' AND v BETWEEN 1 AND 2 AND w NOT IN (1) AND z ISNULL AND q NOTNULL",
      { t: 'id name path code v w z q' },
    ],
    ['postgres', 'SELECT sub.n, n FROM (SELECT count(*) AS n FROM t) sub WHERE n > 1', { t: 'id' }],
    ['postgres', "SELECT make_interval(days => 3, hours => n_hours), inet '10.0.0.1', jsonb '{}' FROM t", { t: 'n_hours' }],
    [
      'mssql',
      "SELECT CONVERT(varchar(10), created_at, 120), TRY_CONVERT(int, code), FORMAT(total_amount, 'N2'), CAST(created_at AS datetime2), ISNULL(status, 'n/a') FROM orders",
      { orders: 'created_at code total_amount status' },
    ],
    ['mysql', "SELECT _utf8mb4'abc' COLLATE utf8mb4_bin, name FROM t", { t: 'name' }],
    [
      'mysql',
      "SELECT jt.a FROM docs, JSON_TABLE(docs.body, '$[*]' COLUMNS (a INT PATH '$.a', b VARCHAR(20) PATH '$.b')) AS jt WHERE b = 'y'",
      { docs: 'body' },
    ],
    ['postgres', 'SELECT t.tag, count(*) FROM posts p, LATERAL unnest(p.tags) AS t(tag) GROUP BY tag', { posts: 'tags' }],
    ['postgres', 'UPDATE accounts SET balance = balance - 10 WHERE id = 1 RETURNING id, balance AS new_balance', { accounts: 'id balance' }],
    ['postgres', 'SELECT created_at AS date, total_amount AS value, status AS type FROM orders ORDER BY date', { orders: 'created_at total_amount status' }],
    ['mssql', 'SELECT id FROM t ORDER BY id OFFSET @skip ROWS FETCH NEXT @take ROWS ONLY', { t: 'id' }],
    [
      'postgres',
      "SELECT POSITION('a' IN name), SUBSTRING(name FROM 2 FOR 3), TRIM(LEADING '0' FROM code), OVERLAY(name PLACING 'x' FROM 1 FOR 1) FROM t",
      { t: 'name code' },
    ],
    [
      'postgres',
      'WITH RECURSIVE tree (node_id, depth) AS (SELECT id, 0 FROM nodes UNION ALL SELECT n.id, depth + 1 FROM nodes n JOIN tree ON n.parent_id = tree.node_id) SELECT node_id, depth FROM tree',
      { nodes: 'id parent_id' },
    ],
    ['postgres', 'SELECT row_to_json(u), to_jsonb(orders) FROM users u, orders', { users: 'id', orders: 'id' }],
    ['postgres', 'SELECT id FROM t WHERE a = 1 UNION ALL SELECT id FROM u EXCEPT SELECT id FROM v', { t: 'id a', u: 'id', v: 'id' }],
    ['postgres', "SELECT id FROM t WHERE (start_at, end_at) OVERLAPS (DATE '2025-01-01', DATE '2025-02-01')", { t: 'id start_at end_at' }],
    ['postgres', 'SELECT id FROM users WHERE email = $1 AND name = :name', { users: 'id email name' }],
    ['mssql', 'SELECT id FROM users WHERE email = @email AND @@ROWCOUNT > 0', { users: 'id email' }],
    ['mysql', 'SELECT id FROM users WHERE email = ? AND created_at < UTC_TIMESTAMP', { users: 'id email created_at' }],
    ['postgres', "SELECT id FROM users WHERE note = 'ghost_column' AND name = 'nonexistent_table.col'", { users: 'id note name' }],
    ['postgres', 'SELECT count FROM (SELECT count(*) FROM users) c', { users: 'id' }],
    ['sqlite', 'SELECT rowid, id FROM users', { users: 'id' }],
    ['postgres', 'SELECT key, value FROM users, jsonb_each(users.meta)', { users: 'meta' }],
    ['postgres', 'SELECT x FROM (VALUES (1), (2)) AS v(x)', {}],
    ['postgres', 'SELECT column1 FROM (VALUES (1), (2)) v, users', { users: 'id' }],
    ['postgres', 'SELECT u.id, d.anything FROM users u JOIN (SELECT user_id, sum(total) AS spent FROM orders GROUP BY user_id) d ON d.user_id = u.id ORDER BY spent', { users: 'id', orders: 'user_id total' }],
    ['postgres', 'WITH x AS (SELECT id, email FROM users) SELECT x.id, x.whatever, email FROM x', { users: 'id email' }],
    ['postgres', 'SELECT table_name FROM information_schema.tables WHERE table_schema = \'public\'', {}],
    ['postgres', 'SELECT relname FROM pg_catalog.pg_class', {}],
    ['sqlite', "SELECT name FROM sqlite_master WHERE type = 'table'", {}],
    ['postgres', 'SELECT id FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.total > 10)', { users: 'id', orders: 'user_id total' }],
    ['postgres', 'SELECT u.id FROM users AS u, orders AS o WHERE o.user_id = u.id', { users: 'id', orders: 'user_id' }],
    ['mssql', 'SELECT u.id FROM users u CROSS APPLY OPENJSON(u.tags) j WHERE j.value = 1 AND value = 2', { users: 'id tags' }],
  ];
  it.each(CASES.map(([dialect, sql, tables]) => ({ dialect, sql, tables })))('[$dialect] $sql', ({ dialect, sql, tables }) => {
    const databaseType = (dialect === 'generic' ? 'postgres' : dialect) as DatabaseType;
    expect(checkIdentifiers(sql, schemaOf(databaseType, tables), dialect)).toEqual([]);
  });
});

describe('unknown tables', () => {
  const schema = schemaOf('postgres', { customers: 'id name', 'public.orders': 'id customer_id total', 'billing.invoices': 'id' });

  it('reports a table the schema does not have, with close matches', () => {
    const issues = checkIdentifiers('SELECT id FROM customer', schema);
    expect(issues).toEqual([
      {
        kind: 'unknown_table',
        name: 'customer',
        suggestions: ['customers'],
        message: 'Unknown table customer; did you mean customers?',
      },
    ]);
  });

  it('reports tables in JOINs, comma lists, subqueries, UPDATE and INSERT', () => {
    expect(kinds(checkIdentifiers('SELECT c.id FROM customers c JOIN shipments s ON s.cid = c.id', schema))).toEqual(['unknown_table:shipments']);
    expect(kinds(checkIdentifiers('SELECT 1 FROM customers, payments', schema))).toEqual(['unknown_table:payments']);
    expect(kinds(checkIdentifiers('SELECT id FROM customers WHERE id IN (SELECT cid FROM vip)', schema))).toEqual(['unknown_table:vip']);
    expect(kinds(checkIdentifiers('UPDATE clients SET name = 1', schema))).toEqual(['unknown_table:clients']);
    expect(kinds(checkIdentifiers('INSERT INTO logs (id) VALUES (1)', schema))).toEqual(['unknown_table:logs']);
  });

  it('matches case-insensitively and with schema qualification', () => {
    expect(checkIdentifiers('SELECT id FROM CUSTOMERS', schemaOf('mysql', { customers: 'id' }), 'mysql')).toEqual([]);
    expect(checkIdentifiers('SELECT id FROM public.orders', schema)).toEqual([]);
    expect(checkIdentifiers('SELECT id FROM public.customers', schema)).toEqual([]); // no schema in the table definition
    expect(checkIdentifiers('SELECT id FROM billing.invoices', schema)).toEqual([]);
    const wrongSchema = checkIdentifiers('SELECT id FROM public.invoices', schema);
    expect(kinds(wrongSchema)).toEqual(['unknown_table:invoices']);
    expect(wrongSchema[0].suggestions).toEqual(['billing.invoices']);
  });

  it('excludes CTE names', () => {
    expect(checkIdentifiers('WITH recent AS (SELECT id FROM customers) SELECT id FROM recent', schema)).toEqual([]);
    expect(kinds(checkIdentifiers('WITH recent AS (SELECT id FROM clients) SELECT id FROM recent', schema))).toEqual(['unknown_table:clients']);
  });

  it('skips system catalogs only when they are qualified or named', () => {
    expect(checkIdentifiers('SELECT * FROM information_schema.columns', schema)).toEqual([]);
    expect(checkIdentifiers('SELECT * FROM pg_catalog.pg_tables', schema)).toEqual([]);
    expect(checkIdentifiers('SELECT * FROM sqlite_schema', schemaOf('sqlite', {}), 'sqlite')).toEqual([]);
    expect(kinds(checkIdentifiers('SELECT * FROM columns', schema))).toEqual(['unknown_table:columns']);
    expect(kinds(checkIdentifiers('SELECT * FROM pg_tables', schema))).toEqual(['unknown_table:pg_tables']);
  });

  it('suggests snake_case and camelCase variants', () => {
    const s = schemaOf('postgres', { UserProfile: 'id', order_items: 'id' });
    expect(checkIdentifiers('SELECT 1 FROM user_profile', s)[0].suggestions).toEqual(['UserProfile']);
    expect(checkIdentifiers('SELECT 1 FROM orderitems', s)[0].suggestions).toEqual(['order_items']);
    expect(checkIdentifiers('SELECT 1 FROM zzz', s)[0].suggestions).toBeUndefined();
  });
});

describe('unknown columns', () => {
  const schema = schemaOf('postgres', {
    users: 'id email name created_at',
    orders: 'id user_id total status',
    payments: 'id order_id amount',
  });

  it('reports a qualified column resolved through its alias, with the table and suggestions', () => {
    const issues = checkIdentifiers('SELECT u.emial FROM users u', schema);
    expect(issues).toEqual([
      {
        kind: 'unknown_column',
        name: 'emial',
        table: 'users',
        suggestions: ['email'],
        message: 'Unknown column u.emial in table users; did you mean email?',
      },
    ]);
  });

  it('resolves qualifiers that are table names, aliases and schema-qualified names', () => {
    expect(kinds(checkIdentifiers('SELECT users.fullname FROM users', schema))).toEqual(['unknown_column:users.fullname']);
    expect(kinds(checkIdentifiers('SELECT public.users.fullname FROM public.users', schema))).toEqual(['unknown_column:users.fullname']);
    expect(kinds(checkIdentifiers('SELECT o.amount FROM orders o JOIN payments p ON p.order_id = o.id', schema))).toEqual([
      'unknown_column:orders.amount',
    ]);
  });

  it('checks bare columns against every table in the query', () => {
    expect(checkIdentifiers('SELECT total, email FROM users u JOIN orders o ON o.user_id = u.id', schema)).toEqual([]);
    const issues = checkIdentifiers('SELECT amount FROM users u JOIN orders o ON o.user_id = u.id', schema);
    expect(kinds(issues)).toEqual(['unknown_column:amount']);
    expect(issues[0].message).toBe('Unknown column amount: no table in the query (users, orders) has it; it exists in payments');
    expect(kinds(checkIdentifiers('SELECT emial FROM users', schema))).toEqual(['unknown_column:users.emial']);
  });

  it('skips bare columns when a table in the query is unknown', () => {
    expect(kinds(checkIdentifiers('SELECT whatever FROM users JOIN ghosts ON ghosts.uid = users.id', schema))).toEqual([
      'unknown_table:ghosts',
    ]);
  });

  it('does not report aliases, CTE columns, functions, keywords, params or strings', () => {
    const queries = [
      'SELECT count(*) AS n FROM orders GROUP BY status HAVING count(*) > 1 ORDER BY n',
      'SELECT status AS s FROM orders ORDER BY s',
      'WITH t (a, b) AS (SELECT id, total FROM orders) SELECT a, b FROM t',
      "SELECT now(), CURRENT_DATE, coalesce(total, 0) FROM orders WHERE status = 'refunded_amount'",
      'SELECT id FROM orders WHERE user_id = $1 OR total > :min',
      'SELECT o.id FROM orders o WHERE o.total > (SELECT avg(total) FROM orders)',
      'SELECT id FROM users u WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)',
    ];
    for (const q of queries) expect([q, checkIdentifiers(q, schema)]).toEqual([q, []]);
  });

  it('deduplicates repeated references', () => {
    expect(kinds(checkIdentifiers('SELECT u.nick FROM users u WHERE u.nick IS NOT NULL ORDER BY u.nick', schema))).toEqual([
      'unknown_column:users.nick',
    ]);
  });

  it('returns nothing for queries it cannot lex', () => {
    expect(checkIdentifiers("SELECT 'unterminated FROM ghosts", schema)).toEqual([]);
  });
});

describe('Postgres quoting', () => {
  const schema = schemaOf('postgres', { User: 'id email createdAt', user: 'id', Post: 'id authorId' });

  it('reports an unquoted reference to a mixed-case table', () => {
    const issues = checkIdentifiers('SELECT id FROM Post', schema);
    expect(issues).toEqual([
      {
        kind: 'needs_quoting',
        name: 'Post',
        suggestions: ['Post'],
        message: 'Table Post must be written "Post" (unquoted names are folded to lower case)',
      },
    ]);
  });

  it('reports unquoted mixed-case columns, bare and qualified', () => {
    expect(kinds(checkIdentifiers('SELECT createdAt FROM "User"', schema))).toEqual(['needs_quoting:User.createdAt']);
    const issues = checkIdentifiers('SELECT p.authorId FROM "Post" p', schema);
    expect(issues[0].message).toBe('Column p.authorId must be written p."authorId" (unquoted names are folded to lower case)');
  });

  it('accepts correctly quoted names and lowercase names', () => {
    expect(checkIdentifiers('SELECT "u"."createdAt", u.email FROM "User" u', schema)).toEqual([]);
    expect(checkIdentifiers('SELECT "id" FROM "Post" WHERE "authorId" = 1', schema)).toEqual([]);
    expect(checkIdentifiers('SELECT id FROM "user"', schema)).toEqual([]);
  });

  it('treats quoted names as case-sensitive', () => {
    expect(kinds(checkIdentifiers('SELECT id FROM "post"', schema))).toEqual(['unknown_table:post']);
    const issues = checkIdentifiers('SELECT "createdat" FROM "User"', schema);
    expect(kinds(issues)).toEqual(['unknown_column:User.createdat']);
    expect(issues[0].suggestions).toEqual(['createdAt']);
  });

  it('reports an unquoted reserved table name', () => {
    expect(kinds(checkIdentifiers('SELECT id FROM user', schemaOf('postgres', { user: 'id' })))).toEqual(['needs_quoting:user']);
    expect(checkIdentifiers('SELECT id FROM public.user', schemaOf('postgres', { user: 'id' }))).toEqual([]);
  });

  it('is case-insensitive in the other dialects', () => {
    for (const d of ['mysql', 'sqlite', 'mssql'] as const) {
      expect(checkIdentifiers('SELECT createdAt, CREATEDAT FROM user u WHERE u.Email IS NULL', schemaOf(d, { User: 'id Email createdAt' }), d)).toEqual([]);
    }
  });
});

describe('IdentifierChecker', () => {
  it('reuses its schema index across checks and exposes the analysis', () => {
    const checker = new IdentifierChecker(schemaOf('postgres', { users: 'id' }), 'postgres');
    expect(checker.check('SELECT id FROM users')).toEqual([]);
    const inspection = checker.inspect('SELECT nope FROM users');
    expect(kinds(inspection.issues)).toEqual(['unknown_column:users.nope']);
    expect(inspection.referencedTables.map((t) => t.name)).toEqual(['users']);
    expect(inspection.analysis?.operation).toBe('SELECT');
  });

  it('renders names the way the dialect writes them', () => {
    expect(new IdentifierChecker(schemaOf('postgres', {}), 'postgres').display('User')).toBe('"User"');
    expect(new IdentifierChecker(schemaOf('mysql', {}), 'mysql').display('order')).toBe('`order`');
    expect(new IdentifierChecker(schemaOf('mssql', {}), 'mssql').display('Order Details')).toBe('[Order Details]');
    expect(new IdentifierChecker(schemaOf('sqlite', {}), 'sqlite').display('users')).toBe('users');
  });

  it('matches case-insensitively when the schema names may not be exact (hand-written, as in 0.0.1)', () => {
    const handWritten: DatabaseSchema = { ...schemaOf('postgres', { Users: 'Id Email' }), exactNames: undefined };
    expect(checkIdentifiers('SELECT id, email FROM users', handWritten)).toEqual([]);
    expect(checkIdentifiers('SELECT Id FROM Users', handWritten)).toEqual([]);
    expect(kinds(checkIdentifiers('SELECT name FROM users', handWritten))).toEqual(['unknown_column:Users.name']);
  });

  it('defaults the dialect to the schema database type', () => {
    expect(kinds(checkIdentifiers('SELECT id FROM Post', schemaOf('postgres', { Post: 'id' })))).toEqual(['needs_quoting:Post']);
    expect(checkIdentifiers('SELECT id FROM Post', schemaOf('mysql', { Post: 'id' }))).toEqual([]);
  });
});
