/**
 * Generator pipeline review fixes: correction feedback never offers a
 * restricted or sensitive column (GEN-1) or a table the model may not query,
 * the best candidate is returned (FB-1), "SQL:" labels and unknown tables
 * (FB-2), explanations keep their prose (COMPAT-13), duck-typed 0.0.1
 * providers (COMPAT-8) and an explicit `maxRowLimit: undefined` (COMPAT-11).
 * (src/generator/query-generator.ts, src/generator/identifier-check.ts)
 */

import { QueryGenerator } from '../../src/generator/query-generator';
import { IdentifierChecker } from '../../src/generator/identifier-check';
import { BaseLLMProvider } from '../../src/providers/base';
import { DatabaseSchema, SecurityConfig, TextToQueryConfig } from '../../src/types';
import { ScriptedAnswer, ScriptedProvider } from './scripted-provider';

const API_KEY = 'sk-regression-test';

const USERS: DatabaseSchema = {
  databaseType: 'postgres',
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'email', type: 'varchar' },
        { name: 'password_hash', type: 'varchar', sensitive: true },
        { name: 'ssn', type: 'varchar', sensitive: true },
      ],
    },
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'user_id', type: 'integer' },
        { name: 'total', type: 'numeric' },
        { name: 'card_token', type: 'varchar' },
      ],
    },
    {
      name: 'audit_log',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'user_id', type: 'integer' },
        { name: 'note', type: 'text' },
      ],
    },
  ],
};

function makeGenerator(answers: ScriptedAnswer[], overrides: Partial<TextToQueryConfig> = {}, security: SecurityConfig = {}) {
  const provider = new ScriptedProvider(answers);
  const generator = new QueryGenerator({
    llm: { provider: 'openai', apiKey: API_KEY },
    database: USERS,
    security: { requireUserContext: false, ...security },
    llmProvider: provider,
    ...overrides,
  });
  return { generator, provider };
}

describe('GEN-1: correction feedback never offers restricted or sensitive columns', () => {
  it('leaves sensitive columns out of the suggestions and the column list', async () => {
    const { generator, provider } = makeGenerator(['SELECT id, email, password FROM users', 'SELECT id, email FROM users']);
    const result = await generator.generateQuery('list the users');

    expect(provider.calls).toHaveLength(2);
    const feedback = provider.calls[1].prompt;
    expect(feedback).toContain('- Unknown column password: no table in the query (users) has it\n');
    expect(feedback).toContain('Columns of the tables involved:\n- users: id, email\n');
    expect(feedback).not.toMatch(/password_hash|\bssn\b/);
    expect(result.query).toBe('SELECT id, email FROM users');
  });

  it('leaves restricted columns out, matched like the validator (contains, table.column)', async () => {
    const contains = makeGenerator(['SELECT o.card FROM orders o', 'SELECT o.id FROM orders o'], {}, { restrictedColumns: ['card'] });
    await contains.generator.generateQuery('cards');
    const feedback = contains.provider.calls[1].prompt;
    expect(feedback).toContain('- Unknown column o.card in table orders\n');
    expect(feedback).toContain('- orders: id, user_id, total\n');
    expect(feedback).not.toContain('card_token');

    const scoped = makeGenerator(['SELECT a.notes FROM audit_log a', 'SELECT a.id FROM audit_log a'], {}, { restrictedColumns: ['audit_log.note'] });
    await scoped.generator.generateQuery('notes');
    expect(scoped.provider.calls[1].prompt).toContain('- Unknown column a.notes in table audit_log\n');
    expect(scoped.provider.calls[1].prompt).toContain('- audit_log: id, user_id\n');
  });

  it('does not point at another table through a hidden column ("it exists in")', async () => {
    const { generator, provider } = makeGenerator(['SELECT ssn FROM orders', 'SELECT id FROM orders']);
    await generator.generateQuery('q');
    expect(provider.calls[1].prompt).toContain('- Unknown column ssn: no table in the query (orders) has it\n');
  });

  it('does not ask to quote a hidden column the model wrote with the wrong case', async () => {
    const exact: DatabaseSchema = {
      databaseType: 'postgres',
      exactNames: true,
      tables: [{ name: 'people', columns: [{ name: 'id', type: 'integer' }, { name: 'SSN', type: 'text', sensitive: true }] }],
    };
    const { generator, provider } = makeGenerator(['SELECT SSN FROM people', 'SELECT id FROM people'], { database: exact });
    await generator.generateQuery('q');
    const feedback = provider.calls[1].prompt;
    expect(feedback).toContain('- Unknown column SSN: no table in the query (people) has it\n');
    expect(feedback).not.toContain('"SSN"');
  });

  it('keeps offering ordinary columns', async () => {
    const { generator, provider } = makeGenerator(['SELECT o.totl FROM orders o', 'SELECT o.total FROM orders o']);
    await generator.generateQuery('totals');
    expect(provider.calls[1].prompt).toContain('- Unknown column o.totl in table orders; did you mean total?');
  });
});

