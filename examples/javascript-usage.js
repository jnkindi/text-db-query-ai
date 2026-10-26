/**
 * JavaScript Usage Example (CommonJS)
 *
 * Plain JavaScript with an in-memory SQLite database: the schema is read
 * from the database, then questions are answered and executed against it.
 *
 * Run: OPENAI_API_KEY=... node javascript-usage.js
 * (the package must be installed; see README.md in this folder)
 */

const sqlite3 = require('sqlite3');
const { createChatbotFromDatabase, TextToQueryError } = require('text-db-query-ai');

/**
 * Run SQL that returns no rows.
 * @param {import('sqlite3').Database} db
 * @param {string} sql
 * @returns {Promise<void>}
 */
function runScript(db, sql) {
  return new Promise((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve(undefined))));
}

async function main() {
  const db = new sqlite3.Database(':memory:');

  await runScript(
    db,
    `
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT, role TEXT DEFAULT 'user');
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      total REAL,
      status TEXT DEFAULT 'pending'
    );
    INSERT INTO users (id, email, name) VALUES (1, 'john@example.com', 'John Doe'), (2, 'jane@example.com', 'Jane Smith');
    INSERT INTO orders (user_id, total, status) VALUES (1, 99.99, 'completed'), (1, 149.99, 'pending'), (2, 20, 'completed');
    `
  );
  console.log('Sample data created');

  if (!process.env.OPENAI_API_KEY) {
    console.log('Set OPENAI_API_KEY to ask questions.');
    await new Promise((resolve) => db.close(resolve));
    return;
  }

  // The model defaults to 'gpt-6-luna'
  const chatbot = await createChatbotFromDatabase(db, 'sqlite', {
    llmProvider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
    security: {
      allowedOperations: ['SELECT'],
      maxRowLimit: 100,
      enableRowLevelSecurity: true, // orders are filtered to the asking user
      allowedTables: ['orders'],
    },
  });

  try {
    const result = await chatbot.ask('Show my orders, largest first', { userId: 1, role: 'user' });
    console.log(result.query);
    console.table(result.results);
  } catch (error) {
    if (error instanceof TextToQueryError) {
      console.error(`${error.code}: ${error.message}`);
    } else {
      throw error;
    }
  } finally {
    await new Promise((resolve) => db.close(resolve));
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
