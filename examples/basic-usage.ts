/**
 * Basic Usage Example
 *
 * This example demonstrates the basic setup and usage of text-db-query-ai
 */

import { createQueryGenerator } from '../src';

async function main() {
  // 1. Create a query generator with your configuration
  const generator = createQueryGenerator({
    // LLM Configuration
    llm: {
      provider: 'openai', // or 'claude'
      apiKey: process.env.OPENAI_API_KEY || 'your-api-key-here',
      model: 'gpt-4o-mini', // optional
      temperature: 0.1, // optional
    },

    // Database Schema
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
            { name: 'role', type: 'varchar', description: 'User role (admin, user)' },
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
            { name: 'status', type: 'varchar' },
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

    // Security Configuration
    security: {
      allowedOperations: ['SELECT'], // Only allow read operations
      maxRowLimit: 100, // Limit results to 100 rows
      enableRowLevelSecurity: true, // Filter results by user_id
    },

    // Debug mode
    debug: true,
  });

  // 2. Validate API key
  console.log('Validating API key...');
  const isValid = await generator.validateApiKey();
  if (!isValid) {
    console.error('Invalid API key!');
    return;
  }
  console.log('API key is valid ✓\n');

  // 3. Generate queries from natural language
  const examples = [
    'Show me all users',
    'Find products with price less than 50',
    'Show my last 5 orders',
    'What are the most popular products?',
    'Count total orders by status',
  ];

  for (const example of examples) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Question: ${example}`);
    console.log('='.repeat(60));

    try {
      // Generate query with user context
      const result = await generator.generateQuery(example, {
        userId: 123,
        role: 'user',
      });

      console.log('\nGenerated Query:');
      console.log(result.query);

      if (result.warnings && result.warnings.length > 0) {
        console.log('\nWarnings:');
        result.warnings.forEach((w) => console.log(`  - ${w}`));
      }

      console.log('\nMetadata:');
      console.log(`  Operation: ${result.metadata?.operation}`);
      console.log(`  Tables: ${result.metadata?.tables.join(', ')}`);
      console.log(`  Complexity: ${result.metadata?.estimatedComplexity}`);
    } catch (error: any) {
      console.error('\nError:', error.message);
    }
  }

  // 4. Generate query with explanation
  console.log(`\n\n${'='.repeat(60)}`);
  console.log('QUERY WITH EXPLANATION');
  console.log('='.repeat(60));

  const resultWithExplanation = await generator.generateQueryWithExplanation(
    'Show me the top 5 users with the most orders',
    { userId: 123, role: 'admin' }
  );

  console.log('\nQuery:');
  console.log(resultWithExplanation.query);
  console.log('\nExplanation:');
  console.log(resultWithExplanation.explanation);
}

// Run the example
main().catch(console.error);