describe('IdentifierChecker options', () => {
  const checker = new IdentifierChecker(USERS, 'postgres', {
    hideColumn: (column) => column.sensitive === true,
    hideTable: (table) => table.name === 'audit_log',
  });

  it('hides columns and tables from suggestions only; references to them are still checked', () => {
    expect(checker.check('SELECT password_hash FROM users')).toEqual([]);
    expect(checker.check('SELECT u.passwordhash FROM users u')[0].suggestions).toBeUndefined();
    expect(checker.check('SELECT 1 FROM audit_logs')[0]).toMatchObject({ kind: 'unknown_table', suggestions: undefined });
    expect(checker.check('SELECT 1 FROM audit_log')).toEqual([]);
    expect(checker.check('SELECT note FROM orders')[0].message).toBe('Unknown column note: no table in the query (orders) has it');
  });

  it('never suggests a column of a hidden table, even when the query names that table', () => {
    // The model guessed the hidden table; its columns must not be revealed through suggestions
    const [issue] = checker.check('SELECT a.notes FROM audit_log a');
    expect(issue).toMatchObject({ kind: 'unknown_column', suggestions: undefined });
    expect(issue.message).not.toMatch(/did you mean/);
    const exact = new IdentifierChecker({ ...USERS, exactNames: true }, 'postgres', { hideTable: (table) => table.name === 'audit_log' });
    // A wrongly cased column of a hidden table is not offered as the quoting fix either
    expect(JSON.stringify(exact.check('SELECT a."Note" FROM audit_log a'))).not.toContain('"note"');
  });

  it('suggests everything without options', () => {
    const plain = new IdentifierChecker(USERS, 'postgres');
    expect(plain.check('SELECT u.passwordhash FROM users u')[0].suggestions).toEqual(['password_hash']);
    expect(plain.check('SELECT 1 FROM audit_logs')[0].suggestions).toEqual(['audit_log']);
  });
});

describe('PROMPT-1 in feedback: tables the model may not query are not offered', () => {
  const security: SecurityConfig = { allowedTables: ['orders', 'users'] };

  it('does not suggest a disallowed table, and lists only allowed ones', async () => {
    const { generator, provider } = makeGenerator(['SELECT id FROM audit_logs', 'SELECT id FROM orders'], {}, security);
    await generator.generateQuery('q');
    const feedback = provider.calls[1].prompt;
    expect(feedback).toContain('- Unknown table audit_logs\n');
    expect(feedback).toContain('Tables in the schema: users, orders\n');
    expect(feedback).not.toContain('audit_log,');
    expect(provider.calls[0].system).not.toContain('TABLE audit_log');
  });
});

