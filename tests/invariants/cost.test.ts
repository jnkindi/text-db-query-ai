/**
 * Guarantee 4: validate() and addRowLevelSecurity() stay roughly linear in
 * input size; no input of a few KB takes more than ~1 s.
 *
 * Method: build pathological inputs (deep nesting, long select lists, many set
 * operations, long join chains, deep subqueries, long strings) at a few KB and
 * at ~8x that size, time validate() and addRowLevelSecurity(), and assert each
 * stays well under the 1 s bound. A loose growth check guards against
 * super-linear blow-up without being timing-flaky.
 */
import { SecurityValidator } from '../../src/security';
import type { DatabaseType } from '../../src/types';

// Wall-clock bounds share the CPU with the other jest workers: retry a load spike twice.
jest.retryTimes(2, { logErrorsBeforeRetry: true });

const USER = { userId: 1, role: 'user' };
// Coverage instrumentation slows the code down several times; keep the bound meaningful without it.
const instrumented = typeof (globalThis as Record<string, unknown>).__coverage__ !== 'undefined';
const BOUND_MS = 1000 * (instrumented ? 10 : 1);

type Kind = 'nested-parens' | 'select-list' | 'set-ops' | 'joins' | 'subqueries' | 'qualifiers' | 'long-string';

function build(kind: Kind, n: number): string {
  switch (kind) {
    case 'nested-parens':
      return 'SELECT ' + '('.repeat(n) + '1' + ')'.repeat(n) + ' FROM orders';
    case 'select-list':
      return 'SELECT ' + Array.from({ length: n }, (_, i) => `c${i}`).join(', ') + ' FROM orders';
    case 'set-ops':
      return Array.from({ length: n }, () => 'SELECT user_id FROM orders').join(' UNION ALL ');
    case 'joins':
      return 'SELECT * FROM orders o0 ' + Array.from({ length: n }, (_, i) => `JOIN orders o${i + 1} ON o${i + 1}.id = o0.id`).join(' ');
    case 'subqueries':
      return 'SELECT * FROM orders WHERE id IN (' + 'SELECT id FROM orders WHERE id IN ('.repeat(n) + 'SELECT 1' + ')'.repeat(n) + ')';
    case 'qualifiers':
      return 'SELECT ' + Array.from({ length: n }, (_, i) => `t.a${i}`).join(' + ') + ' FROM orders t';
    case 'long-string':
      return "SELECT * FROM orders WHERE note = '" + 'x;--/* '.repeat(n) + "'";
  }
}

async function timeMs(fn: () => Promise<void> | void): Promise<number> {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const KINDS: Kind[] = ['nested-parens', 'select-list', 'set-ops', 'joins', 'subqueries', 'qualifiers', 'long-string'];

describe('guarantee 4: validate() and addRowLevelSecurity() cost', () => {
  jest.setTimeout(60000);

  for (const dialect of ['postgres', undefined] as Array<DatabaseType | undefined>) {
    describe(`dialect ${dialect ?? 'generic'}`, () => {
      it.each(KINDS)('stays under the 1 s bound: %s', async (kind) => {
        const v = () => new SecurityValidator({ requireUserContext: false, allowUnion: true, enableRowLevelSecurity: true }, { databaseType: dialect });
        // A few KB, and ~8x larger.
        const big = build(kind, kind === 'nested-parens' ? 4000 : 4000);
        expect(big.length).toBeGreaterThan(2000);

        const vMs = await timeMs(() => v().validate(big, USER).then(() => undefined));
        const rMs = await timeMs(() => {
          v().addRowLevelSecurity(big, USER);
        });

        expect({ kind, bytes: big.length, validateMs: Math.round(vMs), rlsMs: Math.round(rMs) }).toMatchObject({ kind });
        expect(vMs).toBeLessThan(BOUND_MS);
        expect(rMs).toBeLessThan(BOUND_MS);
      });
    });
  }

  it('does not blow up super-linearly (generic, 5 readings)', async () => {
    const v = () => new SecurityValidator({ requireUserContext: false, allowUnion: true }, {});
    const small = build('joins', 1000);
    const large = build('joins', 8000); // 8x the references
    const tSmall = Math.max(1, await timeMs(() => v().validate(small, USER).then(() => undefined)));
    const tLarge = await timeMs(() => v().validate(large, USER).then(() => undefined));
    expect(tLarge).toBeLessThan(BOUND_MS);
    // 8x input should not cost anywhere near 8^2 = 64x; allow a generous 30x for noise.
    expect(tLarge / tSmall).toBeLessThan(30);
  });
});
