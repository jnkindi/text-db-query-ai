/**
 * Performance of the lexer and analyzer: a ~2 KB query analyzed 10,000 times,
 * and linear behaviour on large or deeply nested inputs.
 */

import { analyzeSql } from '../../src/sql/analyze';
import { tokenize } from '../../src/sql/lexer';

// Coverage instrumentation slows the code down several times; keep the bounds meaningful without it.
const instrumented = typeof (globalThis as Record<string, unknown>).__coverage__ !== 'undefined';
const SCALE = instrumented ? 10 : 1;

function elapsedMs(fn: () => void): number {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function buildQuery(): string {
  let q =
    "WITH monthly AS (SELECT date_trunc('month', o.created_at) AS m, o.user_id, SUM(o.total_amount) AS revenue " +
    "FROM orders o WHERE o.status IN ('paid', 'shipped') GROUP BY 1, 2), " +
    'ranked AS (SELECT m, user_id, revenue, ROW_NUMBER() OVER (PARTITION BY m ORDER BY revenue DESC) AS rn FROM monthly) ' +
    "SELECT r.m, u.email, u.\"firstName\", r.revenue, COALESCE(p.plan_name, 'free') AS plan, EXTRACT(YEAR FROM r.m) AS yr, " +
    "CASE WHEN r.revenue > 1000 THEN 'big' WHEN r.revenue > 100 THEN 'medium' ELSE 'small' END AS bucket, " +
    "(SELECT COUNT(*) FROM support_tickets t WHERE t.user_id = u.id AND t.created_at >= NOW() - INTERVAL '30 days') AS tickets, " +
    "u.metadata->>'source' AS source, u.tags @> ARRAY['vip'] AS is_vip, CAST(r.revenue AS DECIMAL(12,2)) AS revenue_fixed " +
    'FROM ranked r JOIN users u ON u.id = r.user_id LEFT JOIN plans p ON p.id = u.plan_id ' +
    'LEFT JOIN LATERAL (SELECT MAX(l.created_at) AS last_login FROM logins l WHERE l.user_id = u.id) ll ON TRUE ' +
    "WHERE r.rn <= 10 AND u.deleted_at IS NULL AND u.email NOT ILIKE '%@example.com' AND r.m BETWEEN '2025-01-01'::date AND CURRENT_DATE " +
    'GROUP BY r.m, u.email, u."firstName", r.revenue, p.plan_name, u.metadata, u.tags, u.id ' +
    'HAVING SUM(r.revenue) > 0 ORDER BY r.m DESC NULLS LAST, r.revenue DESC LIMIT 100 OFFSET 0';
  let i = 0;
  while (q.length < 2048) {
    q += ` UNION ALL SELECT id, email, name, total_amount, status, created_at FROM archive_${i++} a WHERE a.x = 1`;
  }
  return q;
}

describe('performance', () => {
  it('analyzes a ~2 KB query 10,000 times quickly', () => {
    const sql = buildQuery();
    expect(sql.length).toBeGreaterThanOrEqual(2048);
    expect(sql.length).toBeLessThan(2300);
    const first = analyzeSql(sql, 'postgres');
    expect(first.tables.length).toBeGreaterThan(5);
    for (let i = 0; i < 500; i++) analyzeSql(sql, 'postgres'); // warm up
    // 10,000 runs in 5 batches. The bound uses the fastest batch so that other
    // jest workers competing for the CPU do not make the test flaky.
    const batches: number[] = [];
    for (let b = 0; b < 5; b++) {
      batches.push(
        elapsedMs(() => {
          for (let i = 0; i < 2000; i++) analyzeSql(sql, 'postgres');
        })
      );
    }
    const total = batches.reduce((a, b) => a + b, 0);
    const best = Math.min(...batches) * 5;
    // Reported for the release notes; typically ~0.4 s on a laptop.
    // eslint-disable-next-line no-console
    console.log(
      `analyzeSql: 10,000 x ${sql.length}-char query in ${total.toFixed(0)} ms (best batch rate ${best.toFixed(0)} ms per 10,000)${instrumented ? ' (instrumented)' : ''}`
    );
    expect(best).toBeLessThan(1000 * SCALE);
  });

  it('analyzes a query with a 1 MB string literal in linear time', () => {
    const sql = "SELECT id FROM t WHERE note = '" + 'x'.repeat(1024 * 1024) + "'";
    let tables = 0;
    const ms = elapsedMs(() => {
      tables = analyzeSql(sql, 'mysql').tables.length;
    });
    expect(tables).toBe(1);
    expect(ms).toBeLessThan(300 * SCALE);
  });

  it('stays linear on deep nesting and long lists (no recursion or rescans)', () => {
    const shapes: Array<(d: number) => string> = [
      (d) => 'SELECT * FROM ' + '('.repeat(d) + 'a JOIN b ON a.x = b.x' + ')'.repeat(d),
      (d) => 'SELECT * FROM ' + '(SELECT * FROM '.repeat(d) + 't' + ') x'.repeat(d),
      (d) => 'SELECT ' + 'CAST('.repeat(d) + 'x' + ' AS int)'.repeat(d) + ' FROM t',
      (d) => 'SELECT ' + 'CASE WHEN a THEN '.repeat(d) + '1' + ' END'.repeat(d) + ' FROM t',
      (d) => 'SELECT * FROM ' + '('.repeat(d) + 'a',
      (d) => 'SELECT * FROM ' + Array.from({ length: d }, (_, i) => `t${i}`).join(', '),
      (d) => 'WITH ' + Array.from({ length: d }, (_, i) => `c${i} AS (SELECT * FROM t${i})`).join(', ') + ' SELECT * FROM c0',
      (d) => 'SELECT * FROM ' + '(WITH x AS (SELECT 1) SELECT * FROM '.repeat(d) + 't' + ') y'.repeat(d),
    ];
    for (const make of shapes) {
      const sql = make(5000);
      const ms = elapsedMs(() => analyzeSql(sql, 'postgres'));
      expect(ms).toBeLessThan(500 * SCALE);
    }
  });

  it('tokenizes 1 MB of ordinary SQL quickly', () => {
    const unit = "SELECT a.id, b.name FROM a JOIN b ON a.id = b.a_id WHERE b.x = 'y' AND a.z > 10;\n";
    const sql = unit.repeat(Math.ceil((1024 * 1024) / unit.length));
    const ms = elapsedMs(() => tokenize(sql, 'postgres'));
    expect(ms).toBeLessThan(1000 * SCALE);
  });
});
