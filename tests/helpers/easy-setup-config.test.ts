/**
 * The create* helpers pass the new LLM, generator and ChatbotHelper options
 * through, and keep the 0.0.1 config when none are given
 * (src/helpers/easy-setup.ts)
 */

import {
  createFromDatabase,
  createFromPrisma,
  createChatbotFromDatabase,
  createChatbotFromPrisma,
  ChatbotHelper,
  EasySetupConfig,
} from '../../src/helpers';
import { QueryGenerator } from '../../src/generator';
import { ClaudeProvider, OpenAIProvider } from '../../src/providers';

/** sqlite3 is a native module; without its binding these tests are skipped. */
function loadSqlite3(): typeof import('sqlite3') | undefined {
  try {
    return require('sqlite3');
  } catch {
    return undefined;
  }
}
const sqlite3 = loadSqlite3();
const describeIfSqlite = sqlite3 ? describe : describe.skip;

describeIfSqlite('easy setup pass-through', () => {
  let db: import('sqlite3').Database;
  let prisma: object;

  beforeAll(async () => {
    db = new sqlite3!.Database(':memory:');
    await new Promise<void>((resolve, reject) =>
      db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL);', (error) => (error ? reject(error) : resolve()))
    );
    const all = (sql: string, params: unknown[] = []) =>
      new Promise<unknown[]>((resolve, reject) => db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))));
    prisma = { $queryRawUnsafe: (sql: string, ...values: unknown[]) => all(sql, values) };
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (db ? db.close(() => resolve()) : resolve()));
  });

  const logger = jest.fn();
  const FULL: EasySetupConfig = {
    llmProvider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-test',
    security: { requireUserContext: false },
    debug: false,
    temperature: 0.2,
    maxTokens: 123,
    baseURL: 'https://llm.example.test/v1',
    timeout: 5000,
    maxRetries: 4,
    defaultHeaders: { 'x-team': 'data' },
    reasoningEffort: 'low',
    tokenLimitParam: 'max_tokens',
    examples: [{ question: 'How many users?', sql: 'SELECT COUNT(*) FROM users' }],
    instructions: 'Users are customers.',
    identifierCheck: 'strict',
    maxCorrectionAttempts: 2,
    logger,
    userContext: { userId: 1, role: 'admin' },
    repairAttempts: 2,
  };

  const configOf = (generator: QueryGenerator) => (generator as any).config;

  it('passes the LLM and generator options on (createFromDatabase, createFromPrisma)', async () => {
    for (const generator of [await createFromDatabase(db, 'sqlite', FULL), await createFromPrisma(prisma, 'sqlite', FULL)]) {
      const config = configOf(generator);
      expect(config.llm).toEqual({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'gpt-test',
        temperature: 0.2,
        maxTokens: 123,
        baseURL: 'https://llm.example.test/v1',
        timeout: 5000,
        maxRetries: 4,
        defaultHeaders: { 'x-team': 'data' },
        reasoningEffort: 'low',
        tokenLimitParam: 'max_tokens',
      });
      expect(config).toMatchObject({
        security: { requireUserContext: false },
        debug: false,
        examples: FULL.examples,
        instructions: 'Users are customers.',
        identifierCheck: 'strict',
        maxCorrectionAttempts: 2,
        logger,
        userContext: { userId: 1, role: 'admin' },
      });
      expect(config).not.toHaveProperty('repairAttempts');
      expect(config.database.tables.map((t: { name: string }) => t.name)).toEqual(['users']);
      expect((generator as any).llmProvider).toBeInstanceOf(OpenAIProvider);
    }
  });

  it('passes the Claude options on', async () => {
    const generator = await createFromDatabase(db, 'sqlite', {
      llmProvider: 'claude',
      apiKey: 'sk-ant-test',
      effort: 'medium',
      fallbacks: false,
      promptCaching: false,
    });
    expect(configOf(generator).llm).toEqual({
      provider: 'claude',
      apiKey: 'sk-ant-test',
      model: undefined,
      effort: 'medium',
      fallbacks: false,
      promptCaching: false,
    });
    expect((generator as any).llmProvider).toBeInstanceOf(ClaudeProvider);
  });

  it('builds the 0.0.1 config when only the 0.0.1 options are given', async () => {
    const generator = await createFromDatabase(db, 'sqlite', { llmProvider: 'openai', apiKey: 'sk-test', debug: true });
    const config = configOf(generator);
    expect(Object.keys(config).sort()).toEqual(['database', 'debug', 'llm', 'security']);
    expect(config.llm).toEqual({ provider: 'openai', apiKey: 'sk-test', model: undefined });
  });

  it('passes repairAttempts to the chatbot helpers', async () => {
    const fromDb = await createChatbotFromDatabase(db, 'sqlite', FULL);
    const fromPrisma = await createChatbotFromPrisma(prisma, 'sqlite', FULL);
    for (const chatbot of [fromDb, fromPrisma]) {
      expect(chatbot).toBeInstanceOf(ChatbotHelper);
      expect((chatbot as any).repairAttempts).toBe(2);
      expect(configOf((chatbot as any).generator)).toMatchObject({ identifierCheck: 'strict', instructions: 'Users are customers.' });
    }
    const plain = await createChatbotFromDatabase(db, 'sqlite', { llmProvider: 'openai', apiKey: 'sk-test' });
    expect((plain as any).repairAttempts).toBe(0);
  });
});
