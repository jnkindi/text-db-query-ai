/**
 * Postgres against a real server: PGlite (Postgres compiled to WASM), for
 * introspection and for the rows row-level security lets through. It runs in
 * one child process (see helpers/pglite-server.js), shared by every test here,
 * and is used through the same `query(sql, params) -> { rows }` contract as pg.
 */

import { DatabaseIntrospectionAdapter, PrismaAdapter } from '../../src/adapters';
import { SecurityValidator } from '../../src/security';
import { DatabaseSchema, TableSchema } from '../../src/types';
import {
  COVERAGE_CONFIG,
  COVERAGE_KEEPS_MEANING,
  COVERAGE_LEAKS,
  coverageSchema,
  coverageSetup,
  Executor,
  expectIsolation,
  expectSameRows,
  ISOLATION_SETUP,
  POSTGRES_COVERAGE_LEAKS,
} from '../fixtures/rls-isolation';
import { startPGlite, PGliteProcess } from './helpers/pglite-process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('text-db-query-ai-legacy');

jest.setTimeout(60000);

const DDL = `
  CREATE SCHEMA billing;
  CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN', 'super-admin');
  CREATE TYPE billing.currency AS ENUM ('EUR', 'USD');

  -- Prisma-style mixed-case names
  CREATE TABLE "User" (
    id serial PRIMARY KEY,
    "displayName" varchar(255) NOT NULL,
    email text,
    role "Role" NOT NULL DEFAULT 'USER',
    roles "Role"[],
    settings jsonb,
    external_id uuid,
    "createdAt" timestamptz(3) NOT NULL DEFAULT now(),
    password_hash text
  );
  COMMENT ON TABLE "User" IS 'A registered account';
  COMMENT ON COLUMN "User"."displayName" IS 'Shown to
    other users';

  -- Reserved word as a table name, and a dropped column
  CREATE TABLE "order" (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "userId" integer NOT NULL REFERENCES "User"(id),
    placed_at timestamp,
    total numeric(10,2)
  );
  ALTER TABLE "order" DROP COLUMN placed_at;

  -- Composite primary key
  CREATE TABLE line_item (
    order_id integer NOT NULL REFERENCES "order"(id),
    line_no smallint NOT NULL,
    qty integer NOT NULL,
    PRIMARY KEY (order_id, line_no)
  );

  -- Second schema, with a table named like one in public
  CREATE TABLE billing.invoice (id serial PRIMARY KEY, amount numeric);
  COMMENT ON TABLE billing.invoice IS 'Issued invoices';
  CREATE TABLE billing.refund (id serial PRIMARY KEY, invoice_id integer REFERENCES billing.invoice(id));

  -- Composite FK, cross-schema FK and an enum from another schema
  CREATE TABLE refund (
    id bigserial PRIMARY KEY,
    order_id integer NOT NULL,
    line_no smallint NOT NULL,
    currency billing.currency,
    invoice_id integer REFERENCES billing.invoice(id),
    FOREIGN KEY (order_id, line_no) REFERENCES line_item(order_id, line_no)
  );

  -- Views are not read, as in 0.0.1
  CREATE VIEW user_emails AS SELECT id, email FROM "User";

  INSERT INTO "User" ("displayName", email) VALUES ('Ada', 'ada@example.com'), ('Linus', NULL);
`;

const column = (name: string, type: string, nullable: boolean, nativeType: string, extra: object = {}) => ({
  name,
  type,
  nullable,
  sensitive: false,
  nativeType,
  ...extra,
});

const ROLE = ['USER', 'ADMIN', 'super-admin'];

