/**
 * Row-level security cases: query in, query out. userId is 123 unless the
 * case says otherwise; the dialect is postgres unless it says otherwise.
 */

import { DatabaseSchema, DatabaseType, SecurityConfig } from '../../src/types';

export interface RlsCase {
  name: string;
  query: string;
  expected: string;
  userId?: string | number;
  databaseType?: DatabaseType | 'generic';
  config?: SecurityConfig;
  schema?: DatabaseSchema;
}

/** users(id, email, password) and orders(id, user_id, total, status): only orders has user_id. */
export const rlsSchema: DatabaseSchema = {
  databaseType: 'postgres',
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'email', type: 'varchar' },
        { name: 'password', type: 'varchar', sensitive: true },
      ],
    },
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'user_id', type: 'integer' },
        { name: 'total', type: 'decimal' },
        { name: 'status', type: 'varchar' },
      ],
    },
  ],
};

export const rlsCases: RlsCase[] = [
  // Output identical to 0.0.1
  { name: 'no WHERE', query: 'SELECT * FROM orders', expected: 'SELECT * FROM orders WHERE user_id = 123' },
  { name: 'string id', query: 'SELECT * FROM orders', userId: 'abc-123', expected: "SELECT * FROM orders WHERE user_id = 'abc-123'" },
  {
    name: 'existing WHERE gets AND',
    query: "SELECT * FROM orders WHERE status = 'paid'",
    expected: "SELECT * FROM orders WHERE status = 'paid' AND user_id = 123",
  },

  // OR precedence (the 0.0.1 leak)
  {
    name: 'top-level OR is parenthesized',
    query: "SELECT * FROM orders WHERE status = 'paid' OR status = 'refunded'",
    expected: "SELECT * FROM orders WHERE (status = 'paid' OR status = 'refunded') AND user_id = 123",
  },
  {
    name: 'OR inside parentheses needs no extra parentheses',
    query: 'SELECT * FROM orders WHERE (total > 5 OR total < 1) AND status = 1',
    expected: 'SELECT * FROM orders WHERE (total > 5 OR total < 1) AND status = 1 AND user_id = 123',
  },
  {
    name: 'MySQL XOR is lower than AND',
    databaseType: 'mysql',
    query: 'SELECT * FROM orders WHERE a = 1 XOR b = 1',
    expected: 'SELECT * FROM orders WHERE (a = 1 XOR b = 1) AND user_id = 123',
  },
  {
    name: 'MySQL || is OR',
    databaseType: 'mysql',
    query: 'SELECT * FROM orders WHERE a = 1 || b = 1',
    expected: 'SELECT * FROM orders WHERE (a = 1 || b = 1) AND user_id = 123',
  },
  {
    name: 'BETWEEN keeps its AND',
    query: 'SELECT * FROM orders WHERE total BETWEEN 1 AND 5',
    expected: 'SELECT * FROM orders WHERE total BETWEEN 1 AND 5 AND user_id = 123',
  },

  // Clauses after WHERE
  {
    name: 'GROUP BY',
    query: 'SELECT status, COUNT(*) FROM orders GROUP BY status',
    expected: 'SELECT status, COUNT(*) FROM orders WHERE user_id = 123 GROUP BY status',
  },
  {
    name: 'WHERE, GROUP BY, HAVING, ORDER BY, LIMIT',
    query: 'SELECT status, COUNT(*) FROM orders WHERE total > 5 GROUP BY status HAVING COUNT(*) > 1 ORDER BY 2 DESC LIMIT 5',
    expected:
      'SELECT status, COUNT(*) FROM orders WHERE total > 5 AND user_id = 123 GROUP BY status HAVING COUNT(*) > 1 ORDER BY 2 DESC LIMIT 5',
  },
  {
    name: 'ORDER BY',
    query: 'SELECT * FROM orders ORDER BY id DESC',
    expected: 'SELECT * FROM orders WHERE user_id = 123 ORDER BY id DESC',
  },
  {
    name: 'LIMIT and OFFSET',
    query: 'SELECT * FROM orders LIMIT 10 OFFSET 20',
    expected: 'SELECT * FROM orders WHERE user_id = 123 LIMIT 10 OFFSET 20',
  },
  {
    name: 'OFFSET ... FETCH',
    query: 'SELECT * FROM orders ORDER BY id OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY',
    expected: 'SELECT * FROM orders WHERE user_id = 123 ORDER BY id OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY',
  },
  {
    name: 'FETCH without ORDER BY',
    query: 'SELECT id FROM orders FETCH FIRST 5 ROWS ONLY',
    expected: 'SELECT id FROM orders WHERE user_id = 123 FETCH FIRST 5 ROWS ONLY',
  },
  {
    name: 'FOR UPDATE',
    query: 'SELECT * FROM orders WHERE id = 1 FOR UPDATE',
    expected: 'SELECT * FROM orders WHERE id = 1 AND user_id = 123 FOR UPDATE',
  },

  // Windows are not the insertion point
  {
    name: 'window function with OVER (ORDER BY ...)',
    query: 'SELECT id, ROW_NUMBER() OVER (PARTITION BY status ORDER BY id) AS rn FROM orders',
    expected: 'SELECT id, ROW_NUMBER() OVER (PARTITION BY status ORDER BY id) AS rn FROM orders WHERE user_id = 123',
  },
  {
    name: 'window frame with BETWEEN ... AND, WHERE and ORDER BY',
    query: 'SELECT id, SUM(total) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM orders WHERE total > 0 ORDER BY id',
    expected:
      'SELECT id, SUM(total) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM orders WHERE total > 0 AND user_id = 123 ORDER BY id',
  },
  {
    name: 'WINDOW clause',
    query: 'SELECT id, AVG(total) OVER w FROM orders WINDOW w AS (PARTITION BY status)',
    expected: 'SELECT id, AVG(total) OVER w FROM orders WHERE user_id = 123 WINDOW w AS (PARTITION BY status)',
  },
  {
    name: 'WITHIN GROUP (ORDER BY ...)',
    query: 'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total) FROM orders',
    expected: 'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY total) FROM orders WHERE user_id = 123',
  },
  {
    name: 'EXTRACT(... FROM ...) and IS DISTINCT FROM in the select list',
    query: 'SELECT EXTRACT(YEAR FROM created_at), a IS DISTINCT FROM b FROM orders GROUP BY 1',
    expected: 'SELECT EXTRACT(YEAR FROM created_at), a IS DISTINCT FROM b FROM orders WHERE user_id = 123 GROUP BY 1',
  },

  // Subqueries and CTEs neither satisfy nor receive the main filter
  {
    name: 'WHERE inside a subquery',
    query: 'SELECT * FROM orders WHERE id IN (SELECT order_id FROM refunds WHERE user_id = 123)',
    expected: 'SELECT * FROM orders WHERE id IN (SELECT order_id FROM (SELECT * FROM refunds AS __rls WHERE __rls.user_id = 123) refunds WHERE user_id = 123) AND user_id = 123',
  },
  {
    name: 'derived table',
    query: 'SELECT * FROM (SELECT * FROM orders WHERE user_id = 123) o',
    expected: 'SELECT * FROM (SELECT * FROM (SELECT * FROM orders AS __rls WHERE __rls.user_id = 123) orders WHERE user_id = 123) o WHERE user_id = 123',
  },
  {
    name: 'WITH ... main statement',
    query: "WITH recent AS (SELECT * FROM orders WHERE status = 'new') SELECT * FROM recent ORDER BY id",
    expected: "WITH recent AS (SELECT * FROM (SELECT * FROM orders AS __rls WHERE __rls.user_id = 123) orders WHERE status = 'new') SELECT * FROM recent WHERE user_id = 123 ORDER BY id",
  },
  {
    name: 'CTE body filtered on the user does not count',
    query: 'WITH mine AS (SELECT * FROM orders WHERE user_id = 123) SELECT * FROM mine',
    expected: 'WITH mine AS (SELECT * FROM (SELECT * FROM orders AS __rls WHERE __rls.user_id = 123) orders WHERE user_id = 123) SELECT * FROM mine WHERE user_id = 123',
  },
  {
    name: 'WITH RECURSIVE with SEARCH clause',
    query: 'WITH RECURSIVE t(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM t WHERE id < 5) SEARCH DEPTH FIRST BY id SET ord SELECT * FROM t',
    expected:
      'WITH RECURSIVE t(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM t WHERE id < 5) SEARCH DEPTH FIRST BY id SET ord SELECT * FROM t WHERE user_id = 123',
  },
  {
    name: 'parenthesized query',
    query: '(SELECT * FROM orders)',
    expected: '(SELECT * FROM orders WHERE user_id = 123)',
  },

  // Set operations: every branch
  {
    name: 'UNION ALL with a trailing ORDER BY',
    query: 'SELECT id FROM orders UNION ALL SELECT id FROM archived_orders ORDER BY id',
    expected: 'SELECT id FROM orders WHERE user_id = 123 UNION ALL SELECT id FROM archived_orders WHERE user_id = 123 ORDER BY id',
  },
  {
    name: 'UNION branches with their own WHERE and OR',
    query: 'SELECT id FROM a WHERE x = 1 OR y = 2 UNION SELECT id FROM b WHERE z = 3',
    expected: 'SELECT id FROM a WHERE (x = 1 OR y = 2) AND user_id = 123 UNION SELECT id FROM b WHERE z = 3 AND user_id = 123',
  },
  {
    name: 'parenthesized UNION branches with LIMIT',
    query: '(SELECT id FROM a) UNION (SELECT id FROM b) LIMIT 5',
    expected: '(SELECT id FROM a WHERE user_id = 123) UNION (SELECT id FROM b WHERE user_id = 123) LIMIT 5',
  },
  {
    name: 'INTERSECT and EXCEPT',
    query: 'SELECT id FROM a INTERSECT SELECT id FROM b EXCEPT SELECT id FROM c',
    expected: 'SELECT id FROM a WHERE user_id = 123 INTERSECT SELECT id FROM b WHERE user_id = 123 EXCEPT SELECT id FROM c WHERE user_id = 123',
  },
  {
    name: 'TABLE branch is rewritten to SELECT * FROM',
    query: 'SELECT * FROM a UNION TABLE b',
    expected: 'SELECT * FROM a WHERE user_id = 123 UNION SELECT * FROM b WHERE user_id = 123',
  },

  // UPDATE and DELETE
  { name: 'UPDATE without WHERE', query: "UPDATE orders SET status = 'x'", expected: "UPDATE orders SET status = 'x' WHERE user_id = 123" },
  {
    name: 'UPDATE with WHERE and RETURNING',
    query: "UPDATE orders SET status = 'x' WHERE id = 1 RETURNING id",
    expected: "UPDATE orders SET status = 'x' WHERE id = 1 AND user_id = 123 RETURNING id",
  },
  {
    name: 'UPDATE with a subquery in SET',
    query: 'UPDATE orders SET total = (SELECT SUM(price) FROM items WHERE items.order_id = orders.id) WHERE id = 1',
    expected: 'UPDATE orders SET total = (SELECT SUM(price) FROM (SELECT * FROM items AS __rls WHERE __rls.user_id = 123) items WHERE items.order_id = orders.id) WHERE id = 1 AND user_id = 123',
  },
  {
    name: 'UPDATE with OR',
    query: "UPDATE orders SET status = 'x' WHERE id = 1 OR id = 2",
    expected: "UPDATE orders SET status = 'x' WHERE (id = 1 OR id = 2) AND user_id = 123",
  },
  {
    name: 'UPDATE ... FROM is qualified with the target',
    schema: rlsSchema,
    query: 'UPDATE orders SET total = 0 FROM users WHERE users.id = orders.user_id',
    expected: 'UPDATE orders SET total = 0 FROM users WHERE users.id = orders.user_id AND orders.user_id = 123',
  },
  { name: 'DELETE without WHERE', query: 'DELETE FROM orders', expected: 'DELETE FROM orders WHERE user_id = 123' },
  {
    name: 'DELETE with RETURNING',
    query: 'DELETE FROM orders WHERE id = 1 RETURNING *',
    expected: 'DELETE FROM orders WHERE id = 1 AND user_id = 123 RETURNING *',
  },
  {
    name: 'MySQL DELETE with ORDER BY and LIMIT',
    databaseType: 'mysql',
    query: 'DELETE FROM orders WHERE status = 0 ORDER BY id LIMIT 10',
    expected: 'DELETE FROM orders WHERE status = 0 AND user_id = 123 ORDER BY id LIMIT 10',
  },
  {
    name: 'T-SQL DELETE alias FROM ... JOIN',
    databaseType: 'mssql',
    query: 'DELETE o FROM orders o JOIN users u ON u.id = o.user_id',
    expected: 'DELETE o FROM orders o JOIN users u ON u.id = o.user_id WHERE user_id = 123',
  },

  // Duplicates: skipped only for a pure AND-chain with the same filter
  { name: 'duplicate filter', query: 'SELECT * FROM orders WHERE user_id = 123', expected: 'SELECT * FROM orders WHERE user_id = 123' },
  {
    name: 'duplicate filter in an AND-chain',
    query: 'SELECT * FROM orders WHERE status = 1 AND user_id = 123',
    expected: 'SELECT * FROM orders WHERE status = 1 AND user_id = 123',
  },
  { name: 'qualified duplicate', query: 'SELECT * FROM orders o WHERE o.user_id = 123', expected: 'SELECT * FROM orders o WHERE o.user_id = 123' },
  {
    name: 'duplicate string filter',
    userId: "O'Brien",
    query: "SELECT * FROM orders WHERE user_id = 'O''Brien'",
    expected: "SELECT * FROM orders WHERE user_id = 'O''Brien'",
  },
  {
    name: 'duplicate after a BETWEEN',
    query: 'SELECT * FROM orders WHERE total BETWEEN 1 AND 10 AND user_id = 123',
    expected: 'SELECT * FROM orders WHERE total BETWEEN 1 AND 10 AND user_id = 123',
  },
  {
    name: 'OR inside parentheses with the filter is still a pure chain',
    query: 'SELECT * FROM orders WHERE (a = 1 OR b = 2) AND user_id = 123',
    expected: 'SELECT * FROM orders WHERE (a = 1 OR b = 2) AND user_id = 123',
  },

  // Bypass attempts still get the real filter
  { name: 'other user id', query: 'SELECT * FROM orders WHERE user_id = 999', expected: 'SELECT * FROM orders WHERE user_id = 999 AND user_id = 123' },
  {
    name: 'filter inside an OR',
    query: 'SELECT * FROM orders WHERE x = 1 OR user_id = 123',
    expected: 'SELECT * FROM orders WHERE (x = 1 OR user_id = 123) AND user_id = 123',
  },
  {
    name: 'filter OR 1=1',
    query: 'SELECT * FROM orders WHERE user_id = 123 OR 1=1',
    expected: 'SELECT * FROM orders WHERE (user_id = 123 OR 1=1) AND user_id = 123',
  },
  {
    name: 'filter on a different qualifier',
    schema: rlsSchema,
    query: 'SELECT * FROM orders o JOIN orders x ON x.id = o.id WHERE x.user_id = 123',
    // x is wrapped even though the WHERE filters it: only filters the rewriter adds count
    expected:
      'SELECT * FROM orders o JOIN (SELECT * FROM orders AS __rls WHERE __rls.user_id = 123) x ON x.id = o.id WHERE x.user_id = 123 AND o.user_id = 123',
  },
  {
    name: 'user_id mentioned in a string',
    query: "SELECT * FROM orders WHERE note = 'user_id = 123'",
    expected: "SELECT * FROM orders WHERE note = 'user_id = 123' AND user_id = 123",
  },
  {
    name: 'user_id IS NOT NULL',
    query: 'SELECT * FROM orders WHERE user_id IS NOT NULL',
    expected: 'SELECT * FROM orders WHERE user_id IS NOT NULL AND user_id = 123',
  },
  {
    name: 'NOT before the filter',
    query: 'SELECT * FROM orders WHERE NOT user_id = 123',
    expected: 'SELECT * FROM orders WHERE NOT user_id = 123 AND user_id = 123',
  },
  {
    name: 'filter hidden in the AND of a BETWEEN',
    query: 'SELECT * FROM orders WHERE 0 BETWEEN 0 AND user_id = 123',
    expected: 'SELECT * FROM orders WHERE 0 BETWEEN 0 AND user_id = 123 AND user_id = 123',
  },
  {
    name: 'filter hidden inside CASE',
    query: 'SELECT * FROM orders WHERE CASE WHEN TRUE THEN TRUE ELSE x AND user_id = 123 AND TRUE END',
    expected: 'SELECT * FROM orders WHERE CASE WHEN TRUE THEN TRUE ELSE x AND user_id = 123 AND TRUE END AND user_id = 123',
  },
  {
    name: 'differently quoted column is not the same filter',
    query: 'SELECT * FROM orders WHERE "USER_ID" = 123',
    expected: 'SELECT * FROM orders WHERE "USER_ID" = 123 AND user_id = 123',
  },
  {
    name: 'value as a string is not the number',
    query: "SELECT * FROM orders WHERE user_id = '123'",
    expected: "SELECT * FROM orders WHERE user_id = '123' AND user_id = 123",
  },
  {
    name: 'filter commented out at the end',
    query: "SELECT * FROM orders WHERE note = 'x' -- AND user_id = 123",
    expected: "SELECT * FROM orders WHERE note = 'x' AND user_id = 123 -- AND user_id = 123",
  },
  {
    name: 'trailing semicolon',
    query: 'SELECT * FROM orders;',
    expected: 'SELECT * FROM orders WHERE user_id = 123;',
  },
  {
    name: 'generic: brackets are a nesting level',
    databaseType: 'generic',
    query: 'SELECT * FROM t [x WHERE 1=1 ORDER BY y]',
    expected: 'SELECT * FROM t [x WHERE 1=1 ORDER BY y] WHERE user_id = 123',
  },
  {
    name: 'malformed (unbalanced) query is left unchanged',
    query: 'SELECT * FROM orders WHERE a = 1) OR (1=1',
    expected: 'SELECT * FROM orders WHERE a = 1) OR (1=1',
  },
  {
    name: 'dangling BETWEEN is wrapped, so it stays malformed',
    query: 'SELECT * FROM orders WHERE 1 BETWEEN 0',
    expected: 'SELECT * FROM orders WHERE (1 BETWEEN 0) AND user_id = 123',
  },
  {
    name: 'unterminated string is left unchanged',
    query: "SELECT * FROM orders WHERE note = 'x",
    expected: "SELECT * FROM orders WHERE note = 'x",
  },

  // String ids
  { name: 'quote in id', userId: "O'Brien", query: 'SELECT * FROM t', expected: "SELECT * FROM t WHERE user_id = 'O''Brien'" },
  {
    name: 'injection attempt in id',
    userId: "1' OR '1'='1",
    query: 'SELECT * FROM t',
    expected: "SELECT * FROM t WHERE user_id = '1'' OR ''1''=''1'",
  },
  { name: 'backslash on postgres', userId: 'a\\b', query: 'SELECT * FROM t', expected: "SELECT * FROM t WHERE user_id = 'a\\b'" },
  {
    name: 'backslash on mysql is doubled',
    databaseType: 'mysql',
    userId: "x\\' OR 1=1 -- ",
    query: 'SELECT * FROM t',
    expected: "SELECT * FROM t WHERE user_id = 'x\\\\'' OR 1=1 -- '",
  },
  {
    name: 'backslash on mssql',
    databaseType: 'mssql',
    userId: 'dom\\user',
    query: 'SELECT * FROM t',
    expected: "SELECT * FROM t WHERE user_id = 'dom\\user'",
  },
  { name: 'negative number', userId: -5, query: 'SELECT * FROM t', expected: 'SELECT * FROM t WHERE user_id = -5' },
  { name: 'decimal number', userId: 1.5, query: 'SELECT * FROM t', expected: 'SELECT * FROM t WHERE user_id = 1.5' },
  { name: 'zero', userId: 0, query: 'SELECT * FROM t', expected: 'SELECT * FROM t WHERE user_id = 0' },

  // Joins
  { name: 'single aliased table stays unqualified', query: 'SELECT * FROM orders o', expected: 'SELECT * FROM orders o WHERE user_id = 123' },
  {
    name: 'join without schema: the unqualified 0.0.1 filter (ambiguous, so failing, if both tables have the column)',
    query: 'SELECT * FROM users u JOIN orders o ON o.user_id = u.id',
    expected: 'SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE user_id = 123',
  },
  {
    name: 'join with schema: first table that has the column',
    schema: rlsSchema,
    query: 'SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id ORDER BY o.total',
    expected: 'SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id WHERE o.user_id = 123 ORDER BY o.total',
  },
  {
    name: 'comma join with schema',
    schema: rlsSchema,
    query: 'SELECT * FROM users, orders WHERE orders.user_id = users.id',
    expected: 'SELECT * FROM users, orders WHERE orders.user_id = users.id AND orders.user_id = 123',
  },
  {
    name: 'schema-qualified tables without aliases',
    schema: rlsSchema,
    query: 'SELECT * FROM public.users JOIN public.orders ON orders.user_id = users.id',
    expected: 'SELECT * FROM public.users JOIN public.orders ON orders.user_id = users.id WHERE public.orders.user_id = 123',
  },
  {
    name: 'join with a derived table',
    query: 'SELECT * FROM orders o JOIN (SELECT order_id FROM refunds) r ON r.order_id = o.id',
    expected: 'SELECT * FROM orders o JOIN (SELECT order_id FROM (SELECT * FROM refunds AS __rls WHERE __rls.user_id = 123) refunds) r ON r.order_id = o.id WHERE o.user_id = 123',
  },
  {
    name: 'LATERAL subquery is not a table of the branch',
    schema: rlsSchema,
    query: 'SELECT o.id, l.n FROM orders o CROSS JOIN LATERAL (SELECT COUNT(*) AS n FROM users u WHERE u.id = o.user_id) l',
    expected:
      'SELECT o.id, l.n FROM orders o CROSS JOIN LATERAL (SELECT COUNT(*) AS n FROM users u WHERE u.id = o.user_id) l WHERE o.user_id = 123',
  },
  {
    name: 'quoted alias is kept as written',
    query: 'SELECT * FROM "Order" AS "o" JOIN "User" "u" ON "u"."id" = "o"."userId"',
    config: { rowLevelSecurityColumn: '"userId"' },
    schema: {
      databaseType: 'postgres',
      tables: [
        { name: 'Order', columns: [{ name: 'id', type: 'number' }, { name: 'userId', type: 'number' }] },
        { name: 'User', columns: [{ name: 'id', type: 'number' }] },
      ],
    },
    expected: 'SELECT * FROM "Order" AS "o" JOIN "User" "u" ON "u"."id" = "o"."userId" WHERE "o"."userId" = 123',
  },

  // Custom column
  {
    name: 'custom rowLevelSecurityColumn',
    config: { rowLevelSecurityColumn: 'tenant_id' },
    query: 'SELECT * FROM orders WHERE user_id = 123',
    expected: 'SELECT * FROM orders WHERE user_id = 123 AND tenant_id = 123',
  },
  {
    name: 'custom column duplicate',
    config: { rowLevelSecurityColumn: 'tenant_id' },
    query: 'SELECT * FROM orders WHERE tenant_id = 123',
    expected: 'SELECT * FROM orders WHERE tenant_id = 123',
  },
  {
    name: 'quoted custom column',
    config: { rowLevelSecurityColumn: '"tenantId"' },
    query: 'SELECT * FROM orders',
    expected: 'SELECT * FROM orders WHERE "tenantId" = 123',
  },

  // T-SQL
  {
    name: 'TOP and ORDER BY',
    databaseType: 'mssql',
    query: 'SELECT TOP 5 * FROM orders ORDER BY id',
    expected: 'SELECT TOP 5 * FROM orders WHERE user_id = 123 ORDER BY id',
  },
  {
    name: 'OPTION (...) hint',
    databaseType: 'mssql',
    query: 'SELECT id FROM orders WHERE status = 1 OPTION (RECOMPILE)',
    expected: 'SELECT id FROM orders WHERE status = 1 AND user_id = 123 OPTION (RECOMPILE)',
  },
  {
    name: 'WITH (NOLOCK) table hint',
    databaseType: 'mssql',
    query: 'SELECT id FROM orders WITH (NOLOCK)',
    expected: 'SELECT id FROM orders WITH (NOLOCK) WHERE user_id = 123',
  },

  // Out of scope
  { name: 'INSERT is unchanged', query: 'INSERT INTO orders (id) VALUES (1)', expected: 'INSERT INTO orders (id) VALUES (1)' },
  {
    name: 'RLS disabled',
    config: { enableRowLevelSecurity: false },
    query: 'SELECT * FROM orders',
    expected: 'SELECT * FROM orders',
  },
];

/** User ids that must be refused with SECURITY_VALIDATION_FAILED. */
export interface InvalidUserIdCase {
  name: string;
  userId: unknown;
  databaseType?: DatabaseType | 'generic';
}

export const invalidUserIds: InvalidUserIdCase[] = [
  { name: 'NaN', userId: NaN },
  { name: 'Infinity', userId: Infinity },
  { name: '-Infinity', userId: -Infinity },
  { name: 'NUL in a string', userId: 'abc\0def' },
  { name: 'null', userId: null },
  { name: 'undefined', userId: undefined },
  { name: 'boolean', userId: true },
  { name: 'object', userId: { id: 1 } },
  { name: 'backslash in the generic dialect', userId: 'a\\b', databaseType: 'generic' },
];