describe('FB-1: the candidate with the fewest identifier issues is returned', () => {
  const ONE = 'SELECT o.amount FROM orders o';
  const THREE = 'SELECT o.amount, o.price, u.fullname FROM orders o JOIN users u ON u.id = o.user_id';

  it('discards a correction with more issues, with a warning', async () => {
    const { generator, provider } = makeGenerator([ONE, THREE]);
    const result = await generator.generateQuery('amounts');
    expect(provider.calls).toHaveLength(2);
    expect(result.query).toBe(ONE);
    expect(result.metadata).toMatchObject({ attempts: 2, unknownIdentifiers: ['orders.amount'] });
    expect(result.warnings).toContain('A corrected query referenced more unknown identifiers than an earlier answer, so the earlier answer is returned');
  });

  it('keeps the latest of equally good candidates, without the warning', async () => {
    const OTHER = 'SELECT o.price FROM orders o';
    const { generator } = makeGenerator([ONE, OTHER]);
    const result = await generator.generateQuery('amounts');
    expect(result.query).toBe(OTHER);
    expect(result.warnings ?? []).not.toContainEqual(expect.stringContaining('earlier answer is returned'));
  });

  it('picks the best of several corrections', async () => {
    const TWO = 'SELECT o.amount, o.price FROM orders o';
    const { generator } = makeGenerator([THREE, ONE, TWO], { maxCorrectionAttempts: 2 });
    const result = await generator.generateQuery('amounts');
    expect(result.query).toBe(ONE);
    expect(result.metadata?.attempts).toBe(3);
  });

  it('falls back only to earlier candidates when the chosen one fails validation', async () => {
    const security: SecurityConfig = { restrictedColumns: ['price'] };
    const PRICE = 'SELECT o.price FROM orders o';

    // ONE and PRICE tie (one issue each), so PRICE is chosen; it reads a restricted
    // column, so the answer it corrected is returned, as without the correction.
    const tie = makeGenerator([ONE, PRICE], {}, security);
    const result = await tie.generator.generateQuery('q');
    expect(result.query).toBe(ONE);
    expect(result.warnings).toContain('The corrected query failed security validation, so the original answer is returned');

    // THREE (3 issues) -> PRICE (1, chosen, rejected) -> TWO (2). The only earlier
    // candidate, THREE, reads o.price too, so the request fails as it would have
    // without corrections; the later TWO is not used.
    const TWO = 'SELECT o.amount, o.amount2 FROM orders o';
    const later = makeGenerator([THREE, PRICE, TWO], { maxCorrectionAttempts: 2 }, security);
    await expect(later.generator.generateQuery('q')).rejects.toMatchObject({ code: 'SECURITY_VALIDATION_FAILED' });
  });

  it('strict mode still throws when the best candidate has issues', async () => {
    const { generator } = makeGenerator([ONE, THREE], { identifierCheck: 'strict' });
    await expect(generator.generateQuery('q')).rejects.toMatchObject({ code: 'UNKNOWN_IDENTIFIERS', details: { query: ONE } });
  });
});

describe('FB-2: answer labels and unknown tables', () => {
  it.each([
    'SQL: SELECT id FROM orders',
    'sql:SELECT id FROM orders',
    'SQL:\nSELECT id FROM orders',
    '```sql\nSQL: SELECT id FROM orders\n```',
  ])('strips a leading "SQL:" label: %j', async (answer) => {
    const { generator, provider } = makeGenerator([answer]);
    const result = await generator.generateQuery('ids');
    expect(result.query).toBe('SELECT id FROM orders');
    expect(provider.calls).toHaveLength(1);
  });

  it('still reads CANNOT_ANSWER after a label', async () => {
    const { generator } = makeGenerator(['SQL: CANNOT_ANSWER: no refunds table']);
    await expect(generator.generateQuery('refunds')).rejects.toMatchObject({ details: { cannotAnswer: true, reason: 'no refunds table' } });
  });

  it('lists the schema tables (at most 20) for an unknown table with no close match', async () => {
    const { generator, provider } = makeGenerator(['SELECT sku FROM inventory', 'SELECT id FROM orders']);
    await generator.generateQuery('stock');
    expect(provider.calls[1].prompt).toContain('- Unknown table inventory\nTables in the schema: users, orders, audit_log\n');

    const many: DatabaseSchema = {
      databaseType: 'postgres',
      tables: Array.from({ length: 25 }, (_, i) => ({ name: `table_${String(i).padStart(2, '0')}`, columns: [{ name: 'id', type: 'integer' }] })),
    };
    const big = makeGenerator(['SELECT sku FROM inventory', 'SELECT id FROM table_00'], { database: many });
    await big.generator.generateQuery('stock');
    const line = big.provider.calls[1].prompt.split('\n').find((l) => l.startsWith('Tables in the schema:'))!;
    expect(line).toContain('table_00, table_01');
    expect(line).toContain('table_19, ... (5 more)');
    expect(line).not.toContain('table_20');
  });

  it('does not list the tables when the unknown table has a close match', async () => {
    const { generator, provider } = makeGenerator(['SELECT id FROM ordrs', 'SELECT id FROM orders']);
    await generator.generateQuery('q');
    expect(provider.calls[1].prompt).not.toContain('Tables in the schema');
  });
});

