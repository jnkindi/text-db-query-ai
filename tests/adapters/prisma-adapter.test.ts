/**
 * Tests for PrismaAdapter query execution
 */

import { PrismaAdapter, createPrismaAdapter } from '../../src/adapters';

function fakePrisma(result: unknown = [{ n: BigInt(2) }]) {
  return {
    $queryRaw: jest.fn(async () => {
      throw new Error('$queryRaw must not be called with a plain string');
    }),
    $queryRawUnsafe: jest.fn(async (..._args: unknown[]) => result),
  };
}

describe('PrismaAdapter.executeQuery', () => {
  it('binds parameters with $queryRawUnsafe(query, ...params)', async () => {
    const prisma = fakePrisma();
    const adapter = new PrismaAdapter(prisma, 'postgres');

    await adapter.executeQuery('SELECT * FROM "User" WHERE id = $1 AND role = $2', [1, 'admin']);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledWith('SELECT * FROM "User" WHERE id = $1 AND role = $2', 1, 'admin');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('runs a query without parameters as 0.0.1 did', async () => {
    const prisma = fakePrisma();
    await new PrismaAdapter(prisma).executeQuery('SELECT 1', []);
    await new PrismaAdapter(prisma).executeQuery('SELECT 2');
    expect(prisma.$queryRawUnsafe.mock.calls).toEqual([['SELECT 1'], ['SELECT 2']]);
  });

  it('returns results as Prisma gives them (BigInt included)', async () => {
    const prisma = fakePrisma([{ n: BigInt(2) }]);
    await expect(new PrismaAdapter(prisma).executeQuery('SELECT COUNT(*) AS n FROM t')).resolves.toEqual([{ n: BigInt(2) }]);
  });

  it('keeps the 0.0.1 error message prefix', async () => {
    const prisma = { $queryRawUnsafe: async () => { throw new Error('Raw query failed. Code: `1`'); } };
    await expect(new PrismaAdapter(prisma).executeQuery('SELECT ?', [1])).rejects.toThrow(
      'Failed to execute query: Raw query failed. Code: `1`'
    );
  });

  it('defaults to postgres and exposes the database type', () => {
    expect(new PrismaAdapter(fakePrisma()).getDatabaseType()).toBe('postgres');
    expect(createPrismaAdapter(fakePrisma(), 'sqlite').getDatabaseType()).toBe('sqlite');
  });
});
