/**
 * Prisma Integration Example
 *
 * Before running this example:
 * 1. npm install @prisma/client prisma
 * 2. Create prisma/schema.prisma (see below)
 * 3. npx prisma generate && npx prisma db push
 *
 * Run: DATABASE_URL=postgres://... OPENAI_API_KEY=... npx ts-node prisma-integration.ts
 *
 * Example prisma/schema.prisma:
 *
 *   datasource db {
 *     provider = "postgresql"
 *     url      = env("DATABASE_URL")
 *   }
 *
 *   generator client {
 *     provider = "prisma-client-js"
 *   }
 *
 *   enum OrderStatus {
 *     pending
 *     paid
 *     refunded
 *   }
 *
 *   /// Registered users
 *   model User {
 *     id        Int      @id @default(autoincrement())
 *     email     String   @unique
 *     name      String
 *     password  String
 *     orders    Order[]
 *     createdAt DateTime @default(now())
 *   }
 *
 *   model Order {
 *     id        Int         @id @default(autoincrement())
 *     userId    Int
 *     user      User        @relation(fields: [userId], references: [id])
 *     total     Decimal
 *     status    OrderStatus @default(pending)
 *     createdAt DateTime    @default(now())
 *   }
 */

import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';
import {
  ChatbotHelper,
  createChatbotFromPrisma,
  createFromPrisma,
  createQueryGenerator,
  parsePrismaSchema,
  PrismaAdapter,
} from '../src';

/** Prisma returns integer aggregates such as COUNT(*) as BigInt, which JSON.stringify cannot serialize. */
function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v),
    2
  );
}

async function exampleWithPrisma() {
  const prisma = new PrismaClient();
  try {
    // 1. Chatbot from Prisma: the schema is read from the database through
    //    $queryRawUnsafe (a fixed number of catalog queries). Names keep their
    //    case, so the model is shown "User" and "createdAt" quoted.
    const chatbot = await createChatbotFromPrisma(
      prisma,
      'postgres', // or 'mysql', 'sqlite', 'mssql'
      {
        llmProvider: 'openai',
        apiKey: process.env.OPENAI_API_KEY!,
        // model defaults to 'gpt-6-luna'
        security: {
          allowedOperations: ['SELECT'],
          maxRowLimit: 100,
          restrictedColumns: ['password'],
        },
        instructions: 'Order totals are in dollars.',
      },
      {
        markSensitiveColumns: ['password', 'token', 'secret'],
        excludeTables: ['_prisma_migrations'],
      }
    );

    const result = await chatbot.ask('How many orders did each user place?', { userId: 1, role: 'admin' });
    console.log('Query:', result.query);
    console.log('Results:', toJson(result.results));

    // 2. With an explanation (one more model call)
    const explained = await chatbot.askWithExplanation('Find the 5 largest paid orders', { userId: 1, role: 'admin' });
    console.log('Explanation:', explained.explanation);

    // 3. Build the chatbot from parts to keep the generator, for example to
    //    check the API key at startup
    const generator = await createFromPrisma(prisma, 'postgres', {
      llmProvider: 'openai',
      apiKey: process.env.OPENAI_API_KEY!,
    });
    if (!(await generator.validateApiKey())) {
      throw new Error('Invalid LLM API key');
    }
    const fromParts = new ChatbotHelper(generator, new PrismaAdapter(prisma, 'postgres'), { repairAttempts: 0 });
    console.log((await fromParts.ask('List all users', { userId: 1, role: 'admin' })).query);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Without a database connection: read prisma/schema.prisma. Names follow
 * @map and @@map, enums become enum values, relations become foreign keys and
 * /// comments become descriptions. Nothing is executed.
 */
async function exampleFromSchemaFile() {
  const generator = createQueryGenerator({
    llm: { provider: 'claude', apiKey: process.env.ANTHROPIC_API_KEY! },
    database: parsePrismaSchema(readFileSync('prisma/schema.prisma', 'utf8')),
    security: { allowedOperations: ['SELECT'], maxRowLimit: 100, requireUserContext: false },
  });
  const { query } = await generator.generateQuery('Revenue per month this year');
  console.log(query);
}

if (require.main === module) {
  exampleWithPrisma()
    .then(() => exampleFromSchemaFile())
    .catch(console.error);
}

export { exampleWithPrisma, exampleFromSchemaFile };
