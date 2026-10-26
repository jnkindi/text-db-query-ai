/**
 * The security layer end to end, through the public QueryGenerator API
 * (constructor + generateQuery) with a scripted fake LLM. The model's output
 * is treated as attacker-controlled (prompt injection).
 *
 * Only the public API is used, so the test does not depend on how the
 * generator pipeline is organized internally.
 */

import { DatabaseSchema, QueryResult, TextToQueryConfig, TextToQueryError, UserContext } from '../../src/types';

jest.mock('../../src/providers', () => {
  const actual = jest.requireActual('../../src/providers');
  return { ...actual, createLLMProvider: jest.fn() };
});

// eslint-disable-next-line import/first
import { createLLMProvider, BaseLLMProvider } from '../../src/providers';
// eslint-disable-next-line import/first
import { QueryGenerator } from '../../src/generator';

/** Answers every request with the next scripted response (the last one repeats). */
class ScriptedProvider extends BaseLLMProvider {
  readonly calls: string[] = [];
  private index = 0;

  constructor(private readonly responses: string[]) {
    super({ provider: 'openai', apiKey: 'test' });
  }

  async generate(prompt: string): Promise<string> {
    this.calls.push(prompt);
    return this.responses[Math.min(this.index++, this.responses.length - 1)];
  }

  async generateWithSystem(system: string, prompt: string): Promise<string> {
    return this.generate(`${system}\n\n${prompt}`);
  }

  async validateApiKey(): Promise<boolean> {
    return true;
  }

  getDefaultModel(): string {
    return 'scripted';
  }
}

function schema(databaseType: DatabaseSchema['databaseType']): DatabaseSchema {
  return {
    databaseType,
    tables: [
      {
        name: 'orders',
        primaryKey: 'id',
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'user_id', type: 'integer' },
          { name: 'status', type: 'varchar' },
          { name: 'total', type: 'decimal' },
          { name: 'note', type: 'text' },
          { name: 'created_at', type: 'timestamp' },
        ],
      },
    ],
  };
}

function generatorFor(response: string | string[], overrides: Partial<TextToQueryConfig> = {}): { gen: QueryGenerator; provider: ScriptedProvider } {
  const provider = new ScriptedProvider(Array.isArray(response) ? response : [response]);
  (createLLMProvider as jest.Mock).mockReturnValue(provider);
  const gen = new QueryGenerator({
    llm: { provider: 'openai', apiKey: 'test' },
    database: schema('postgres'),
    security: { allowedOperations: ['SELECT'], requireUserContext: false },
    ...overrides,
  });
  return { gen, provider };
}

const user: UserContext = { userId: 1, role: 'user' };

async function rejection(promise: Promise<QueryResult>): Promise<TextToQueryError> {
  try {
    const result = await promise;
    throw new Error(`expected a rejection, got ${JSON.stringify(result.query)}`);
  } catch (error) {
    expect(error).toBeInstanceOf(TextToQueryError);
    return error as TextToQueryError;
  }
}

