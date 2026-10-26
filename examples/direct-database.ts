/**
 * Direct Database Connection Example
 *
 * Reads the schema from a live database (no ORM) and answers questions with
 * it. Works with pg (and PGlite), mysql2, sqlite3, better-sqlite3,
 * node:sqlite and mssql connections.
 *
 * Run one of:
 *   DB=postgres DATABASE_URL=postgres://... OPENAI_API_KEY=... npx ts-node direct-database.ts
 *   DB=mysql    DATABASE_URL=mysql://...    OPENAI_API_KEY=... npx ts-node direct-database.ts   (npm install mysql2)
 *   DB=sqlite   SQLITE_FILE=./mydb.sqlite   OPENAI_API_KEY=... npx ts-node direct-database.ts
 */

import pg from 'pg';
import {
  ChatbotHelper,
  createChatbotFromDatabase,
  createFromDatabase,
  EasySetupConfig,
  SchemaExtractionOptions,
  UserContext,
} from '../src';

const config: EasySetupConfig = {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY || 'your-api-key',
  // model defaults to 'gpt-6-luna'
  security: {
    allowedOperations: ['SELECT'],
    maxRowLimit: 100,
  },
};

const extraction: SchemaExtractionOptions = {
  // Only show the model the tables the feature needs
  includeTables: ['users', 'orders', 'products'],
  // Mark columns whose name contains one of these as sensitive
  markSensitiveColumns: ['password', 'hash', 'ssn', 'token'],
};

const user: UserContext = { userId: 123, role: 'user' };

async function ask(chatbot: ChatbotHelper, question: string) {
  const result = await chatbot.ask(question, user);
  console.log(`\n${question}`);
  console.log(result.query);
  console.log(result.results.slice(0, 5));
}

async function postgresExample() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Option 1: ChatbotHelper generates and executes
    const chatbot = await createChatbotFromDatabase(pool, 'postgres', config, {
      ...extraction,
      schema: 'public', // the default
    });
    await ask(chatbot, 'Show the 10 most recent orders');

    // Option 2: a generator only; you execute the query yourself
    const generator = await createFromDatabase(pool, 'postgres', config, extraction);
    const { query } = await generator.generateQuery('How many products are in stock?', user);
    const { rows } = await pool.query(query);
    console.log(query, rows);
  } finally {
    await pool.end();
  }
}

async function mysqlExample() {
  // Loaded here so the other examples run without mysql2 installed
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection(process.env.DATABASE_URL || 'mysql://root@localhost/mydb');
  try {
    const chatbot = await createChatbotFromDatabase(
      connection,
      'mysql',
      { ...config, llmProvider: 'claude', apiKey: process.env.ANTHROPIC_API_KEY || config.apiKey },
      extraction
    );
    await ask(chatbot, 'Show all users who signed up this month');
  } finally {
    await connection.end();
  }
}

async function sqliteExample() {
  const sqlite3 = await import('sqlite3');
  const db = new sqlite3.Database(process.env.SQLITE_FILE || ':memory:');
  try {
    const chatbot = await createChatbotFromDatabase(db, 'sqlite', config, extraction);
    await ask(chatbot, 'Show me all products');
  } finally {
    await new Promise<void>((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
  }
}

async function main() {
  switch (process.env.DB || 'postgres') {
    case 'postgres':
      return postgresExample();
    case 'mysql':
      return mysqlExample();
    case 'sqlite':
      return sqliteExample();
    default:
      throw new Error('Set DB to postgres, mysql or sqlite');
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export { postgresExample, mysqlExample, sqliteExample };
