/**
 * Direct Database Connection Example
 *
 * This example shows how to use text-db-query-ai with direct database connections
 * (without an ORM). Works with pg, mysql2, sqlite3, etc.
 */

import pg from 'pg';
import { createChatbotFromDatabase, createFromDatabase } from '../src';

async function postgresExample() {
  console.log('PostgreSQL Direct Connection Example\n');
  console.log('='.repeat(60));

  // Create PostgreSQL connection pool
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'testdb',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD,
  });

  try {
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✓ Connected to PostgreSQL\n');

    // Option 1: Create chatbot with automatic query execution
    console.log('Option 1: Using ChatbotHelper (Easiest)');
    console.log('-'.repeat(60));

    const chatbot = await createChatbotFromDatabase(
      pool,
      'postgres',
      {
        llmProvider: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'your-api-key',
        security: {
          allowedOperations: ['SELECT'],
          maxRowLimit: 100,
          enableRowLevelSecurity: true,
        },
        debug: true,
      },
      {
        // Only include specific tables
        includeTables: ['users', 'orders', 'products'],
        // Mark sensitive columns
        markSensitiveColumns: ['password', 'hash', 'ssn', 'credit_card'],
      }
    );

    console.log(`
// Usage:
const result = await chatbot.ask('Show all users');
console.log(result.query);    // Generated SQL
console.log(result.results);  // Query results
    `);

    // Option 2: Create generator only (manual query execution)
    console.log('\n\nOption 2: Using QueryGenerator (More Control)');
    console.log('-'.repeat(60));

    const generator = await createFromDatabase(
      pool,
      'postgres',
      {
        llmProvider: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'your-api-key',
        security: {
          allowedOperations: ['SELECT'],
          maxRowLimit: 100,
        },
      }
    );

    console.log(`
// Generate query
const queryResult = await generator.generateQuery('Show all users', {
  userId: 123,
  role: 'user',
});

// Execute manually with full control
const dbResult = await pool.query(queryResult.query);
console.log(dbResult.rows);
    `);

    console.log('\n\n' + '='.repeat(60));
    console.log('MySQL Example');
    console.log('='.repeat(60));

    console.log(`
import mysql from 'mysql2/promise';
import { createChatbotFromDatabase } from 'text-db-query-ai';

// Create MySQL connection
const connection = await mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: 'password',
  database: 'mydb',
});

// Create chatbot
const chatbot = await createChatbotFromDatabase(
  connection,
  'mysql',
  {
    llmProvider: 'claude',
    apiKey: process.env.ANTHROPIC_API_KEY!,
    security: {
      allowedOperations: ['SELECT'],
      maxRowLimit: 50,
    },
  }
);

// Use it
const result = await chatbot.ask('Show all users');
    `);

    console.log('\n\n' + '='.repeat(60));
    console.log('SQLite Example');
    console.log('='.repeat(60));

    console.log(`
import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { createChatbotFromDatabase } from 'text-db-query-ai';

// Create SQLite connection
const db = new sqlite3.Database('./mydb.sqlite');

// Create chatbot
const chatbot = await createChatbotFromDatabase(
  db,
  'sqlite',
  {
    llmProvider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    security: {
      allowedOperations: ['SELECT'],
      maxRowLimit: 100,
    },
  }
);

// Use it
const result = await chatbot.ask('Show me all products');
    `);

    console.log('\n\n' + '='.repeat(60));
    console.log('Express.js Integration');
    console.log('='.repeat(60));

    console.log(`
import express from 'express';
import pg from 'pg';
import { createChatbotFromDatabase } from 'text-db-query-ai';

const app = express();
app.use(express.json());

// Initialize
const pool = new pg.Pool({ /* config */ });
const chatbot = await createChatbotFromDatabase(pool, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  security: {
    allowedOperations: ['SELECT'],
    maxRowLimit: 50,
    enableRowLevelSecurity: true,
  },
});

// Endpoint
app.post('/api/query', async (req, res) => {
  try {
    const { question } = req.body;
    const userId = req.session.userId;

    const result = await chatbot.ask(question, {
      userId,
      role: req.session.role,
    });

    res.json({
      success: true,
      query: result.query,
      data: result.results,
      count: result.results.length,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

app.listen(3000);
    `);

    console.log('\n\n' + '='.repeat(60));
    console.log('Benefits:');
    console.log('='.repeat(60));
    console.log(`
✓ No ORM required
✓ Works with any database driver (pg, mysql2, sqlite3, etc.)
✓ Automatic schema extraction via database introspection
✓ Full control over connections and transactions
✓ Lightweight - no additional dependencies
✓ Compatible with existing database code
✓ Schema stays in sync with actual database
    `);

  } finally {
    await pool.end();
    console.log('\n✓ Connection closed');
  }
}

// Run example
if (require.main === module) {
  postgresExample().catch(console.error);
}

export { postgresExample };
