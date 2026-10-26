/**
 * Reducing invented tables and columns
 *
 * Models invent names when the schema they see is wrong or vague. This
 * example gives the model an exact schema with descriptions, enum values,
 * sample values, examples and domain rules, checks the generated SQL against
 * the schema (asking the model for one correction when it names something
 * that does not exist), and handles questions the schema cannot answer.
 *
 * With a live database, prefer createFromDatabase() or createFromPrisma(),
 * which read the real schema (names, native types, keys, enum values and
 * comments); see direct-database.ts and prisma-integration.ts.
 *
 * Run: ANTHROPIC_API_KEY=... npx ts-node reduce-hallucinations.ts
 * Steps 1 and 2 run without an API key.
 */

import {
  checkIdentifiers,
  createQueryGenerator,
  DatabaseSchema,
  QueryExample,
  SchemaAnalyzer,
  TextToQueryError,
} from '../src';

/**
 * A Prisma-style Postgres schema. `exactNames: true` says the names match the
 * database exactly, so the model is shown "Order" and "createdAt" with the
 * quotes Postgres needs for them.
 */
const database: DatabaseSchema = {
  databaseType: 'postgres',
  exactNames: true,
  tables: [
    {
      name: 'Customer',
      description: 'One row per paying customer',
      columns: [
        { name: 'id', type: 'integer', nativeType: 'int4' },
        { name: 'name', type: 'varchar' },
        { name: 'email', type: 'varchar', sensitive: true },
        // Sample values are sent to the LLM provider: use them for codes and labels, never for personal data
        { name: 'country', type: 'varchar', description: 'ISO 3166 alpha-2 code', sampleValues: ['US', 'DE', 'RW'] },
        { name: 'createdAt', type: 'timestamp', nativeType: 'timestamp(3)' },
      ],
      primaryKey: 'id',
    },
    {
      name: 'Order',
      description: 'One row per checkout',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'customerId', type: 'integer' },
        { name: 'status', type: 'varchar', nativeType: 'OrderStatus', enumValues: ['pending', 'paid', 'refunded'] },
        { name: 'total', type: 'integer', description: 'Amount in cents' },
        { name: 'createdAt', type: 'timestamp', nativeType: 'timestamp(3)' },
      ],
      primaryKey: 'id',
      foreignKeys: [{ column: 'customerId', referencedTable: 'Customer', referencedColumn: 'id' }],
    },
  ],
};

/** Question and SQL pairs in the house style. They must match the schema exactly. */
const examples: QueryExample[] = [
  {
    question: 'Revenue by country this year',
    sql:
      'SELECT c.country, SUM(o.total) AS revenue FROM "Order" o JOIN "Customer" c ON c.id = o."customerId" ' +
      `WHERE o.status = 'paid' AND o."createdAt" >= date_trunc('year', NOW()) GROUP BY c.country`,
  },
];

async function main() {
  // 1. What the model sees: names quoted where Postgres needs it, native types,
  //    keys, enum and sample values, descriptions and sensitive markers.
  console.log('Schema as the model sees it:\n');
  console.log(new SchemaAnalyzer(database).renderForModel());

  // 2. The same check the generator runs, on any SQL
  console.log('\nChecking a query with invented and unquoted names:');
  for (const issue of checkIdentifiers('SELECT c.id, c.full_name FROM Customer c WHERE c.createdAt > NOW()', database)) {
    console.log(`  - ${issue.message}`);
  }
  for (const example of examples) {
    const issues = checkIdentifiers(example.sql, database);
    console.log(`Example "${example.question}": ${issues.length === 0 ? 'matches the schema' : issues.map((i) => i.message).join('; ')}`);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('\nSet ANTHROPIC_API_KEY to generate queries.');
    return;
  }

  // 3. A generator that uses all of it
  const generator = createQueryGenerator({
    llm: {
      provider: 'claude',
      apiKey: process.env.ANTHROPIC_API_KEY,
      // model defaults to 'claude-opus-5-5'; the system prompt (rules and schema) is cached
    },
    database,
    security: { allowedOperations: ['SELECT'], maxRowLimit: 100, requireUserContext: false },
    examples,
    instructions: [
      'Revenue means the sum of "Order".total over paid orders. Amounts are in cents.',
      'A customer is active when they have a paid order in the last 90 days.',
    ].join('\n'),
    // 'retry' (the default) asks the model once more when the SQL names an
    // unknown table or column, and returns the query with warnings if problems
    // remain. Each correction is one more model call. 'strict' throws
    // UNKNOWN_IDENTIFIERS instead; 'warn' only warns; 'off' skips the check.
    identifierCheck: 'retry',
    maxCorrectionAttempts: 1,
  });

  const questions = [
    'Which countries brought the most revenue last month?',
    'How many active customers do we have?',
    'What is the average delivery time?', // nothing in the schema says
  ];

  for (const question of questions) {
    console.log(`\nQuestion: ${question}`);
    try {
      const result = await generator.generateQuery(question);
      console.log(result.query);
      console.log(`  model calls: ${result.metadata?.attempts}`);
      if (result.metadata?.unknownIdentifiers?.length) {
        console.log(`  still unknown: ${result.metadata.unknownIdentifiers.join(', ')}`);
      }
      for (const warning of result.warnings ?? []) console.log(`  warning: ${warning}`);
    } catch (error) {
      if (error instanceof TextToQueryError && error.code === 'INVALID_SQL_SYNTAX' && error.details?.cannotAnswer) {
        // The model answered CANNOT_ANSWER: <reason> instead of guessing
        console.log(`  not answerable from this schema: ${error.details.reason}`);
      } else if (error instanceof TextToQueryError) {
        console.log(`  ${error.code}: ${error.message}`);
      } else {
        throw error;
      }
    }
  }
}

main().catch(console.error);
