/**
 * Direct Database Introspection Adapter
 */

import { DatabaseSchema, DatabaseType } from '../types';
import { ORMAdapter, SchemaExtractionOptions, IntrospectionExecutor } from './types';
import { introspectSchema } from './introspection';

/**
 * Database connection configuration
 */
export interface DatabaseConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  type: DatabaseType;
}

/**
 * How a connection object runs SQL, detected from its methods.
 * - mssql: mssql ConnectionPool or Transaction (`request().input().query()`)
 * - mysql2-callback: mysql2 callback API, used through its `.promise()` wrapper
 * - query: `query(sql, params)` returning a promise (pg Pool/Client, PGlite, mysql2/promise)
 *   or an event-emitting query object (callback drivers such as mysqljs/mysql)
 * - sqlite3: sqlite3 Database (`all(sql, params, callback)`)
 * - prepare: synchronous `prepare(sql)` (better-sqlite3, node:sqlite)
 */
type ConnectionKind = 'mssql' | 'mysql2-callback' | 'query' | 'sqlite3' | 'prepare';

const UNSUPPORTED_CONNECTION =
  'Unsupported connection type: expected a pg Pool/Client, PGlite, mysql2 connection or pool, ' +
  'sqlite3, better-sqlite3 or node:sqlite database, or mssql ConnectionPool ' +
  '(use PrismaAdapter for a Prisma client)';

function detectConnectionKind(connection: any): ConnectionKind | undefined {
  if (!connection || (typeof connection !== 'object' && typeof connection !== 'function')) {
    return undefined;
  }
  // mssql pools also have query(), so check request() first.
  if (typeof connection.request === 'function') return 'mssql';
  if (typeof connection.query === 'function') {
    // Only mysql2's callback classes have promise(); their query() returns a Query object.
    return typeof connection.promise === 'function' ? 'mysql2-callback' : 'query';
  }
  if (typeof connection.all === 'function') return 'sqlite3';
  if (typeof connection.prepare === 'function') return 'prepare';
  return undefined;
}

/** An event-emitting query object, returned by callback drivers called without a callback. */
function isQueryEmitter(value: any): boolean {
  return (
    !!value &&
    typeof value.then !== 'function' &&
    typeof value.on === 'function' &&
    value.rows === undefined &&
    !Array.isArray(value)
  );
}

/**
 * Wait for a mysql-style Query object to finish. Resolves to the rows of the
 * first result set, or to its OK packet for statements that return no rows
 * (the shapes mysql2/promise returns as the first element).
 */
function collectQueryEvents(query: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const rows: unknown[] = [];
    let isRowSet = false;
    let header: unknown;
    let failed = false;

    query.on('fields', (fields: unknown) => {
      if (rows.length === 0 && header === undefined) isRowSet = Array.isArray(fields);
    });
    query.on('result', (row: unknown, index?: number) => {
      if (index !== undefined && index > 0) return; // later statements of a multi-statement query
      if (isRowSet) rows.push(row);
      else if (header === undefined) header = row;
    });
    query.on('error', (error: unknown) => {
      failed = true;
      reject(error);
    });
    query.on('end', () => {
      if (!failed) resolve(header !== undefined ? header : rows);
    });
  });
}

/**
 * Direct database introspection adapter
 * Works with any database connection without requiring an ORM
 */
export class DatabaseIntrospectionAdapter implements ORMAdapter {
  private connection: any;
  private databaseType: DatabaseType;
  private options: SchemaExtractionOptions;
  private connectionKind?: ConnectionKind;
  private mysqlPromiseConnection?: any;

  constructor(
    connection: any,
    databaseType: DatabaseType,
    options: SchemaExtractionOptions = {}
  ) {
    this.connection = connection;
    this.databaseType = databaseType;
    this.options = options;
  }

  /**
   * Extract schema from database by introspection.
   *
   * Runs a fixed number of catalog queries whatever the number of tables
   * (see `introspectSchema`). Queries go through `executeQuery`.
   */
  async extractSchema(): Promise<DatabaseSchema> {
    const execute: IntrospectionExecutor = (sql, params) => this.executeQuery(sql, params);
    try {
      return await introspectSchema(execute, this.databaseType, this.options);
    } catch (error: any) {
      throw new Error(`Failed to introspect database: ${error.message}`);
    }
  }

  /**
   * Execute a query.
   *
   * Resolves to the rows of a SELECT, as 0.0.1 did. For other statements it
   * resolves to what the driver reports (for example mysql2's ResultSetHeader,
   * better-sqlite3's run() info or the mssql result). Parameters use the
   * driver's placeholders: `$1` for pg and PGlite, `?` for mysql2 and the SQLite
   * drivers, `@P1`, `@P2`... for mssql.
   *
   * @param query - SQL to run
   * @param parameters - Values bound to the placeholders
   */
  async executeQuery(query: string, parameters?: any[]): Promise<any> {
    switch (this.getConnectionKind()) {
      case 'query': {
        // pg, PGlite, mysql2/promise
        const pending = this.connection.query(query, parameters);
        // A callback driver called without a callback returns a Query object that emits rows.
        if (isQueryEmitter(pending)) return collectQueryEvents(pending);
        const result = await pending;
        return result.rows || result[0]; // pg returns .rows, mysql returns array
      }
      case 'mysql2-callback': {
        const [rows] = await this.getMysqlPromiseConnection().query(query, parameters);
        return rows;
      }
      case 'sqlite3':
        return new Promise((resolve, reject) => {
          this.connection.all(query, parameters || [], (err: any, rows: any) => {
            if (err) reject(err);
            else resolve(rows);
          });
        });
      case 'prepare': {
        // better-sqlite3 and node:sqlite are synchronous.
        const statement = this.connection.prepare(query);
        const values = parameters || [];
        // better-sqlite3 refuses all() on statements that return no rows.
        if (statement.reader === false) return statement.run(...values);
        return statement.all(...values);
      }
      case 'mssql': {
        const request = this.connection.request();
        (parameters || []).forEach((value, index) => request.input(`P${index + 1}`, value));
        const result = await request.query(query);
        return result?.recordset ?? result;
      }
      default:
        throw new Error(UNSUPPORTED_CONNECTION);
    }
  }

  /**
   * Get database type
   */
  getDatabaseType(): string {
    return this.databaseType;
  }

  private getConnectionKind(): ConnectionKind | undefined {
    if (!this.connectionKind) this.connectionKind = detectConnectionKind(this.connection);
    return this.connectionKind;
  }

  private getMysqlPromiseConnection(): any {
    if (!this.mysqlPromiseConnection) this.mysqlPromiseConnection = this.connection.promise();
    return this.mysqlPromiseConnection;
  }
}

/**
 * Create a database introspection adapter
 */
export function createDatabaseAdapter(
  connection: any,
  databaseType: DatabaseType,
  options?: SchemaExtractionOptions
): DatabaseIntrospectionAdapter {
  return new DatabaseIntrospectionAdapter(connection, databaseType, options);
}
