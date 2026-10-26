/**
 * checkIdentifiers() on typical model output (Prisma-style quoted names,
 * CTEs, LATERAL, windows, JSON, casts, set operations): none of these valid
 * queries may be reported (src/generator/identifier-check.ts)
 */

import { checkIdentifiers } from '../../src/generator/identifier-check';
import { DatabaseSchema, DatabaseType } from '../../src/types';

/** The schema the queries below are written against. */
const mk = (databaseType: DatabaseType): DatabaseSchema => ({
  databaseType,
  tables: [
    ['User', 'id email createdAt role active'],
    ['Post', 'id authorId title published createdAt'],
    ['payments', 'id amount status created_at'],
    ['users', 'id email created_at'],
    ['orders', 'id user_id total status created_at shipped_at'],
    ['events', 'id data'],
  ].map(([name, cols]) => ({ name, columns: cols.split(' ').map((c) => ({ name: c, type: 'text' })) })),
});

const Q: Array<[DatabaseType, string]> = [
  ['postgres', 'SELECT u."id", COUNT(p."id") AS "postCount" FROM "User" u LEFT JOIN "Post" p ON p."authorId" = u."id" GROUP BY u."id" ORDER BY "postCount" DESC LIMIT 10'],
  ['postgres', `SELECT DATE_TRUNC('month', "createdAt") AS month, COUNT(*) FROM "User" GROUP BY month ORDER BY month`],
  ['postgres', `SELECT * FROM "User" WHERE "createdAt" >= NOW() - INTERVAL '30 days'`],
  ['postgres', 'SELECT "role", COUNT(*) FILTER (WHERE "active") FROM "User" GROUP BY "role"'],
  ['postgres', 'WITH stats AS (SELECT "authorId", COUNT(*) AS n FROM "Post" GROUP BY "authorId") SELECT u.email, s.n FROM "User" u JOIN stats s ON s."authorId" = u.id'],
  ['postgres', 'SELECT email FROM "User" WHERE id IN (SELECT "authorId" FROM "Post" WHERE published = true)'],
  ['postgres', 'SELECT EXTRACT(DOW FROM "createdAt") AS dow FROM "User"'],
  ['postgres', 'SELECT u.email, p.title FROM "User" AS u INNER JOIN "Post" AS p ON u.id = p."authorId" WHERE p.published IS TRUE'],
  ['postgres', `SELECT CASE WHEN "role" = 'ADMIN' THEN 'admin' ELSE 'other' END AS kind, COUNT(*) FROM "User" GROUP BY 1`],
  ['postgres', 'SELECT "User".email FROM "User"'],
  ['postgres', 'SELECT p.*, u.email FROM "Post" p, "User" u WHERE p."authorId" = u.id'],
  ['postgres', `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'succeeded' AND created_at >= DATE_TRUNC('year', CURRENT_DATE)`],
  ['postgres', 'SELECT id FROM "User" ORDER BY random() LIMIT 1'],
  ['postgres', `SELECT to_char("createdAt", 'YYYY-MM-DD') AS day FROM "User"`],
  ['postgres', `SELECT u.id FROM "User" u WHERE u.email LIKE '%@gmail.com' AND NOT EXISTS (SELECT 1 FROM "Post" WHERE "Post"."authorId" = u.id)`],
  ['postgres', 'SELECT "authorId", ARRAY_AGG(title ORDER BY "createdAt" DESC) FROM "Post" GROUP BY "authorId"'],
  ['mysql', 'SELECT u.id, COUNT(*) AS cnt FROM users u JOIN orders o ON o.user_id = u.id WHERE o.created_at >= CURDATE() - INTERVAL 30 DAY GROUP BY u.id HAVING cnt > 2 ORDER BY cnt DESC LIMIT 10'],
  ['mssql', 'SELECT TOP 10 u.Id, u.Email FROM dbo.[User] u WITH (NOLOCK) ORDER BY u.CreatedAt DESC'],
  ['sqlite', `SELECT strftime('%Y-%m', created_at) AS month, SUM(total) FROM orders GROUP BY month`],
  ['postgres', 'SELECT id, total, SUM(total) OVER (PARTITION BY user_id ORDER BY created_at) AS running_total FROM orders'],
  ['postgres', 'SELECT id, LAG(total) OVER w AS prev FROM orders WINDOW w AS (ORDER BY created_at)'],
  ['postgres', `SELECT data->>'name' AS name FROM events WHERE (data->>'age')::int > 30`],
  ['postgres', 'SELECT generate_series(1, 10) AS n'],
  ['postgres', `SELECT id FROM orders WHERE status IN ('paid', 'shipped') AND total BETWEEN 10 AND 100`],
  ['postgres', 'SELECT id FROM orders o WHERE o.total > ALL (SELECT total FROM orders WHERE user_id = 3)'],
  ['postgres', 'SELECT DISTINCT ON (user_id) user_id, total FROM orders ORDER BY user_id, created_at DESC'],
  ['postgres', 'SELECT u.email, o.total FROM "User" u LEFT JOIN LATERAL (SELECT total FROM orders WHERE orders.user_id = u.id ORDER BY created_at DESC LIMIT 1) o ON true'],
  ['postgres', 'SELECT EXTRACT(EPOCH FROM AVG(shipped_at - created_at)) / 3600 AS hours FROM orders'],
  ['postgres', `SELECT CURRENT_DATE - INTERVAL '1 day' AS yesterday`],
  ['mysql', 'SELECT DATE(created_at) AS d, COUNT(*) FROM orders GROUP BY d'],
  ['postgres', 'SELECT u.id FROM "User" u WHERE u."createdAt"::date = CURRENT_DATE'],
  ['postgres', `SELECT id FROM orders WHERE created_at > now() - '1 week'::interval`],
  ['postgres', 'SELECT o.user_id, SUM(o.total) AS spent, RANK() OVER (ORDER BY SUM(o.total) DESC) AS rnk FROM orders o GROUP BY o.user_id'],
  ['postgres', 'SELECT status, COUNT(*) AS count FROM orders GROUP BY status ORDER BY count DESC'],
  ['postgres', 'SELECT COUNT(*) AS total_orders, AVG(total) AS avg_total FROM orders WHERE status <> $$cancelled$$'],
  ['postgres', 'SELECT id FROM orders WHERE user_id = ANY(SELECT id FROM users WHERE email ILIKE $1)'],
  ['mssql', "SELECT FORMAT(created_at, 'yyyy-MM') AS ym, COUNT(*) AS c FROM orders GROUP BY FORMAT(created_at, 'yyyy-MM') ORDER BY ym"],
  ['mssql', 'SELECT o.id, o.total FROM orders o ORDER BY o.total DESC OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY'],
  ['mysql', "SELECT IF(total > 100, 'big', 'small') AS size, COUNT(*) FROM orders GROUP BY size"],
  ['sqlite', "SELECT id FROM orders WHERE date(created_at) >= date('now', '-30 days') ORDER BY created_at DESC LIMIT 5"],
  ['postgres', 'SELECT u.id, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count FROM users u ORDER BY order_count DESC'],
  ['postgres', 'SELECT id FROM users EXCEPT SELECT user_id FROM orders'],
  ['postgres', 'SELECT u.id FROM users u JOIN orders USING (id)'],
  ['postgres', 'SELECT id, total, total * 0.2 AS tax FROM orders WHERE tax > 10'],
];

describe('no false positives on typical model output', () => {
  it.each(Q)('[%s] %s', (d, sql) => {
    expect(checkIdentifiers(sql, mk(d))).toEqual([]);
  });
});

describe('typical hallucinations are reported', () => {
  it.each([
    ['postgres', 'SELECT c.full_name FROM customers c JOIN invoices i ON i.customer_id = c.id', ['unknown_table:customers', 'unknown_table:invoices']],
    ['postgres', 'SELECT u.fullName FROM "User" u', ['unknown_column:fullName']],
    ['postgres', 'SELECT * FROM User', ['needs_quoting:User']],
    ['postgres', 'SELECT name FROM users', ['unknown_column:name']],
    ['mysql', 'SELECT o.amount FROM orders o', ['unknown_column:amount']],
    ['mssql', 'SELECT TOP 5 u.Phone FROM [User] u', ['unknown_column:Phone']],
    ['sqlite', 'SELECT id FROM order_lines', ['unknown_table:order_lines']],
  ] as Array<[DatabaseType, string, string[]]>)('[%s] %s', (d, sql, expected) => {
    expect(checkIdentifiers(sql, mk(d)).map((i) => `${i.kind}:${i.name}`)).toEqual(expected);
  });
});
