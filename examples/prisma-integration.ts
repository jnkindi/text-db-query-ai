/**
 * Prisma Integration Example
 *
 * This example shows how to use text-db-query-ai with Prisma ORM
 *
 * Before running this example:
 * 1. Create a prisma/schema.prisma file
 * 2. Run: npx prisma generate
 * 3. Run: npx prisma db push
 */

import { createChatbotFromPrisma } from '../src';

// This is a mock example - in a real application, import your Prisma client
// import { PrismaClient } from '@prisma/client';

/**
 * Example Prisma Schema (prisma/schema.prisma):
 *
 * datasource db {
 *   provider = "postgresql"
 *   url      = env("DATABASE_URL")
 * }
 *
 * generator client {
 *   provider = "prisma-client-js"
 * }
 *
 * model User {
 *   id        Int      @id @default(autoincrement())
 *   email     String   @unique
 *   name      String
 *   password  String   // Sensitive
 *   role      String   @default("user")
 *   orders    Order[]
 *   createdAt DateTime @default(now())
 * }
 *
 * model Order {
 *   id        Int      @id @default(autoincrement())
 *   userId    Int
 *   user      User     @relation(fields: [userId], references: [id])
 *   total     Decimal
 *   status    String   @default("pending")
 *   createdAt DateTime @default(now())
 * }
 */

async function exampleWithPrisma() {
  console.log('Prisma Integration Example\n');
  console.log('='.repeat(60));

  // In a real application:
  // const prisma = new PrismaClient();

  // For this example, we'll show the setup code
  console.log(`
// 1. Initialize Prisma Client
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// 2. Create chatbot from Prisma (automatic schema extraction)
const chatbot = await createChatbotFromPrisma(
  prisma,
  'postgres', // or 'mysql', 'sqlite', 'mssql'
  {
    llmProvider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    security: {
      allowedOperations: ['SELECT'],
      maxRowLimit: 100,
      enableRowLevelSecurity: true,
    },
  },
  {
    // Schema extraction options
    markSensitiveColumns: ['password', 'hash', 'secret', 'token'],
    excludeTables: ['_prisma_migrations'], // Exclude internal tables
  }
);

console.log('✓ Chatbot created from Prisma schema');

// 3. Use the chatbot
const result = await chatbot.ask('Show all users', {
  userId: 1,
  role: 'admin',
});

console.log('Query:', result.query);
console.log('Results:', result.results);

// 4. Query with explanation
const explainedResult = await chatbot.askWithExplanation(
  'Find my recent orders',
  { userId: 123, role: 'user' }
);

console.log('Explanation:', explainedResult.explanation);

// 5. Complex queries work automatically
const complexResult = await chatbot.ask(
  'Show users who have placed more than 5 orders',
  { userId: 1, role: 'admin' }
);
  `);

  console.log('\n' + '='.repeat(60));
  console.log('Alternative: Manual Schema Creation');
  console.log('='.repeat(60));

  console.log(`
// If you prefer to define schema manually for more control:
import { createQueryGenerator, DatabaseSchema } from 'text-db-query-ai';

const schema: DatabaseSchema = {
  databaseType: 'postgres',
  tables: [
    {
      name: 'User',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'email', type: 'varchar' },
        { name: 'name', type: 'varchar' },
        { name: 'password', type: 'varchar', sensitive: true },
        { name: 'role', type: 'varchar' },
      ],
      primaryKey: 'id',
    },
    {
      name: 'Order',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'userId', type: 'integer' },
        { name: 'total', type: 'decimal' },
        { name: 'status', type: 'varchar' },
      ],
      primaryKey: 'id',
      foreignKeys: [
        { column: 'userId', referencedTable: 'User', referencedColumn: 'id' },
      ],
    },
  ],
};

const generator = createQueryGenerator({
  llm: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
  },
  database: schema,
  security: {
    allowedOperations: ['SELECT'],
    maxRowLimit: 100,
  },
});
  `);

  console.log('\n' + '='.repeat(60));
  console.log('Benefits of Prisma Integration:');
  console.log('='.repeat(60));
  console.log(`
✓ Automatic schema extraction from Prisma models
✓ Type safety with Prisma Client
✓ Relationship detection (foreign keys)
✓ Automatic query execution via Prisma
✓ Works with all Prisma-supported databases
✓ No manual schema definition needed
✓ Keeps schema in sync with your database
  `);

  console.log('\n' + '='.repeat(60));
  console.log('Complete Example:');
  console.log('='.repeat(60));

  console.log(`
import { PrismaClient } from '@prisma/client';
import { createChatbotFromPrisma } from 'text-db-query-ai';

const prisma = new PrismaClient();

// Create chatbot
const chatbot = await createChatbotFromPrisma(prisma, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  security: {
    allowedOperations: ['SELECT'],
    maxRowLimit: 50,
    enableRowLevelSecurity: true,
  },
});

// Express.js endpoint
app.post('/api/chat', async (req, res) => {
  const { question, userId } = req.body;

  try {
    const result = await chatbot.ask(question, {
      userId,
      role: req.user.role,
    });

    res.json({
      success: true,
      query: result.query,
      data: result.results,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Discord bot
client.on('messageCreate', async (message) => {
  if (message.content.startsWith('!ask ')) {
    const question = message.content.slice(5);

    try {
      const result = await chatbot.ask(question, {
        userId: message.author.id,
        role: 'user',
      });

      message.reply(\`\${result.results.length} results found!\`);
    } catch (error) {
      message.reply('Error: ' + error.message);
    }
  }
});
  `);
}

// Run example
exampleWithPrisma().catch(console.error);

export { exampleWithPrisma };
