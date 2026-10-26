/**
 * Tests for DatabaseIntrospectionAdapter.executeQuery across driver shapes.
 * Fakes reproduce each driver's contract; sqlite3 and node:sqlite run for real
 * when they can be loaded.
 */

import { EventEmitter } from 'events';
import { DatabaseIntrospectionAdapter, createDatabaseAdapter } from '../../src/adapters';

const ROWS = [{ id: 1 }, { id: 2 }];

function optionalRequire(name: string): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(name);
  } catch {
    return undefined;
  }
}

/** A mysql-style Query object: emits fields, one result per row (or an OK packet), then end. */
function emittingQuery(script: (query: EventEmitter) => void): EventEmitter {
  const query = new EventEmitter();
  setImmediate(() => script(query));
  return query;
}

describe('DatabaseIntrospectionAdapter.executeQuery', () => {
  it('pg Pool/Client and PGlite: query(sql, params) -> rows', async () => {
    const connection = { query: jest.fn(async () => ({ rows: ROWS, rowCount: 2 })) };
    const adapter = new DatabaseIntrospectionAdapter(connection, 'postgres');

    await expect(adapter.executeQuery('SELECT id FROM t WHERE a = $1', [5])).resolves.toEqual(ROWS);
    expect(connection.query).toHaveBeenCalledWith('SELECT id FROM t WHERE a = $1', [5]);

    await adapter.executeQuery('SELECT 1');
    expect(connection.query).toHaveBeenLastCalledWith('SELECT 1', undefined); // as 0.0.1
  });

  it('mysql2/promise: [rows, fields] -> rows, and the ResultSetHeader for writes', async () => {
    const header = { affectedRows: 1, insertId: 7 };
    const connection = {
      query: jest.fn(async (sql: string) => (sql.startsWith('SELECT') ? [ROWS, [{ name: 'id' }]] : [header, undefined])),
    };
    const adapter = new DatabaseIntrospectionAdapter(connection, 'mysql');

    await expect(adapter.executeQuery('SELECT id FROM t WHERE a = ?', [5])).resolves.toEqual(ROWS);
    await expect(adapter.executeQuery('UPDATE t SET a = 1')).resolves.toBe(header);
  });

  it('mysql2 callback API: goes through .promise() and never touches the Query object', async () => {
    const promiseConnection = { query: jest.fn(async () => [ROWS, []]) };
    const connection = {
      query: jest.fn(() => new EventEmitter()),
      promise: jest.fn(() => promiseConnection),
    };
    const adapter = new DatabaseIntrospectionAdapter(connection, 'mysql');

    await expect(adapter.executeQuery('SELECT id FROM t WHERE a = ?', [5])).resolves.toEqual(ROWS);
    await adapter.executeQuery('SELECT 2');
    expect(connection.query).not.toHaveBeenCalled();
    expect(connection.promise).toHaveBeenCalledTimes(1);
    expect(promiseConnection.query).toHaveBeenCalledWith('SELECT id FROM t WHERE a = ?', [5]);
  });

  it('callback drivers without .promise(): collects rows from the Query events', async () => {
    const connection = {
      query: jest.fn((sql: string) =>
        emittingQuery((q) => {
          if (sql.startsWith('SELECT')) {
            q.emit('fields', [{ name: 'id' }]);
            for (const row of ROWS) q.emit('result', row, 0);
          } else {
            q.emit('result', { affectedRows: 3 }, 0);
          }
          q.emit('end');
        })
      ),
    };
    const adapter = new DatabaseIntrospectionAdapter(connection, 'mysql');

    await expect(adapter.executeQuery('SELECT id FROM t')).resolves.toEqual(ROWS);
    await expect(adapter.executeQuery('DELETE FROM t')).resolves.toEqual({ affectedRows: 3 });
  });

  it('callback drivers without .promise(): rejects on the error event', async () => {
    const connection = {
      query: () =>
        emittingQuery((q) => {
          q.emit('error', new Error("ER_NO_SUCH_TABLE: Table 'x' doesn't exist"));
          q.emit('end');
        }),
    };
    await expect(new DatabaseIntrospectionAdapter(connection, 'mysql').executeQuery('SELECT 1')).rejects.toThrow(
      'ER_NO_SUCH_TABLE'
    );
  });

  it('sqlite3: all(sql, params, callback)', async () => {
    const connection = {
      all: jest.fn((_sql: string, _params: unknown[], cb: (err: Error | null, rows?: unknown[]) => void) => cb(null, ROWS)),
    };
    const adapter = new DatabaseIntrospectionAdapter(connection, 'sqlite');

    await expect(adapter.executeQuery('SELECT id FROM t WHERE a = ?', [5])).resolves.toEqual(ROWS);
    expect(connection.all.mock.calls[0].slice(0, 2)).toEqual(['SELECT id FROM t WHERE a = ?', [5]]);
    await adapter.executeQuery('SELECT 1');
    expect(connection.all.mock.calls[1][1]).toEqual([]);
  });

  it('better-sqlite3: prepare(sql).all(...params), run() for statements without rows', () => {
    const reader = { reader: true, all: jest.fn(() => ROWS), run: jest.fn() };
    const writer = { reader: false, all: jest.fn(() => { throw new TypeError('This statement does not return data'); }), run: jest.fn(() => ({ changes: 1 })) };
    const connection = { prepare: jest.fn((sql: string) => (sql.startsWith('SELECT') ? reader : writer)) };
    const adapter = new DatabaseIntrospectionAdapter(connection, 'sqlite');

    return Promise.all([
      expect(adapter.executeQuery('SELECT id FROM t WHERE a = ? AND b = ?', [5, 'x'])).resolves.toEqual(ROWS),
      expect(adapter.executeQuery('DELETE FROM t WHERE a = ?', [5])).resolves.toEqual({ changes: 1 }),
    ]).then(() => {
      expect(reader.all).toHaveBeenCalledWith(5, 'x');
      expect(writer.run).toHaveBeenCalledWith(5);
    });
  });

  it('mssql ConnectionPool: request().input(P1..Pn).query() -> recordset', async () => {
    const inputs: Array<[string, unknown]> = [];
    const request: any = {
      input: jest.fn((name: string, value: unknown): any => {
        inputs.push([name, value]);
        return request;
      }),
      query: jest.fn(async () => ({ recordset: ROWS, recordsets: [ROWS], rowsAffected: [2] })),
    };
    // mssql pools also expose query(); request() must win.
    const connection = { request: jest.fn(() => request), query: jest.fn() };
    const adapter = new DatabaseIntrospectionAdapter(connection, 'mssql');

    await expect(adapter.executeQuery('SELECT id FROM t WHERE a = @P1 AND b = @P2', [5, 'x'])).resolves.toEqual(ROWS);
    expect(inputs).toEqual([['P1', 5], ['P2', 'x']]);
    expect(request.query).toHaveBeenCalledWith('SELECT id FROM t WHERE a = @P1 AND b = @P2');
    expect(connection.query).not.toHaveBeenCalled();
  });

  it('mssql: returns the driver result for statements without a recordset', async () => {
    const result = { recordsets: [], rowsAffected: [4] };
    const request = { input: jest.fn(), query: jest.fn(async () => result) };
    const adapter = new DatabaseIntrospectionAdapter({ request: () => request }, 'mssql');
    await expect(adapter.executeQuery('UPDATE t SET a = 1')).resolves.toBe(result);
  });

  it('rejects unknown connection shapes with a clear error', async () => {
    for (const connection of [{}, null, 42, { execute: () => undefined }]) {
      const adapter = new DatabaseIntrospectionAdapter(connection, 'postgres');
      await expect(adapter.executeQuery('SELECT 1')).rejects.toThrow(/^Unsupported connection type: expected a pg Pool/);
    }
    await expect(new DatabaseIntrospectionAdapter({}, 'postgres').extractSchema()).rejects.toThrow(
      'Failed to introspect database: Unsupported connection type'
    );
  });

  it('createDatabaseAdapter builds the same adapter', () => {
    const adapter = createDatabaseAdapter({ query: async () => ({ rows: [] }) }, 'mysql', { schema: 'app' });
    expect(adapter).toBeInstanceOf(DatabaseIntrospectionAdapter);
    expect(adapter.getDatabaseType()).toBe('mysql');
  });
});

