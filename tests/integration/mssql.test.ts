/**
 * SQL Server introspection through a fake mssql ConnectionPool (no server is
 * available in CI). The fake keeps the mssql contract that 0.0.1 got wrong:
 * parameters must be declared with request().input(), and results come back as
 * { recordset, recordsets, rowsAffected }.
 */

import { DatabaseIntrospectionAdapter, PrismaAdapter } from '../../src/adapters';
import { INTROSPECTION_SQL } from '../../src/adapters/introspection';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('text-db-query-ai-legacy');

type Rows = Record<string, unknown>[];

const SQL = INTROSPECTION_SQL.mssql;

/** Catalog rows for schema "dbo" (and one table in "sales"), keyed by query. */
function catalog(schema: unknown): Map<string, Rows> {
  if (schema !== 'dbo') return new Map(Object.values(SQL).map((sql) => [sql, [] as Rows]));
  const col = (table: string, name: string, type: string, nullable: boolean, length: number | null = null, precision: number | null = null, scale: number | null = null) => ({
    TABLE_NAME: table, COLUMN_NAME: name, DATA_TYPE: type, CHARACTER_MAXIMUM_LENGTH: length,
    NUMERIC_PRECISION: precision, NUMERIC_SCALE: scale, IS_NULLABLE: nullable ? 'YES' : 'NO',
  });
  return new Map<string, Rows>([
    [SQL.tables, [{ table_schema: 'dbo', table_name: 'Customer' }, { table_schema: 'dbo', table_name: 'Order' }, { table_schema: 'dbo', table_name: 'OrderLine' }]],
    [SQL.columns, [
      col('Customer', 'Id', 'uniqueidentifier', false),
      col('Customer', 'Name', 'nvarchar', false, 200),
      col('Customer', 'Notes', 'nvarchar', true, -1),
      col('Order', 'Id', 'int', false, null, 10, 0),
      col('Order', 'CustomerId', 'uniqueidentifier', false),
      col('Order', 'Total', 'decimal', true, null, 12, 2),
      col('Order', 'PlacedAt', 'datetime2', false),
      col('OrderLine', 'OrderId', 'int', false, null, 10, 0),
      col('OrderLine', 'LineNo', 'smallint', false, null, 5, 0),
      col('OrderLine', 'InvoiceId', 'int', true, null, 10, 0),
    ]],
    [SQL.primaryKeys, [
      { table_name: 'Customer', column_name: 'Id', ordinal_position: 1 },
      { table_name: 'Order', column_name: 'Id', ordinal_position: 1 },
      { table_name: 'OrderLine', column_name: 'LineNo', ordinal_position: 2 },
      { table_name: 'OrderLine', column_name: 'OrderId', ordinal_position: 1 },
    ]],
    [SQL.foreignKeys, [
      { table_name: 'Order', constraint_name: 'FK_Order_Customer', position: 1, column_name: 'CustomerId', referenced_schema: 'dbo', referenced_table: 'Customer', referenced_column: 'Id' },
      { table_name: 'OrderLine', constraint_name: 'FK_OrderLine_Invoice', position: 1, column_name: 'InvoiceId', referenced_schema: 'sales', referenced_table: 'Invoice', referenced_column: 'Id' },
      { table_name: 'OrderLine', constraint_name: 'FK_OrderLine_Order', position: 1, column_name: 'OrderId', referenced_schema: 'dbo', referenced_table: 'Order', referenced_column: 'Id' },
    ]],
    [SQL.descriptions, [
      { table_name: 'Customer', column_name: null, description: 'People who place orders' },
      { table_name: 'Order', column_name: 'PlacedAt', description: 'UTC' },
    ]],
  ]);
}

/** A fake mssql ConnectionPool: request().input(name, value).query(sql) -> { recordset }. */
function fakePool() {
  const executed: Array<{ sql: string; inputs: Record<string, unknown> }> = [];
  const pool = {
    executed,
    // 0.0.1 called pool.query(sql, [params]); mssql treats the second argument as a callback only.
    query: jest.fn(async () => ({ recordsets: [[]], recordset: undefined, rowsAffected: [0] })),
    request() {
      const inputs: Record<string, unknown> = {};
      const request = {
        input(name: string, value: unknown) {
          inputs[name] = value;
          return request;
        },
        async query(sql: string) {
          for (const match of sql.matchAll(/@(\w+)/g)) {
            if (!(match[1] in inputs)) throw new Error(`Must declare the scalar variable "@${match[1]}".`);
          }
          executed.push({ sql, inputs });
          const rows = catalog(inputs.P1).get(sql);
          if (!rows) throw new Error(`Incorrect syntax: unexpected query ${sql.slice(0, 40)}`);
          return { recordsets: [rows], recordset: rows, rowsAffected: [rows.length], output: {} };
        },
      };
      return request;
    },
  };
  return pool;
}

