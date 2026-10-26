/**
 * Basic Usage Example
 *
 * A query generator with a hand-written schema. It generates SQL and shows
 * the result; it does not execute anything.
 *
 * Run: OPENAI_API_KEY=... npx ts-node basic-usage.ts
 */

import { createQueryGenerator, TextToQueryError } from '../src';

async function main() {
  // 1. Create a query generator with your configuration
  const generator = createQueryGenerator({
    // LLM configuration. The model defaults to 'gpt-6-luna' for OpenAI and
    // 'claude-opus-5-5' for Claude; pin it in production with `model`.
    llm: {
      provider: 'openai', // or 'claude' with ANTHROPIC_API_KEY
      apiKey: process.env.OPENAI_API_KEY || 'your-api-key-here',
    },

    // Database schema
    database: {
      databaseType: 'postgres',
      tables: [
        {
          name: 'users',
          description: 'User accounts',
          columns: [
            { name: 'id', type: 'integer', description: 'User ID' },
            { name: 'email', type: 'varchar', nullable: false },
            { name: 'name', type: 'varchar' },
            { name: 'role', type: 'varchar', enumValues: ['admin', 'user'] },
            { name: 'created_at', type: 'timestamp' },
          ],
          primaryKey: 'id',
        },
        {
          name: 'products',
          description: 'Available products',
          columns: [
            { name: 'id', type: 'integer' },
            { name: 'name', type: 'varchar' },
            { name: 'price', type: 'decimal' },
            { name: 'category', type: 'varchar' },
            { name: 'stock', type: 'integer' },
          ],
          primaryKey: 'id',
        },
        {
          name: 'orders',
          description: 'Customer orders',
          columns: [
            { name: 'id', type: 'integer' },
            { name: 'user_id', type: 'integer' },
            { name: 'product_id', type: 'integer' },
            { name: 'quantity', type: 'integer' },
            { name: 'total', type: 'decimal' },
            { name: 'status', type: 'varchar', enumValues: ['pending', 'paid', 'shipped', 'cancelled'] },
            { name: 'created_at', type: 'timestamp' },
          ],
          primaryKey: 'id',
          foreignKeys: [
            { column: 'user_id', referencedTable: 'users', referencedColumn: 'id' },
            { column: 'product_id', referencedTable: 'products', referencedColumn: 'id' },
          ],
        },
      ],
    },

    // Security configuration
    security: {
      allowedOperations: ['SELECT'], // read-only
      maxRowLimit: 100, // adds or lowers the LIMIT of every SELECT
    },

    // Debug logging (API keys are never logged)
    debug: true,
  });

  // 2. Validate the API key (lists models; uses no tokens)
  console.log('Validating API key...');
  const isValid = await generator.validateApiKey();
  if (!isValid) {
    console.error('Invalid API key!');
    return;
  }
  console.log('API key is valid\n');

  // 3. Generate queries from natural language. Every request needs a user
  //    context unless security.requireUserContext is false.
  const user = { userId: 123, role: 'user' };
  const questions = [
    'Show me all users',
    'Find products with price less than 50',
    'What are the most popular products?',
    'Count total orders by status',
  ];

  for (const question of questions) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Question: ${question}`);
    console.log('='.repeat(60));

    try {
      const result = await generator.generateQuery(question, user);

      console.log('\nGenerated query:');
      console.log(result.query);

      if (result.warnings && result.warnings.length > 0) {
        console.log('\nWarnings:');
        result.warnings.forEach((w) => console.log(`  - ${w}`));
      }

      console.log('\nMetadata:');
      console.log(`  Operation:  ${result.metadata?.operation}`);
      console.log(`  Tables:     ${result.metadata?.tables.join(', ')}`);
      console.log(`  Complexity: ${result.metadata?.estimatedComplexity}`);
      console.log(`  Model calls: ${result.metadata?.attempts}`);
    } catch (error) {
      if (error instanceof TextToQueryError) {
        console.error(`\nError (${error.code}): ${error.message}`);
      } else {
        throw error;
      }
    }
  }

  // 4. Generate a query with a plain-language explanation (one more model call)
  console.log(`\n\n${'='.repeat(60)}`);
  console.log('QUERY WITH EXPLANATION');
  console.log('='.repeat(60));

  const withExplanation = await generator.generateQueryWithExplanation(
    'Show me the top 5 users with the most orders',
    { userId: 123, role: 'admin' }
  );

  console.log('\nQuery:');
  console.log(withExplanation.query);
  console.log('\nExplanation:');
  console.log(withExplanation.explanation);
}

main().catch(console.error);
