/**
 * Wall-clock checks that validation and row-level security stay linear. They
 * share the CPU with every other jest worker, so a load spike can fail one
 * run: each test is retried twice, and a real regression fails all three.
 */
import { SecurityValidator } from '../../src/security/validator';

jest.retryTimes(2, { logErrorsBeforeRetry: true });

describe('cost', () => {
  it('is linear in the query size', async () => {
    const v = new SecurityValidator(
      { requireUserContext: false, allowUnion: true, restrictedColumns: ['password'] },
      { databaseType: 'postgres', schema: { databaseType: 'postgres', tables: [{ name: 't', columns: [{ name: 'a', type: 'int' }] }] } }
    );
    const build = (n: number) =>
      'SELECT * FROM t WHERE ' + Array.from({ length: n }, (_, i) => `(a = ${i} OR b IN (SELECT c FROM u${i % 7} x${i}))`).join(' AND ');
    // Best of five runs, to keep scheduling noise out of the ratio
    const time = async (sql: string) => {
      let best = Infinity;
      for (let r = 0; r < 5; r++) {
        const t0 = process.hrtime.bigint();
        await v.validate(sql);
        v.addRowLevelSecurity(sql, { userId: 1, role: 'u' });
        best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
      }
      return best;
    };
    // Kept small: other suites (and a timing benchmark) run in parallel.
    // 8x the size: linear work takes ~8x the time, quadratic work ~64x.
    await time(build(100)); // warm up
    const small = await time(build(200));
    const large = await time(build(1600));
    expect(large).toBeLessThan(Math.max(small * 30, 50));
    // Absolute bound only catches pathological cases: parallel suites slow the clock.
    expect(large).toBeLessThan(5000);
  });

  it('stays linear on deep nesting and many branches', async () => {
    const schema = { databaseType: 'postgres' as const, tables: [{ name: 't', columns: [{ name: 'user_id', type: 'int' }] }] };
    const v = new SecurityValidator(
      { requireUserContext: false, allowUnion: true, restrictedColumns: ['t.secret'] },
      { databaseType: 'postgres', schema }
    );
    const depth = 3000;
    const nested = '('.repeat(depth) + 'SELECT * FROM t WHERE (a OR b)' + ')'.repeat(depth);
    const selects = 'SELECT ' + 'COALESCE((SELECT * FROM t x WHERE '.repeat(500) + '1' + '), 0) '.repeat(500).trim();
    const branches = Array.from({ length: 2000 }, (_, i) => `SELECT * FROM t t${i} JOIN t u${i} ON u${i}.a = t${i}.a`).join(' UNION ALL ');
    const t0 = process.hrtime.bigint();
    for (const sql of [nested, selects, branches]) {
      await v.validate(sql);
      v.addRowLevelSecurity(sql, { userId: 1, role: 'u' });
    }
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(2000);
    expect(v.addRowLevelSecurity(nested, { userId: 1, role: 'u' })).toBe(
      '('.repeat(depth) + 'SELECT * FROM t WHERE (a OR b) AND user_id = 1' + ')'.repeat(depth)
    );
  });
});