describe('COMPAT-13: explanations with fenced blocks', () => {
  const SQL = 'SELECT id FROM orders LIMIT 10';

  async function explain(explanation: string): Promise<string | undefined> {
    const { generator } = makeGenerator([SQL, explanation]);
    return (await generator.generateQueryWithExplanation('orders')).explanation;
  }

  it('keeps the prose around a ```json block', async () => {
    const text = 'It returns one row per status, for example:\n```json\n{"status": "paid", "count": 3}\n```\nRows are sorted by count.';
    expect(await explain(text)).toBe(text);
  });

  it('keeps the prose around an inline fence and a ```sql block', async () => {
    const inline = 'The query uses ```COUNT(*)``` to count orders per status.';
    expect(await explain(inline)).toBe(inline);
    const sql = 'It lists ids:\n```sql\nSELECT id FROM orders\n```\nAt most ten.';
    expect(await explain(sql)).toBe(sql);
  });

  it('strips one fence that wraps the whole answer', async () => {
    expect(await explain('```\nIt lists the ids of all orders.\n```')).toBe('It lists the ids of all orders.');
    expect(await explain('  ```text\nIt lists\nthe ids.\n```\n')).toBe('It lists\nthe ids.');
    expect(await explain('```\nOne\n```\nand\n```\nTwo\n```')).toBe('```\nOne\n```\nand\n```\nTwo\n```');
  });

  it('returns plain text as it is', async () => {
    expect(await explain('sql\nIt lists the ids.')).toBe('sql\nIt lists the ids.');
  });
});

describe('COMPAT-8: a duck-typed provider without generateWithSystem()', () => {
  it('joins the system prompt and the message and calls generate(), as BaseLLMProvider does', async () => {
    const prompts: string[] = [];
    const generator = new QueryGenerator({
      llm: { provider: 'openai', apiKey: API_KEY },
      database: USERS,
      security: { requireUserContext: false },
    });
    // The only injection point 0.0.1 had: assigning the private field.
    (generator as any).llmProvider = {
      generate: async (prompt: string) => {
        prompts.push(prompt);
        return prompts.length === 1 ? 'SELECT id FROM orders' : 'It lists the order ids.';
      },
      validateApiKey: async () => true,
      getDefaultModel: () => 'local',
    };
    const result = await generator.generateQueryWithExplanation('ids');
    expect(result.query).toBe('SELECT id FROM orders');
    expect(result.explanation).toBe('It lists the order ids.');
    expect(prompts[0]).toMatch(/^You write PostgreSQL queries[\s\S]*\n\n<question>\nids\n<\/question>/);
    expect(prompts[1].startsWith('You explain SQL queries')).toBe(true);
    await expect(generator.validateApiKey()).resolves.toBe(true);
  });

  it('still prefers generateWithSystem() when there is one', async () => {
    class Both extends BaseLLMProvider {
      calls: string[] = [];
      async generate(): Promise<string> {
        this.calls.push('generate');
        return 'SELECT id FROM orders';
      }
      async generateWithSystem(): Promise<string> {
        this.calls.push('generateWithSystem');
        return 'SELECT id FROM orders';
      }
      async validateApiKey(): Promise<boolean> {
        return true;
      }
      getDefaultModel(): string {
        return 'both';
      }
    }
    const provider = new Both({ provider: 'openai', apiKey: API_KEY });
    const { generator } = makeGenerator([], { llmProvider: provider });
    await generator.generateQuery('ids');
    expect(provider.calls).toEqual(['generateWithSystem']);
  });
});

describe('COMPAT-11: the row limit follows the validator maximum', () => {
  const SQL = 'SELECT id, total FROM orders ORDER BY total DESC LIMIT 5000';
  const run = async (security: SecurityConfig) => {
    const { generator } = makeGenerator([SQL], {}, security);
    return (await generator.generateQuery('biggest orders')).query;
  };

  it('keeps a limit the validator accepts when maxRowLimit is explicitly undefined', async () => {
    expect(await run({ maxRowLimit: undefined })).toBe(SQL);
  });

  it('still lowers it to the 1000 default when maxRowLimit is absent, and to maxRowLimit when set', async () => {
    expect(await run({})).toBe(SQL.replace('5000', '1000'));
    expect(await run({ maxRowLimit: 200 })).toBe(SQL.replace('5000', '200'));
  });
});
