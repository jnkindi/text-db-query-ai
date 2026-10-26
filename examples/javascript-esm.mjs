/**
 * JavaScript ESM Usage Example
 *
 * The same API from an ES module, with an in-memory SQLite database and a
 * generator only: the query is generated and validated, and you execute it.
 *
 * Run: ANTHROPIC_API_KEY=... node javascript-esm.mjs
 * (the package must be installed; see README.md in this folder)
 */

import sqlite3 from 'sqlite3';
import { createFromDatabase, TextToQueryError } from 'text-db-query-ai';

const db = new sqlite3.Database(':memory:');

/**
 * Run SQL and resolve to its rows.
 * @param {string} sql
 * @returns {Promise<unknown[]>}
 */
const all = (sql) => new Promise((resolve, reject) => db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));

await all('CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, category TEXT)');
await all("INSERT INTO products (name, price, category) VALUES ('Keyboard', 49.5, 'hardware'), ('Mouse', 19.9, 'hardware'), ('IDE licence', 89, 'software')");

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('Set ANTHROPIC_API_KEY to ask questions.');
} else {
  // The model defaults to 'claude-opus-5-5'
  const generator = await createFromDatabase(db, 'sqlite', {
    llmProvider: 'claude',
    apiKey: process.env.ANTHROPIC_API_KEY,
    security: { allowedOperations: ['SELECT'], maxRowLimit: 50, requireUserContext: false },
  });

  try {
    const { query, metadata } = await generator.generateQuery('Cheapest product in each category');
    console.log(query, metadata);
    console.table(await all(query));
  } catch (error) {
    if (error instanceof TextToQueryError) console.error(`${error.code}: ${error.message}`);
    else throw error;
  }
}

db.close();
