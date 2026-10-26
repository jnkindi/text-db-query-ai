/**
 * MySQL introspection against a real server. Runs only when MYSQL_URL is set,
 * for example MYSQL_URL=mysql://root@127.0.0.1:3307/test. The tests create and
 * drop their own databases.
 */

import { DatabaseIntrospectionAdapter, PrismaAdapter } from '../../src/adapters';
import { DatabaseSchema, TableSchema } from '../../src/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('text-db-query-ai-legacy');

jest.setTimeout(60000);

const MYSQL_URL = process.env.MYSQL_URL;
const describeMysql = MYSQL_URL ? describe : describe.skip;
const title = MYSQL_URL ? 'MySQL (MYSQL_URL)' : 'MySQL (skipped: set MYSQL_URL to run)';

const DB = `tdq_it_${process.pid}`;
const BILLING = `${DB}_billing`;

const DDL = `
  CREATE DATABASE ${BILLING};
  CREATE TABLE ${BILLING}.invoice (id INT AUTO_INCREMENT PRIMARY KEY, amount DECIMAL(12,2)) COMMENT='Issued invoices';
  CREATE DATABASE ${DB};
  USE ${DB};
  CREATE TABLE \`User\` (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    displayName VARCHAR(255) NOT NULL COMMENT 'Shown to\\n  other users',
    email TEXT,
    role ENUM('USER', 'ADMIN', 'it''s') NOT NULL DEFAULT 'USER',
    active TINYINT(1) NOT NULL DEFAULT 1,
    settings JSON,
    createdAt DATETIME(3) NOT NULL,
    password_hash VARCHAR(100)
  ) COMMENT='A registered account';
  CREATE TABLE \`order\` (
    id INT AUTO_INCREMENT PRIMARY KEY,
    userId INT UNSIGNED NOT NULL,
    total DECIMAL(10,2),
    FOREIGN KEY (userId) REFERENCES \`User\`(id)
  );
  CREATE TABLE line_item (
    order_id INT NOT NULL,
    line_no SMALLINT NOT NULL,
    qty INT NOT NULL,
    PRIMARY KEY (order_id, line_no),
    FOREIGN KEY (order_id) REFERENCES \`order\`(id)
  );
  CREATE TABLE refund (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    line_no SMALLINT NOT NULL,
    invoice_id INT,
    CONSTRAINT refund_line FOREIGN KEY (order_id, line_no) REFERENCES line_item(order_id, line_no),
    CONSTRAINT refund_invoice FOREIGN KEY (invoice_id) REFERENCES ${BILLING}.invoice(id)
  );
  CREATE VIEW user_emails AS SELECT id, email FROM \`User\`;
  INSERT INTO \`User\` (displayName, email, createdAt) VALUES ('Ada', 'ada@example.com', NOW(3)), ('Linus', NULL, NOW(3));
`;

const column = (name: string, type: string, nullable: boolean, nativeType: string, extra: object = {}) => ({
  name,
  type,
  nullable,
  sensitive: false,
  nativeType,
  ...extra,
});

const EXPECTED: TableSchema[] = [
  {
    name: 'User',
    schema: DB,
    description: 'A registered account',
    columns: [
      column('id', 'integer', false, 'int unsigned'),
      column('displayName', 'varchar', false, 'varchar(255)', { description: 'Shown to other users' }),
      column('email', 'text', true, 'text'),
      column('role', 'varchar', false, "enum('USER','ADMIN','it''s')", { enumValues: ['USER', 'ADMIN', "it's"] }),
      column('active', 'integer', false, 'tinyint(1)'),
      column('settings', 'json', true, 'json'),
      column('createdAt', 'timestamp', false, 'datetime(3)'),
      column('password_hash', 'varchar', true, 'varchar(100)', { sensitive: true }),
    ],
    primaryKey: 'id',
    primaryKeyColumns: ['id'],
    foreignKeys: undefined,
  },
  {
    name: 'line_item',
    schema: DB,
    columns: [
      column('order_id', 'integer', false, 'int'),
      column('line_no', 'integer', false, 'smallint'),
      column('qty', 'integer', false, 'int'),
    ],
    primaryKey: 'order_id, line_no',
    primaryKeyColumns: ['order_id', 'line_no'],
    foreignKeys: [{ column: 'order_id', referencedTable: 'order', referencedColumn: 'id' }],
  },
  {
    name: 'order',
    schema: DB,
    columns: [
      column('id', 'integer', false, 'int'),
      column('userId', 'integer', false, 'int unsigned'),
      column('total', 'decimal', true, 'decimal(10,2)'),
    ],
    primaryKey: 'id',
    primaryKeyColumns: ['id'],
    foreignKeys: [{ column: 'userId', referencedTable: 'User', referencedColumn: 'id' }],
  },
  {
    name: 'refund',
    schema: DB,
    columns: [
      column('id', 'integer', false, 'bigint'),
      column('order_id', 'integer', false, 'int'),
      column('line_no', 'integer', false, 'smallint'),
      column('invoice_id', 'integer', true, 'int'),
    ],
    primaryKey: 'id',
    primaryKeyColumns: ['id'],
    foreignKeys: [
      { column: 'invoice_id', referencedTable: 'invoice', referencedColumn: 'id', referencedSchema: BILLING },
      { column: 'order_id', referencedTable: 'line_item', referencedColumn: 'order_id' },
      { column: 'line_no', referencedTable: 'line_item', referencedColumn: 'line_no' },
    ],
  },
  {
    // Views are listed, as in 0.0.1; MySQL's "VIEW" comment is not a description.
    name: 'user_emails',
    schema: DB,
    columns: [column('id', 'integer', false, 'int unsigned'), column('email', 'text', true, 'text')],
    primaryKey: undefined,
    foreignKeys: undefined,
  },
];