const sqlite3 = optionalRequire('sqlite3');
const describeSqlite3 = sqlite3 ? describe : describe.skip;

describeSqlite3('executeQuery with a real sqlite3 database', () => {
  let db: any;

  beforeAll(async () => {
    db = new sqlite3.Database(':memory:');
    await new Promise<void>((resolve, reject) =>
      db.exec('CREATE TABLE "order" (id INTEGER PRIMARY KEY, total REAL); INSERT INTO "order" (total) VALUES (1.5), (2.5);', (err: Error | null) =>
        err ? reject(err) : resolve()
      )
    );
  });

  afterAll(() => new Promise<void>((resolve) => db.close(() => resolve())));

  it('binds parameters', async () => {
    const adapter = new DatabaseIntrospectionAdapter(db, 'sqlite');
    await expect(adapter.executeQuery('SELECT id, total FROM "order" WHERE total > ? ORDER BY id', [2])).resolves.toEqual([
      { id: 2, total: 2.5 },
    ]);
  });
});

const nodeSqlite = optionalRequire('node:sqlite');
const describeNodeSqlite = nodeSqlite?.DatabaseSync ? describe : describe.skip;

describeNodeSqlite('executeQuery and extractSchema with node:sqlite', () => {
  it('reads rows and the schema through prepare()', async () => {
    const db = new nodeSqlite.DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE "Group" (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO "Group" (name) VALUES (\'a\'), (\'b\');');
      const adapter = new DatabaseIntrospectionAdapter(db, 'sqlite');

      const rows = await adapter.executeQuery('SELECT name FROM "Group" WHERE id = ?', [2]);
      expect(rows.map((row: any) => ({ ...row }))).toEqual([{ name: 'b' }]);

      const schema = await adapter.extractSchema();
      expect(schema.tables).toEqual([
        {
          name: 'Group',
          columns: [
            { name: 'id', type: 'integer', nullable: false, sensitive: false, nativeType: 'INTEGER' },
            { name: 'name', type: 'text', nullable: false, sensitive: false, nativeType: 'TEXT' },
          ],
          primaryKey: 'id',
          primaryKeyColumns: ['id'],
          foreignKeys: undefined,
        },
      ]);
    } finally {
      db.close();
    }
  });
});
