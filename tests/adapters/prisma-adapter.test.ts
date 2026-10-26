/**
 * Tests for PrismaAdapter query execution, and ChatbotHelper's execution
 * repair over Prisma errors
 */

import { PrismaAdapter, createPrismaAdapter } from '../../src/adapters';
import { ChatbotHelper } from '../../src/helpers/easy-setup';
import { QueryResult } from '../../src/types';

function fakePrisma(result: unknown = [{ n: BigInt(2) }]) {
  return {
    $queryRaw: jest.fn(async () => {
      throw new Error('$queryRaw must not be called with a plain string');
    }),
    $queryRawUnsafe: jest.fn(async (..._args: unknown[]) => result),
  };
}

/** What Prisma throws when $queryRawUnsafe fails on Postgres (P2010, with the SQLSTATE in meta.code). */
function prismaRawQueryError(sqlState: string, message: string) {
  return Object.assign(
    new Error(
      `\nInvalid \`prisma.$queryRawUnsafe()\` invocation:\n\n\nRaw query failed. Code: \`${sqlState}\`. Message: \`ERROR: ${message}\``
    ),
    {
      name: 'PrismaClientKnownRequestError',
      code: 'P2010',
      clientVersion: '6.0.0',
      meta: { code: sqlState, message: `ERROR: ${message}` },
    }
  );
}

const select = (query: string): QueryResult => ({
  query,
  explanation: 'explained',
  warnings: [],
  metadata: { operation: 'SELECT', tables: ['orders'] },
});

function fakeGenerator(query: string, repaired: string) {
  return {
    generateQuery: jest.fn().mockResolvedValue(select(query)),
    repairQuery: jest.fn().mockResolvedValue(select(repaired)),
    generateQueryWithExplanation: jest.fn(),
    explainQuery: jest.fn(),
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

  it('keeps the Prisma error code and meta on the error, and the Prisma error as its cause', async () => {
    const original = prismaRawQueryError('42883', 'operator does not exist: character varying = integer');
    const prisma = { $queryRawUnsafe: async () => { throw original; } };

    const error = await new PrismaAdapter(prisma).executeQuery('SELECT 1').catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(`Failed to execute query: ${original.message}`);
    expect(error.code).toBe('P2010');
    expect(error.meta).toEqual({ code: '42883', message: 'ERROR: operator does not exist: character varying = integer' });
    expect(error.cause).toBe(original);
    // Like the cause set by new Error(message, { cause }), it is not enumerable.
    expect(Object.keys(error)).toEqual(['code', 'meta']);
  });

  it('adds no code or meta for errors without them', async () => {
    const original = new Error('Raw query failed');
    const prisma = { $queryRawUnsafe: async () => { throw original; } };

    const error = await new PrismaAdapter(prisma).executeQuery('SELECT 1').catch((e) => e);
    expect(Object.keys(error)).toEqual([]);
    expect(error).not.toHaveProperty('code');
    expect(error).not.toHaveProperty('meta');
    expect(error.cause).toBe(original);
  });

  it('defaults to postgres and exposes the database type', () => {
    expect(new PrismaAdapter(fakePrisma()).getDatabaseType()).toBe('postgres');
    expect(createPrismaAdapter(fakePrisma(), 'sqlite').getDatabaseType()).toBe('sqlite');
  });
});

describe('ChatbotHelper execution repair through PrismaAdapter', () => {
  // Regression: a Postgres error raised through Prisma (P2010 with meta.code) is
  // classified like the same error raised through pg.
  it('repairs a query whose Prisma error carries a repairable SQLSTATE in meta.code', async () => {
    const prisma = {
      $queryRawUnsafe: jest
        .fn()
        .mockRejectedValueOnce(prismaRawQueryError('42804', 'argument of WHERE must be type boolean, not type integer'))
        .mockResolvedValueOnce([{ id: 1 }]),
    };
    const generator = fakeGenerator('SELECT id FROM orders WHERE 1', 'SELECT id FROM orders WHERE true');

    const chatbot = new ChatbotHelper(generator as any, new PrismaAdapter(prisma, 'postgres'), { repairAttempts: 1 });
    const result = await chatbot.ask('all orders');

    expect(generator.repairQuery).toHaveBeenCalledTimes(1);
    expect(result.query).toBe('SELECT id FROM orders WHERE true');
    expect(result.results).toEqual([{ id: 1 }]);
  });

  it('repairs "operator does not exist" from its message alone', async () => {
    const adapter = {
      executeQuery: jest
        .fn()
        .mockRejectedValueOnce(new Error('Failed to execute query: operator does not exist: character varying = integer'))
        .mockResolvedValueOnce([{ id: 1 }]),
    };
    const generator = fakeGenerator('SELECT id FROM orders WHERE code = 5', "SELECT id FROM orders WHERE code = '5'");

    const result = await new ChatbotHelper(generator as any, adapter as any, { repairAttempts: 1 }).ask('order 5');
    expect(generator.repairQuery).toHaveBeenCalledTimes(1);
    expect(result.query).toBe("SELECT id FROM orders WHERE code = '5'");
  });

  it('looks through error.cause, for adapters that wrap the driver error', async () => {
    const driverError = Object.assign(new Error('a schema error'), { code: '42P10' });
    const wrapped = Object.assign(new Error('Query failed'), { cause: driverError });
    const adapter = { executeQuery: jest.fn().mockRejectedValueOnce(wrapped).mockResolvedValueOnce([]) };
    const generator = fakeGenerator('SELECT DISTINCT id FROM orders ORDER BY total', 'SELECT DISTINCT id, total FROM orders ORDER BY total');

    await new ChatbotHelper(generator as any, adapter as any, { repairAttempts: 1 }).ask('ids by total');
    expect(generator.repairQuery).toHaveBeenCalledTimes(1);
  });

  it('does not repair a Prisma permission error, and stops on a cyclic cause', async () => {
    const denied = prismaRawQueryError('42501', 'permission denied for table orders');
    const cyclic: any = new Error('Query failed');
    cyclic.cause = cyclic;

    for (const error of [denied, cyclic]) {
      const adapter = { executeQuery: jest.fn().mockRejectedValue(error) };
      const generator = fakeGenerator('SELECT id FROM orders', 'SELECT id FROM orders');
      const thrown = await new ChatbotHelper(generator as any, new PrismaAdapter({ $queryRawUnsafe: adapter.executeQuery }), {
        repairAttempts: 1,
      })
        .ask('ids')
        .catch((e) => e);
      expect(thrown.cause).toBe(error);
      expect(generator.repairQuery).not.toHaveBeenCalled();
    }
  });
});