/** Table order depends on the server's lower_case_table_names; compare by name. */
const byName = (schema: DatabaseSchema) =>
  Object.fromEntries(schema.tables.map((table) => [table.name, table]));

describeMysql(title, () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysql = require('mysql2/promise');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mysqlCallback = require('mysql2');
  let admin: any;
  let connection: any;

  beforeAll(async () => {
    admin = await mysql.createConnection({ uri: MYSQL_URL, multipleStatements: true });
    await admin.query(`DROP DATABASE IF EXISTS ${DB}; DROP DATABASE IF EXISTS ${BILLING};`);
    await admin.query(DDL);
    connection = await mysql.createConnection({ uri: MYSQL_URL, database: DB });
  });

  afterAll(async () => {
    await connection?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB}; DROP DATABASE IF EXISTS ${BILLING};`);
      await admin.end();
    }
  });

  it('extracts the current database exactly with mysql2/promise, in 3 queries', async () => {
    const query = jest.spyOn(connection, 'query');
    try {
      const schema = await new DatabaseIntrospectionAdapter(connection, 'mysql', {
        markSensitiveColumns: ['password'],
      }).extractSchema();

      expect(schema.databaseType).toBe('mysql');
      expect(Object.keys(byName(schema)).sort()).toEqual(EXPECTED.map((t) => t.name).sort());
      expect(byName(schema)).toEqual(Object.fromEntries(EXPECTED.map((t) => [t.name, t])));
      expect(query).toHaveBeenCalledTimes(3);
    } finally {
      query.mockRestore();
    }
  });

  it('reads another database with the schema option', async () => {
    const schema = await new DatabaseIntrospectionAdapter(connection, 'mysql', { schema: BILLING }).extractSchema();
    expect(schema.tables).toEqual([
      {
        name: 'invoice',
        schema: BILLING,
        description: 'Issued invoices',
        columns: [column('id', 'integer', false, 'int'), column('amount', 'decimal', true, 'decimal(12,2)')],
        primaryKey: 'id',
        primaryKeyColumns: ['id'],
        foreignKeys: undefined,
      },
    ]);
  });

  it('uses the mysql2 callback API through .promise()', async () => {
    const callbackConnection = mysqlCallback.createConnection({ uri: MYSQL_URL, database: DB });
    try {
      const adapter = new DatabaseIntrospectionAdapter(callbackConnection, 'mysql', { markSensitiveColumns: ['password'] });
      expect(byName(await adapter.extractSchema()).User).toEqual(EXPECTED[0]);
      await expect(adapter.executeQuery('SELECT displayName FROM `User` WHERE id = ?', [2])).resolves.toEqual([
        { displayName: 'Linus' },
      ]);
    } finally {
      await new Promise((resolve) => callbackConnection.end(resolve));
    }
  });

  it('PrismaAdapter: same schema through $queryRawUnsafe, BigInt converted', async () => {
    const prisma = {
      $queryRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
        const [rows] = await connection.query(sql, values);
        return (rows as Record<string, unknown>[]).map((row) => {
          const out: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(row)) {
            out[key] = typeof value === 'number' && Number.isInteger(value) ? BigInt(value) : value;
          }
          return out;
        });
      }),
    };
    const schema = await new PrismaAdapter(prisma, 'mysql', { markSensitiveColumns: ['password'] }).extractSchema();
    expect(byName(schema)).toEqual(Object.fromEntries(EXPECTED.map((t) => [t.name, t])));
    expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(3);
  });

  it('fixes the nameless tables 0.0.1 returned on MySQL 8+', async () => {
    const before = await new legacy.DatabaseIntrospectionAdapter(connection, 'mysql').extractSchema();
    expect(before.tables.every((table: TableSchema) => table.name === undefined && table.columns.length === 0)).toBe(true);
  });
});