const column = (name: string, type: string, nullable: boolean, nativeType: string, extra: object = {}) => ({
  name,
  type,
  nullable,
  sensitive: false,
  nativeType,
  ...extra,
});

const EXPECTED = {
  databaseType: 'mssql',
  tables: [
    {
      name: 'Customer',
      schema: 'dbo',
      description: 'People who place orders',
      columns: [
        column('Id', 'varchar', false, 'uniqueidentifier'),
        column('Name', 'varchar', false, 'nvarchar(200)'),
        column('Notes', 'varchar', true, 'nvarchar(max)'),
      ],
      primaryKey: 'Id',
      primaryKeyColumns: ['Id'],
      foreignKeys: undefined,
    },
    {
      name: 'Order',
      schema: 'dbo',
      columns: [
        column('Id', 'integer', false, 'int'),
        column('CustomerId', 'varchar', false, 'uniqueidentifier'),
        column('Total', 'decimal', true, 'decimal(12,2)'),
        column('PlacedAt', 'timestamp', false, 'datetime2', { description: 'UTC' }),
      ],
      primaryKey: 'Id',
      primaryKeyColumns: ['Id'],
      foreignKeys: [{ column: 'CustomerId', referencedTable: 'Customer', referencedColumn: 'Id' }],
    },
    {
      name: 'OrderLine',
      schema: 'dbo',
      columns: [
        column('OrderId', 'integer', false, 'int'),
        column('LineNo', 'integer', false, 'smallint'),
        column('InvoiceId', 'integer', true, 'int'),
      ],
      primaryKey: 'OrderId, LineNo',
      primaryKeyColumns: ['OrderId', 'LineNo'],
      foreignKeys: [
        { column: 'InvoiceId', referencedTable: 'Invoice', referencedColumn: 'Id', referencedSchema: 'sales' },
        { column: 'OrderId', referencedTable: 'Order', referencedColumn: 'Id' },
      ],
    },
  ],
};

describe('SQL Server (fake mssql ConnectionPool)', () => {
  it('extracts dbo with declared @P1 inputs, in 5 requests', async () => {
    const pool = fakePool();
    const schema = await new DatabaseIntrospectionAdapter(pool, 'mssql').extractSchema();

    expect(schema).toEqual(EXPECTED);
    expect(pool.executed).toHaveLength(5);
    expect(pool.executed.every((call) => JSON.stringify(call.inputs) === '{"P1":"dbo"}')).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('reads another schema and skips MS_Description when descriptions are off', async () => {
    const pool = fakePool();
    const schema = await new DatabaseIntrospectionAdapter(pool, 'mssql', { schema: 'sales', includeDescriptions: false }).extractSchema();
    expect(schema.tables).toEqual([]);
    expect(pool.executed.map((call) => call.inputs.P1)).toEqual(['sales', 'sales', 'sales', 'sales']);
  });

  it('works where 0.0.1 crashed on the result shape', async () => {
    await expect(new legacy.DatabaseIntrospectionAdapter(fakePool(), 'mssql').extractSchema()).rejects.toThrow(
      /Failed to introspect database: Cannot read properties of undefined/
    );
  });

  it('PrismaAdapter on SQL Server binds the schema as @P1 (0.0.1 looked in "public")', async () => {
    const pool = fakePool();
    const prisma = {
      $queryRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
        const request = pool.request();
        values.forEach((value, index) => request.input(`P${index + 1}`, value));
        return (await request.query(sql)).recordset;
      }),
    };
    expect(await new PrismaAdapter(prisma, 'mssql').extractSchema()).toEqual(EXPECTED);
    expect(prisma.$queryRawUnsafe.mock.calls.every((call) => call.length === 2 && call[1] === 'dbo')).toBe(true);
  });
});
