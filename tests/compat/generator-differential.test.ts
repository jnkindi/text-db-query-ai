/**
 * Differential tests against the published 0.0.1 build (`text-db-query-ai-legacy`):
 * the schema text, getSchema(), the example queries and, for simple queries,
 * the whole generateQuery() result (query, explanation and metadata).
 *
 * The 0.0.1 generator is driven by replacing its provider's generate(), as its
 * users did in tests; the current one gets a scripted provider. No LLM is called.
 */

import { QueryGenerator } from '../../src/generator';
import { SchemaAnalyzer } from '../../src/schema';
import { DatabaseSchema, SecurityConfig, UserContext } from '../../src/types';
import { ScriptedProvider } from '../generator/scripted-provider';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('text-db-query-ai-legacy');

const API_KEY = 'sk-test-not-a-real-key';
const collapse = (s: string) => s.replace(/\s+/g, ' ');

/** The "Manual Schema Definition" example from the 0.0.1 README. */
const README_SCHEMA: DatabaseSchema = {
  databaseType: 'postgres',
  tables: [
    {
      name: 'users',
      description: 'User accounts',
      columns: [
        { name: 'id', type: 'integer', description: 'User ID' },
        { name: 'email', type: 'varchar', nullable: false },
        { name: 'name', type: 'varchar' },
        { name: 'created_at', type: 'timestamp' },
      ],
      primaryKey: 'id',
    },
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'user_id', type: 'integer' },
        { name: 'total', type: 'decimal' },
        { name: 'status', type: 'varchar' },
      ],
      foreignKeys: [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }],
    },
  ],
};

/** Every field 0.0.1 knew, including sensitive columns and nullable variants. */
const FULL_LEGACY_SCHEMA: DatabaseSchema = {
  databaseType: 'mysql',
  tables: [
    {
      name: 'accounts',
      description: 'Customer accounts',
      columns: [
        { name: 'id', type: 'integer', nullable: false, description: 'Primary id' },
        { name: 'password', type: 'varchar', sensitive: true },
        { name: 'ssn', type: 'varchar', sensitive: true, nullable: true, description: 'Tax id' },
        { name: 'nickname', type: 'varchar', nullable: true },
      ],
      primaryKey: 'id',
    },
    {
      name: 'line_items',
      columns: [
        { name: 'account_id', type: 'integer' },
        { name: 'sku', type: 'varchar' },
      ],
      primaryKey: 'account_id, sku',
      foreignKeys: [
        { column: 'account_id', referencedTable: 'accounts', referencedColumn: 'id' },
        { column: 'sku', referencedTable: 'products', referencedColumn: 'sku' },
      ],
    },
    { name: 'empty_table', columns: [] },
  ],
};

/** A Prisma-style schema with mixed-case names and the fields added in 0.1.0. */
const PRISMA_STYLE_SCHEMA: DatabaseSchema = {
  databaseType: 'postgres',
  tables: [
    {
      name: 'User',
      schema: 'public',
      columns: [
        { name: 'id', type: 'integer', nativeType: 'int4', nullable: false },
        { name: 'createdAt', type: 'timestamp', nativeType: 'timestamp(3)' },
        { name: 'role', type: 'varchar', nativeType: 'Role', enumValues: ['ADMIN', 'USER'] },
        { name: 'status', type: 'varchar', sampleValues: ['active'] },
      ],
      primaryKey: 'id',
      primaryKeyColumns: ['id'],
    },
    {
      name: 'Post',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'authorId', type: 'integer' },
      ],
      foreignKeys: [{ column: 'authorId', referencedTable: 'User', referencedColumn: 'id', referencedSchema: 'public' }],
    },
  ],
};

const OTHER_DIALECTS: DatabaseSchema[] = (['sqlite', 'mssql', 'mongodb'] as const).map((databaseType) => ({
  ...README_SCHEMA,
  databaseType,
}));

const SCHEMAS: Array<[string, DatabaseSchema]> = [
  ['README', README_SCHEMA],
  ['all 0.0.1 fields', FULL_LEGACY_SCHEMA],
  ['Prisma style with 0.1.0 fields', PRISMA_STYLE_SCHEMA],
  ['no tables', { databaseType: 'postgres', tables: [] }],
  ...OTHER_DIALECTS.map((s): [string, DatabaseSchema] => [`README on ${s.databaseType}`, s]),
];