describe('stacked statements', () => {
  it.each([
    'SELECT id FROM orders; DELETE FROM orders; -- done',
    '```sql\nSELECT id FROM orders;\nDELETE FROM orders;\n-- done\n```',
    'SELECT id FROM orders;\nDROP TABLE orders;',
    'SELECT id FROM orders ;; UPDATE orders SET status = 1 ;',
  ])('%j is rejected with SECURITY_VALIDATION_FAILED', async (response) => {
    const { gen } = generatorFor(response);
    const error = await rejection(gen.generateQuery('show my orders'));
    expect(error.code).toBe('SECURITY_VALIDATION_FAILED');
    expect(error.message).toContain('Multiple statements detected');
  });

  it('is rejected even when every operation is allowed', async () => {
    const { gen } = generatorFor('SELECT id FROM orders; DELETE FROM orders; -- done', {
      security: { allowedOperations: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'], requireUserContext: false },
    });
    expect((await rejection(gen.generateQuery('x'))).code).toBe('SECURITY_VALIDATION_FAILED');
  });
});

describe('statements hidden by comments and string tricks', () => {
  it.each([
    'SELECT id FROM orders -- just a note\n; DELETE FROM orders',
    'SELECT id FROM orders /* ; */ ; DROP TABLE orders',
    "SELECT id FROM orders WHERE note = 'a\\'; DELETE FROM orders; -- '",
  ])('postgres: %j', async (response) => {
    const { gen } = generatorFor(response);
    expect((await rejection(gen.generateQuery('x'))).code).toBe('SECURITY_VALIDATION_FAILED');
  });

  it.each([
    'SELECT id FROM orders /*!50000 ; DELETE FROM orders */',
    'SELECT id FROM orders /*M! ; DELETE FROM orders */',
    "SELECT id FROM orders WHERE note = 'a\\' OR 1=1 -- '",
    "SELECT id FROM orders WHERE note = 'x\\'; DELETE FROM orders; -- '",
  ])('mysql: %j', async (response) => {
    const { gen } = generatorFor(response, { database: schema('mysql') });
    expect((await rejection(gen.generateQuery('x'))).code).toBe('SECURITY_VALIDATION_FAILED');
  });

  it('a comment that only hides text is removed, and the rest is validated', async () => {
    const { gen } = generatorFor("SELECT id, created_at FROM orders WHERE note = 'a--b' -- the note column\nLIMIT 5");
    const result = await gen.generateQuery('x');
    expect(result.query).toBe("SELECT id, created_at FROM orders WHERE note = 'a--b' LIMIT 5");
  });
});

describe('row-level security', () => {
  it('parenthesizes an OR before adding the user filter (the 0.0.1 leak)', async () => {
    const { gen } = generatorFor("SELECT * FROM orders WHERE status = 'paid' OR status = 'refunded'", {
      database: schema('sqlite'),
      security: { allowedOperations: ['SELECT'], enableRowLevelSecurity: true },
    });
    const result = await gen.generateQuery('paid or refunded orders', user);
    expect(result.query).toContain("WHERE (status = 'paid' OR status = 'refunded') AND user_id = 1");

    // And the database returns only this user's rows
    let sqlite3: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      sqlite3 = require('sqlite3');
    } catch {
      return;
    }
    const db = new sqlite3.Database(':memory:');
    const all = (sql: string): Promise<any[]> =>
      new Promise((resolve, reject) => db.all(sql, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows))));
    try {
      await all('CREATE TABLE orders (id INTEGER, user_id INTEGER, status TEXT, total REAL, note TEXT, created_at TEXT)');
      await all("INSERT INTO orders VALUES (1, 1, 'paid', 1, '', ''), (2, 2, 'paid', 1, '', ''), (3, 2, 'refunded', 1, '', '')");
      const rows = await all(result.query);
      expect(rows.map((r) => r.user_id)).toEqual([1]);
    } finally {
      await new Promise<void>((resolve) => db.close(() => resolve()));
    }
  });

  it('a WHERE that already names another user still gets the real filter', async () => {
    const { gen } = generatorFor('SELECT * FROM orders WHERE user_id = 2', {
      security: { allowedOperations: ['SELECT'], enableRowLevelSecurity: true },
    });
    expect((await gen.generateQuery('x', user)).query).toContain('WHERE user_id = 2 AND user_id = 1');
  });
});

describe('row limit', () => {
  const security = { allowedOperations: ['SELECT' as const], requireUserContext: false, maxRowLimit: 100 };

  it('adds a LIMIT when there is none', async () => {
    const { gen } = generatorFor('SELECT * FROM orders', { security });
    expect((await gen.generateQuery('x')).query).toBe('SELECT * FROM orders LIMIT 100');
  });

  it('never returns a query with a larger top-level limit', async () => {
    for (const response of ['SELECT * FROM orders LIMIT 5000', 'SELECT * FROM orders FETCH FIRST 5000 ROWS ONLY']) {
      const { gen } = generatorFor(response, { security });
      let query: string | undefined;
      try {
        query = (await gen.generateQuery('x')).query;
      } catch (error) {
        // Either the limit is lowered, or the query is rejected for exceeding it
        expect(error).toBeInstanceOf(TextToQueryError);
        expect((error as TextToQueryError).code).toBe('SECURITY_VALIDATION_FAILED');
        expect((error as Error).message).toContain('exceeds maximum allowed limit of 100');
        continue;
      }
      expect(query).toMatch(/\b(LIMIT|FIRST) 100\b/);
      expect(query).not.toContain('5000');
    }
  });

  it('ignores a LIMIT inside a subquery', async () => {
    const { gen } = generatorFor('SELECT * FROM orders WHERE id IN (SELECT id FROM orders LIMIT 5)', { security });
    expect((await gen.generateQuery('x')).query).toBe('SELECT * FROM orders WHERE id IN (SELECT id FROM orders LIMIT 5) LIMIT 100');
  });
});

describe('no false positives on ordinary names', () => {
  it('accepts created_at, notes about DROP and keyword-like strings', async () => {
    const response = "SELECT id, created_at FROM orders WHERE note <> 'DROP TABLE orders; --' AND status = 'created' LIMIT 10";
    const { gen } = generatorFor(response);
    const result = await gen.generateQuery('x');
    expect(result.query).toBe(response);
    expect(result.metadata?.operation).toBe('SELECT');
  });
});