const PUBLIC_TABLES: TableSchema[] = [
  {
    name: 'User',
    schema: 'public',
    description: 'A registered account',
    columns: [
      column('id', 'integer', false, 'integer'),
      column('displayName', 'varchar', false, 'varchar(255)', { description: 'Shown to other users' }),
      column('email', 'text', true, 'text'),
      column('role', 'varchar', false, 'Role', { enumValues: ROLE }),
      column('roles', 'varchar', true, 'Role[]', { enumValues: ROLE }),
      column('settings', 'json', true, 'jsonb'),
      column('external_id', 'varchar', true, 'uuid'),
      column('createdAt', 'timestamp', false, 'timestamptz(3)'),
      column('password_hash', 'text', true, 'text', { sensitive: true }),
    ],
    primaryKey: 'id',
    primaryKeyColumns: ['id'],
    foreignKeys: undefined,
  },
  {
    name: 'line_item',
    schema: 'public',
    columns: [
      column('order_id', 'integer', false, 'integer'),
      column('line_no', 'integer', false, 'smallint'),
      column('qty', 'integer', false, 'integer'),
    ],
    primaryKey: 'order_id, line_no',
    primaryKeyColumns: ['order_id', 'line_no'],
    foreignKeys: [{ column: 'order_id', referencedTable: 'order', referencedColumn: 'id' }],
  },
  {
    name: 'order',
    schema: 'public',
    columns: [
      column('id', 'integer', false, 'integer'),
      column('userId', 'integer', false, 'integer'),
      column('total', 'decimal', true, 'numeric(10,2)'),
    ],
    primaryKey: 'id',
    primaryKeyColumns: ['id'],
    foreignKeys: [{ column: 'userId', referencedTable: 'User', referencedColumn: 'id' }],
  },
  {
    name: 'refund',
    schema: 'public',
    columns: [
      column('id', 'integer', false, 'bigint'),
      column('order_id', 'integer', false, 'integer'),
      column('line_no', 'integer', false, 'smallint'),
      column('currency', 'varchar', true, 'billing.currency', { enumValues: ['EUR', 'USD'] }),
      column('invoice_id', 'integer', true, 'integer'),
    ],
    primaryKey: 'id',
    primaryKeyColumns: ['id'],
    // One entry per column pair, the cross-schema target marked, and billing.refund's FK not leaked.
    foreignKeys: [
      { column: 'invoice_id', referencedTable: 'invoice', referencedColumn: 'id', referencedSchema: 'billing' },
      { column: 'order_id', referencedTable: 'line_item', referencedColumn: 'order_id' },
      { column: 'line_no', referencedTable: 'line_item', referencedColumn: 'line_no' },
    ],
  },
];

