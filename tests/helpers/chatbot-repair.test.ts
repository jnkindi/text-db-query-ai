/**
 * ChatbotHelper execution repair (opt-in `repairAttempts`) and the full
 * UserContext type (src/helpers/easy-setup.ts)
 */

import { ChatbotHelper } from '../../src/helpers/easy-setup';
import { QueryGenerator } from '../../src/generator';
import { DatabaseIntrospectionAdapter } from '../../src/adapters';
import { QueryResult, UserContext } from '../../src/types';
import { ScriptedProvider } from '../generator/scripted-provider';

const select = (query: string, extra: Partial<QueryResult> = {}): QueryResult => ({
  query,
  explanation: 'explained',
  warnings: [],
  metadata: { operation: 'SELECT', tables: ['users'] },
  ...extra,
});

function mocks() {
  const generator = {
    generateQuery: jest.fn(),
    generateQueryWithExplanation: jest.fn(),
    repairQuery: jest.fn(),
    explainQuery: jest.fn(),
  };
  const adapter = { executeQuery: jest.fn() };
  return { generator, adapter };
}

const dbError = (message: string, fields: Record<string, unknown> = {}) => Object.assign(new Error(message), fields);

describe('ChatbotHelper repair', () => {
  const ctx: UserContext = { userId: 9, role: 'analyst', permissions: ['read'], metadata: { team: 'x' } };

  it('is off by default: the database error is thrown and nothing is sent to the model', async () => {
    const { generator, adapter } = mocks();
    generator.generateQuery.mockResolvedValue(select('SELECT emial FROM users'));
    adapter.executeQuery.mockRejectedValue(dbError('column "emial" does not exist', { code: '42703' }));
    const chatbot = new ChatbotHelper(generator as any, adapter as any);
    await expect(chatbot.ask('emails', ctx)).rejects.toThrow('column "emial" does not exist');
    expect(generator.repairQuery).not.toHaveBeenCalled();
  });

  it('repairs a SELECT that fails with a schema error and executes the repaired query', async () => {
    const { generator, adapter } = mocks();
    generator.generateQuery.mockResolvedValue(select('SELECT emial FROM users'));
    generator.repairQuery.mockResolvedValue(select('SELECT email FROM users', { warnings: ['w'], metadata: { operation: 'SELECT', tables: ['users'], attempts: 1 } }));
    adapter.executeQuery
      .mockRejectedValueOnce(dbError('column "emial" does not exist', { code: '42703', hint: 'Perhaps you meant to reference the column "users.email".' }))
      .mockResolvedValueOnce([{ email: 'a@b.c' }]);
    const chatbot = new ChatbotHelper(generator as any, adapter as any, { repairAttempts: 1 });

    const result = await chatbot.ask('emails', ctx);
    expect(generator.generateQuery).toHaveBeenCalledWith('emails', ctx);
    expect(generator.repairQuery).toHaveBeenCalledWith(
      'emails',
      'SELECT emial FROM users',
      'column "emial" does not exist (hint: Perhaps you meant to reference the column "users.email".)',
      ctx
    );
    expect(adapter.executeQuery).toHaveBeenNthCalledWith(2, 'SELECT email FROM users', undefined);
    expect(result).toEqual({
      question: 'emails',
      query: 'SELECT email FROM users',
      results: [{ email: 'a@b.c' }],
      metadata: { operation: 'SELECT', tables: ['users'], attempts: 1 },
      warnings: ['w'],
    });
  });

  it.each([
    ['pg undefined table', dbError('relation "user" does not exist', { code: '42P01' })],
    ['pg syntax', dbError('syntax error at or near "FROM"', { code: '42601' })],
    ['Prisma wrapped', dbError('Failed to execute query: Raw query failed. Code: `42703`. Message: `column "x" does not exist`')],
    ['mysql', dbError("Unknown column 'x' in 'field list'", { code: 'ER_BAD_FIELD_ERROR', errno: 1054 })],
    ['mysql table', dbError("Table 'shop.userz' doesn't exist", { errno: 1146 })],
    ['sqlite', dbError('SQLITE_ERROR: no such column: x', { code: 'SQLITE_ERROR', errno: 1 })],
    ['mssql', dbError("Invalid column name 'x'.", { number: 207 })],
  ])('treats %s errors as repairable', async (_name, error) => {
    const { generator, adapter } = mocks();
    generator.generateQuery.mockResolvedValue(select('SELECT x FROM users'));
    generator.repairQuery.mockResolvedValue(select('SELECT id FROM users'));
    adapter.executeQuery.mockRejectedValueOnce(error).mockResolvedValueOnce([]);
    await new ChatbotHelper(generator as any, adapter as any, { repairAttempts: 1 }).ask('q');
    expect(generator.repairQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['permission', dbError('permission denied for table users', { code: '42501' })],
    ['connection', dbError('connect ECONNREFUSED 127.0.0.1:5432', { code: 'ECONNREFUSED', errno: -61 })],
    ['timeout', dbError('canceling statement due to statement timeout', { code: '57014' })],
    ['bad data', dbError('invalid input syntax for type integer: "abc"', { code: '22P02' })],
  ])('does not repair %s errors', async (_name, error) => {
    const { generator, adapter } = mocks();
    generator.generateQuery.mockResolvedValue(select('SELECT id FROM users'));
    adapter.executeQuery.mockRejectedValue(error);
    await expect(new ChatbotHelper(generator as any, adapter as any, { repairAttempts: 3 }).ask('q')).rejects.toBe(error);
    expect(generator.repairQuery).not.toHaveBeenCalled();
  });

  it('only repairs SELECT queries', async () => {
    const { generator, adapter } = mocks();
    const error = dbError('column "x" does not exist', { code: '42703' });
    generator.generateQuery.mockResolvedValue(select('UPDATE users SET x = 1', { metadata: { operation: 'UPDATE', tables: ['users'] } }));
    adapter.executeQuery.mockRejectedValue(error);
    await expect(new ChatbotHelper(generator as any, adapter as any, { repairAttempts: 1 }).ask('q')).rejects.toBe(error);
    expect(generator.repairQuery).not.toHaveBeenCalled();
  });

  it('stops after repairAttempts and throws the last database error', async () => {
    const { generator, adapter } = mocks();
    const first = dbError('no such column: a');
    const second = dbError('no such column: b');
    const third = dbError('no such column: c');
    generator.generateQuery.mockResolvedValue(select('SELECT a FROM users'));
    generator.repairQuery.mockResolvedValueOnce(select('SELECT b FROM users')).mockResolvedValueOnce(select('SELECT c FROM users'));
    adapter.executeQuery.mockRejectedValueOnce(first).mockRejectedValueOnce(second).mockRejectedValueOnce(third);
    await expect(new ChatbotHelper(generator as any, adapter as any, { repairAttempts: 2 }).ask('q')).rejects.toBe(third);
    expect(generator.repairQuery).toHaveBeenCalledTimes(2);
    expect(generator.repairQuery).toHaveBeenNthCalledWith(2, 'q', 'SELECT b FROM users', 'no such column: b', undefined);
  });

  it('throws the database error when no repair can be generated', async () => {
    const { generator, adapter } = mocks();
    const error = dbError('no such table: userz');
    generator.generateQuery.mockResolvedValue(select('SELECT id FROM userz'));
    generator.repairQuery.mockRejectedValue(new Error('cannot answer'));
    adapter.executeQuery.mockRejectedValue(error);
    await expect(new ChatbotHelper(generator as any, adapter as any, { repairAttempts: 1 }).ask('q')).rejects.toBe(error);
  });

  it('explains the repaired query in askWithExplanation', async () => {
    const { generator, adapter } = mocks();
    generator.generateQueryWithExplanation.mockResolvedValue(select('SELECT emial FROM users', { explanation: 'old' }));
    generator.repairQuery.mockResolvedValue(select('SELECT email FROM users'));
    generator.explainQuery.mockResolvedValue('Lists every email.');
    adapter.executeQuery.mockRejectedValueOnce(dbError('no such column: emial')).mockResolvedValueOnce([{ email: 'x' }]);
    const result = await new ChatbotHelper(generator as any, adapter as any, { repairAttempts: 1 }).askWithExplanation('emails', ctx);
    expect(generator.explainQuery).toHaveBeenCalledWith('SELECT email FROM users');
    expect(result).toMatchObject({ query: 'SELECT email FROM users', explanation: 'Lists every email.', results: [{ email: 'x' }] });
  });

  it('keeps the generated explanation, metadata and warnings when no repair happened', async () => {
    const { generator, adapter } = mocks();
    generator.generateQueryWithExplanation.mockResolvedValue(select('SELECT id FROM users', { explanation: 'Lists ids.', warnings: ['w'] }));
    adapter.executeQuery.mockResolvedValue({ id: 1 });
    const result = await new ChatbotHelper(generator as any, adapter as any, { repairAttempts: 1 }).askWithExplanation('ids');
    expect(generator.explainQuery).not.toHaveBeenCalled();
    expect(result).toEqual({
      question: 'ids',
      query: 'SELECT id FROM users',
      explanation: 'Lists ids.',
      results: [{ id: 1 }],
      metadata: { operation: 'SELECT', tables: ['users'] },
      warnings: ['w'],
    });
  });

  it('ignores invalid repairAttempts values', async () => {
    for (const repairAttempts of [-1, Number.NaN, Infinity]) {
      const { generator, adapter } = mocks();
      const error = dbError('no such column: x');
      generator.generateQuery.mockResolvedValue(select('SELECT x FROM users'));
      adapter.executeQuery.mockRejectedValue(error);
      await expect(new ChatbotHelper(generator as any, adapter as any, { repairAttempts }).ask('q')).rejects.toBe(error);
      expect(generator.repairQuery).not.toHaveBeenCalled();
    }
  });
});

/** sqlite3 is a native module; without its binding the database-backed test is skipped. */
function loadSqlite3(): typeof import('sqlite3') | undefined {
  try {
    return require('sqlite3');
  } catch {
    return undefined;
  }
}
const sqlite3 = loadSqlite3();
const describeIfSqlite = sqlite3 ? describe : describe.skip;

describeIfSqlite('ChatbotHelper repair against in-memory SQLite', () => {
  let db: import('sqlite3').Database;

  beforeAll(async () => {
    db = new sqlite3!.Database(':memory:');
    await new Promise<void>((resolve, reject) =>
      db.exec(
        `CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
         INSERT INTO users (email) VALUES ('a@x.com'), ('b@x.com');`,
        (error) => (error ? reject(error) : resolve())
      )
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (db ? db.close(() => resolve()) : resolve()));
  });

  it('sends the SQLite error back and returns the rows of the repaired query', async () => {
    const adapter = new DatabaseIntrospectionAdapter(db, 'sqlite');
    const schema = await adapter.extractSchema();
    // nosuch_upper() passes every static check but fails in SQLite.
    const provider = new ScriptedProvider(['SELECT nosuch_upper(email) AS e FROM users ORDER BY id']);
    const generator = new QueryGenerator({
      llm: { provider: 'openai', apiKey: 'sk-test' },
      database: schema,
      security: { requireUserContext: false },
      llmProvider: provider,
    });

    await expect(new ChatbotHelper(generator, adapter).ask('emails')).rejects.toThrow('no such function: nosuch_upper');

    provider.push('SELECT nosuch_upper(email) AS e FROM users ORDER BY id', 'SELECT upper(email) AS e FROM users ORDER BY id');
    const before = provider.calls.length;
    const result = await new ChatbotHelper(generator, adapter, { repairAttempts: 1 }).ask('emails');
    expect(result.query).toBe('SELECT upper(email) AS e FROM users ORDER BY id');
    expect(result.results).toEqual([{ e: 'A@X.COM' }, { e: 'B@X.COM' }]);
    const repairPrompt = provider.calls[before + 1].prompt;
    expect(repairPrompt).toContain('<failed_query>\nSELECT nosuch_upper(email) AS e FROM users ORDER BY id\n</failed_query>');
    expect(repairPrompt).toContain('no such function: nosuch_upper');
  });
});
