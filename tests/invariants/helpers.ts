/**
 * Shared helpers for the invariant tests (tests/invariants).
 *
 * These tests prove the library's documented security guarantees by running
 * the final SQL on real engines: sqlite3 in-process and Postgres through
 * PGlite (one process per test file, closed in afterAll). No real LLM is
 * used: QueryGenerator is driven with a fake provider.
 */
import type { DatabaseSchema, DatabaseType } from '../../src/types';

/** A fake LLM provider that always answers with the same text. */
export function fakeProvider(answer: string): any {
  return {
    async generate() {
      return answer;
    },
    async generateWithSystem() {
      return answer;
    },
    async validateApiKey() {
      return true;
    },
    getDefaultModel() {
      return 'fake-model';
    },
  };
}

/** A small schema used by the generator-pipeline tests. */
export function ordersSchema(databaseType: DatabaseType): DatabaseSchema {
  return {
    databaseType,
    tables: [
      {
        name: 'orders',
        columns: [
          { name: 'id', type: 'number' },
          { name: 'user_id', type: 'number' },
          { name: 'total', type: 'number' },
        ],
      },
      {
        name: 'notes',
        columns: [
          { name: 'id', type: 'number' },
          { name: 'body', type: 'string' },
        ],
      },
    ],
  };
}

// --- sqlite3 engine ---------------------------------------------------------

export function loadSqlite3(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('sqlite3');
  } catch {
    return undefined;
  }
}

export interface SqliteEngine {
  /** Run every statement in `sql` (sqlite3's exec: the whole batch). */
  exec(sql: string): Promise<void>;
  /** Run `sql` and return its rows (sqlite3's all: the first statement). */
  all(sql: string): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

export function openSqlite(sqlite3: any): SqliteEngine {
  const db = new sqlite3.Database(':memory:');
  return {
    exec: (sql: string) =>
      new Promise<void>((resolve, reject) => db.exec(sql, (err: Error | null) => (err ? reject(err) : resolve()))),
    all: (sql: string) =>
      new Promise((resolve, reject) => db.all(sql, (err: Error | null, rows: any[]) => (err ? reject(err) : resolve(rows)))),
    close: () => new Promise<void>((resolve) => db.close(() => resolve())),
  };
}