describe('PGlite (Postgres 18)', () => {
  /** A pg-style connection that records every query. */
  let db: PGliteProcess;

  beforeAll(async () => {
    db = startPGlite();
    await db.exec(DDL);
  });

  beforeEach(() => {
    db.resetQueries();
  });

  afterAll(async () => {
    await db?.close();
  });

  it('extracts the public schema exactly, in 5 queries', async () => {
    const adapter = new DatabaseIntrospectionAdapter(db, 'postgres', { markSensitiveColumns: ['password'] });
    const schema = await adapter.extractSchema();

    expect(schema).toEqual<DatabaseSchema>({ databaseType: 'postgres', tables: PUBLIC_TABLES, exactNames: true });
    expect(db.queries).toHaveLength(5);
  });

  it('reads another schema with the schema option', async () => {
    const schema = await new DatabaseIntrospectionAdapter(db, 'postgres', { schema: 'billing' }).extractSchema();

    expect(schema.tables).toEqual([
      {
        name: 'invoice',
        schema: 'billing',
        description: 'Issued invoices',
        columns: [column('id', 'integer', false, 'integer'), column('amount', 'decimal', true, 'numeric')],
        primaryKey: 'id',
        primaryKeyColumns: ['id'],
        foreignKeys: undefined,
      },
      {
        name: 'refund',
        schema: 'billing',
        columns: [column('id', 'integer', false, 'integer'), column('invoice_id', 'integer', true, 'integer')],
        primaryKey: 'id',
        primaryKeyColumns: ['id'],
        foreignKeys: [{ column: 'invoice_id', referencedTable: 'invoice', referencedColumn: 'id' }],
      },
    ]);
  });

  it('honors includeTables, includeDescriptions and includeEnumValues', async () => {
    const schema = await new DatabaseIntrospectionAdapter(db, 'postgres', {
      includeTables: ['User'],
      includeDescriptions: false,
      includeEnumValues: false,
    }).extractSchema();

    expect(schema.tables.map((t) => t.name)).toEqual(['User']);
    const [user] = schema.tables;
    expect(user.description).toBeUndefined();
    expect(user.columns.find((c) => c.name === 'displayName')?.description).toBeUndefined();
    expect(user.columns.find((c) => c.name === 'role')).toEqual(column('role', 'varchar', false, 'Role'));
    expect(db.queries).toHaveLength(4);
  });

  it('shows only the columns the role may use, like information_schema', async () => {
    await db.exec(`
      CREATE ROLE limited_reader;
      GRANT USAGE ON SCHEMA public TO limited_reader;
      GRANT SELECT (id, email) ON "User" TO limited_reader;
      SET ROLE limited_reader;
    `);
    try {
      const schema = await new DatabaseIntrospectionAdapter(db, 'postgres').extractSchema();
      expect(schema.tables.map((t) => [t.name, t.columns.map((c) => c.name)])).toEqual([
        ['User', ['id', 'email']],
        ['line_item', []],
        ['order', []],
        ['refund', []],
      ]);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  it('reports the same columns and normalized types as 0.0.1, with the keys 0.0.1 got wrong', async () => {
    const before: DatabaseSchema = await new legacy.DatabaseIntrospectionAdapter(db, 'postgres').extractSchema();
    const after = await new DatabaseIntrospectionAdapter(db, 'postgres').extractSchema();

    const shape = (schema: DatabaseSchema) =>
      schema.tables.map((t) => [t.name, t.columns.map((c) => [c.name, c.type, c.nullable, c.sensitive])]);
    expect(shape(after)).toEqual(shape(before));

    // 0.0.1 lost the mixed-case table's PK, truncated the composite PK and cross-joined the composite FK.
    const legacyTable = (name: string) => before.tables.find((t) => t.name === name) as TableSchema;
    expect(legacyTable('User').primaryKey).toBeUndefined();
    expect(legacyTable('line_item').primaryKey).toBe('order_id');
    expect(legacyTable('refund').foreignKeys?.length).toBeGreaterThan(3);
  });

  it('executes queries with bound parameters', async () => {
    const adapter = new DatabaseIntrospectionAdapter(db, 'postgres');
    await expect(adapter.executeQuery('SELECT "displayName" FROM "User" WHERE id = $1', [2])).resolves.toEqual([
      { displayName: 'Linus' },
    ]);
  });

  describe('PrismaAdapter over the same database', () => {
    /** Mimics Prisma's $queryRawUnsafe: positional values, integers as BigInt. */
    const prisma = {
      $queryRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
        const { rows } = await db.query(sql, values);
        return rows.map((row) => {
          const out: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(row)) {
            out[key] = typeof value === 'number' && Number.isInteger(value) ? BigInt(value) : value;
          }
          return out;
        });
      }),
    };

    beforeEach(() => prisma.$queryRawUnsafe.mockClear());

    it('extracts the same schema in 5 queries', async () => {
      const schema = await new PrismaAdapter(prisma, 'postgres', { markSensitiveColumns: ['password'] }).extractSchema();
      expect(schema).toEqual({ databaseType: 'postgres', tables: PUBLIC_TABLES, exactNames: true });
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(5);
      for (const call of prisma.$queryRawUnsafe.mock.calls) expect(call.slice(1)).toEqual(['public']);
    });

    it('binds executeQuery parameters', async () => {
      const rows = await new PrismaAdapter(prisma, 'postgres').executeQuery(
        'SELECT id, "displayName" FROM "User" WHERE email = $1',
        ['ada@example.com']
      );
      expect(rows).toEqual([{ id: BigInt(1), displayName: 'Ada' }]);
    });
  });

  describe('row-level security on Postgres', () => {
    // Each data set lives in its own schema of the shared database; a query runs
    // with search_path pointing at it, then public is restored for the other tests.
    const inSchema = (schema: string): Executor => ({
      run: async (sql) => {
        await db.exec(`SET search_path TO ${schema}`);
        try {
          return (await db.query(sql)).rows;
        } finally {
          await db.exec('SET search_path TO public');
        }
      },
    });
    const load = async (schema: string, statements: string[]) => {
      await db.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}; ${statements.join('; ')}; SET search_path TO public`);
    };

    beforeAll(async () => {
      await load('rls_isolation', ISOLATION_SETUP);
      await load('rls_full', coverageSetup());
      await load('rls_own', coverageSetup(1));
    });

    it('every filtered query returns only user 1', async () => {
      await expectIsolation(inSchema('rls_isolation'), 'postgres');
    });

    const withSchema = new SecurityValidator(COVERAGE_CONFIG, { databaseType: 'postgres', schema: coverageSchema('postgres') });
    const withoutSchema = new SecurityValidator(COVERAGE_CONFIG, { databaseType: 'postgres' });

    it.each([...COVERAGE_LEAKS, ...POSTGRES_COVERAGE_LEAKS, ...COVERAGE_KEEPS_MEANING])('with a schema: %s', async (_name, sql) => {
      await expectSameRows(withSchema, inSchema('rls_full'), inSchema('rls_own'), sql, true);
    });

    it.each([...COVERAGE_LEAKS, ...POSTGRES_COVERAGE_LEAKS])('without a schema: %s', async (_name, sql) => {
      await expectSameRows(withoutSchema, inSchema('rls_full'), inSchema('rls_own'), sql, false);
    });
  });
});
