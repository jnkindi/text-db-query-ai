/**
 * Client for helpers/pglite-server.js: a pg-style connection (`query(sql, params)`
 * resolving to `{ rows }`, like pg and PGlite) backed by PGlite in a child process.
 */

import { fork, ChildProcess } from 'child_process';
import { join } from 'path';

export interface PGliteProcess {
  /** Same contract as PGlite's and pg's query(): resolves to { rows }. */
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** Run one or more statements without parameters. */
  exec(sql: string): Promise<void>;
  /** SQL of every query() call since the last reset. */
  readonly queries: string[];
  resetQueries(): void;
  close(): Promise<void>;
}

interface Reply {
  id: number;
  rows?: Record<string, unknown>[];
  error?: { message: string; code?: string };
}

export function startPGlite(): PGliteProcess {
  const child: ChildProcess = fork(join(__dirname, 'pglite-server.js'), [], {
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const pending = new Map<number, { resolve: (rows: Record<string, unknown>[]) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let queries: string[] = [];

  child.on('message', (reply: Reply) => {
    const waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id);
    if (reply.error) waiter.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
    else waiter.resolve(reply.rows ?? []);
  });
  child.on('exit', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('PGlite process exited'));
    pending.clear();
  });

  const send = (message: object): Promise<Record<string, unknown>[]> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.send({ id, ...message });
    });

  return {
    async query(sql, params) {
      queries.push(sql);
      return { rows: await send({ method: 'query', sql, params }) };
    },
    async exec(sql) {
      await send({ method: 'exec', sql });
    },
    get queries() {
      return queries;
    },
    resetQueries() {
      queries = [];
    },
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.disconnect();
      });
    },
  };
}