describe('schema text', () => {
  it.each(SCHEMAS)('generateSchemaPrompt() is byte-identical to 0.0.1 (%s)', (_name, schema) => {
    expect(new SchemaAnalyzer(schema).generateSchemaPrompt()).toBe(new legacy.SchemaAnalyzer(schema).generateSchemaPrompt());
  });

  it.each(SCHEMAS)('QueryGenerator.getSchema() is byte-identical to 0.0.1 (%s)', (_name, schema) => {
    const config = { llm: { provider: 'openai' as const, apiKey: API_KEY }, database: schema };
    expect(new QueryGenerator(config).getSchema()).toBe(new legacy.QueryGenerator(config).getSchema());
  });

  it.each(['postgres', 'mysql', 'sqlite'] as const)('generateExampleQueries() is unchanged for plain names (%s)', (databaseType) => {
    for (const schema of [{ ...README_SCHEMA, databaseType }, { ...FULL_LEGACY_SCHEMA, databaseType }]) {
      expect(new SchemaAnalyzer(schema).generateExampleQueries()).toEqual(new legacy.SchemaAnalyzer(schema).generateExampleQueries());
    }
  });

  it('keeps the other SchemaAnalyzer methods unchanged', () => {
    for (const [, schema] of SCHEMAS) {
      const now = new SchemaAnalyzer(schema);
      const before = new legacy.SchemaAnalyzer(schema);
      expect(now.getTableNames()).toEqual(before.getTableNames());
      expect(now.getSensitiveColumns()).toEqual(before.getSensitiveColumns());
      expect(now.getDatabaseType()).toBe(before.getDatabaseType());
      expect(now.findTable('USERS')).toEqual(before.findTable('USERS'));
      expect(now.validateTables(['users', 'nope'])).toEqual(before.validateTables(['users', 'nope']));
    }
    for (const databaseType of ['postgres', 'mysql', 'mssql'] as const) {
      const schema = { databaseType, tables: [] };
      expect(new SchemaAnalyzer(schema).getDatabaseHints()).toBe(new legacy.SchemaAnalyzer(schema).getDatabaseHints());
    }
  });
});

describe('generateQuery() on simple queries', () => {
  interface Case {
    name: string;
    answer: string;
    security?: SecurityConfig;
    context?: UserContext;
  }

  const OPEN: SecurityConfig = { requireUserContext: false };
  const RLS: SecurityConfig = { enableRowLevelSecurity: true, maxRowLimit: 100 };
  const USER: UserContext = { userId: 5, role: 'user' };

  const CASES: Case[] = [
    { name: 'plain select', answer: 'SELECT id, email FROM users', security: OPEN },
    { name: 'markdown answer', answer: '```sql\nSELECT id, email\nFROM users\n```', security: OPEN },
    { name: 'trailing semicolon', answer: 'SELECT id FROM users;', security: OPEN },
    { name: 'join', answer: 'SELECT u.id, o.total FROM users u JOIN orders o ON o.user_id = u.id', security: OPEN },
    { name: 'group by', answer: 'SELECT status, COUNT(*) FROM orders GROUP BY status', security: OPEN },
    { name: 'subquery', answer: 'SELECT id FROM users WHERE id IN (SELECT user_id FROM orders)', security: OPEN },
    { name: 'limit kept', answer: 'SELECT id FROM orders ORDER BY id LIMIT 5', security: { ...OPEN, maxRowLimit: 50 } },
    { name: 'limit added', answer: 'SELECT id FROM orders', security: { ...OPEN, maxRowLimit: 50 } },
    { name: 'RLS and limit', answer: 'SELECT id, total FROM orders', security: RLS, context: USER },
    { name: 'RLS with WHERE and ORDER BY', answer: "SELECT id FROM orders WHERE status = 'paid' ORDER BY id", security: RLS, context: USER },
    { name: 'RLS with a string id', answer: 'SELECT id FROM orders', security: RLS, context: { userId: 'abc', role: 'user' } },
    { name: 'delete allowed', answer: 'DELETE FROM orders WHERE id = 3', security: { ...OPEN, allowedOperations: ['SELECT', 'DELETE'] } },
  ];

  async function legacyResult(c: Case) {
    const generator = new legacy.QueryGenerator({
      llm: { provider: 'openai', apiKey: API_KEY },
      database: README_SCHEMA,
      security: c.security,
    });
    generator.llmProvider.generate = async () => c.answer;
    return generator.generateQuery('the question', c.context);
  }

  async function currentResult(c: Case) {
    const generator = new QueryGenerator({
      llm: { provider: 'openai', apiKey: API_KEY },
      database: README_SCHEMA,
      security: c.security,
      llmProvider: new ScriptedProvider([c.answer]),
    });
    return generator.generateQuery('the question', c.context);
  }

  it.each(CASES.map((c) => [c.name, c] as const))('gives the 0.0.1 query, explanation and metadata (%s)', async (_name, c) => {
    const before = await legacyResult(c);
    const now = await currentResult(c);
    // 0.0.1 put an extra space before ORDER BY / LIMIT when adding the RLS filter
    // (see MODULO_SPACES in security-differential.test.ts); the SQL is otherwise identical.
    expect(collapse(now.query)).toBe(collapse(before.query));
    expect(now.explanation).toBe(before.explanation);
    const { attempts, unknownIdentifiers, ...metadata } = now.metadata!;
    expect(metadata).toEqual(before.metadata);
    expect(attempts).toBe(1);
    expect(unknownIdentifiers).toEqual([]);
  });

  it('fixes the 0.0.1 complexity and table bugs on names that contain keywords', async () => {
    const answer = 'SELECT id, email FROM users WHERE name = \'rejoined\'';
    const now = await currentResult({ name: 'x', answer, security: OPEN });
    const before = await legacyResult({ name: 'x', answer, security: OPEN });
    expect(before.metadata.estimatedComplexity).toBe('medium'); // 'join' inside the string
    expect(now.metadata?.estimatedComplexity).toBe('low');
    expect(now.metadata?.tables).toEqual(before.metadata.tables);
  });
});
