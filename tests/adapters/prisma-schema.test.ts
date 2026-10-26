/**
 * Tests for parsePrismaSchema
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parsePrismaSchema } from '../../src/adapters';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('text-db-query-ai-legacy');

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '..', 'fixtures', 'prisma', name), 'utf8');

describe('parsePrismaSchema', () => {
  it('parses the 0.0.1 sample model correctly (0.0.1 produced a fake "unique" column)', () => {
    const source = fixture('legacy-readme.prisma');

    const before = legacy.parsePrismaSchema(source);
    expect(before.tables[0].name).toBe('user');
    expect(before.tables[0].columns.map((c: any) => c.name)).toEqual(['id', 'email', 'unique']);

    expect(parsePrismaSchema(source)).toEqual({
      databaseType: 'postgres',
      exactNames: true,
      tables: [
        {
          name: 'User',
          columns: [
            { name: 'id', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'email', type: 'varchar', nullable: false, nativeType: 'text' },
            { name: 'name', type: 'varchar', nullable: true, nativeType: 'text' },
          ],
          primaryKey: 'id',
          primaryKeyColumns: ['id'],
        },
      ],
    });
  });

  it('parses the sample schema from the examples, which 0.0.1 got wrong', () => {
    const source = fixture('examples-sample.prisma');

    const before = legacy.parsePrismaSchema(source);
    expect(before.tables.map((t: any) => [t.name, t.primaryKey, t.columns.map((c: any) => c.name)])).toEqual([
      ['user', 'createdAt', ['id', 'email', 'unique', 'String', 'Sensitive', 'orders', 'createdAt']],
      ['order', 'createdAt', ['id', 'userId', 'user', 'total', 'status', 'createdAt']],
    ]);

    expect(parsePrismaSchema(source)).toEqual({
      databaseType: 'postgres',
      exactNames: true,
      tables: [
        {
          name: 'User',
          columns: [
            { name: 'id', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'email', type: 'varchar', nullable: false, nativeType: 'text' },
            { name: 'name', type: 'varchar', nullable: false, nativeType: 'text' },
            { name: 'password', type: 'varchar', nullable: false, nativeType: 'text' },
            { name: 'role', type: 'varchar', nullable: false, nativeType: 'text' },
            { name: 'createdAt', type: 'timestamp', nullable: false, nativeType: 'timestamp(3)' },
          ],
          primaryKey: 'id',
          primaryKeyColumns: ['id'],
        },
        {
          name: 'Order',
          columns: [
            { name: 'id', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'userId', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'total', type: 'decimal', nullable: false, nativeType: 'decimal(65,30)' },
            { name: 'status', type: 'varchar', nullable: false, nativeType: 'text' },
            { name: 'createdAt', type: 'timestamp', nullable: false, nativeType: 'timestamp(3)' },
          ],
          primaryKey: 'id',
          primaryKeyColumns: ['id'],
          foreignKeys: [{ column: 'userId', referencedTable: 'User', referencedColumn: 'id' }],
        },
      ],
    });
  });

  it('handles punctuation inside strings, multi-line attributes and named arguments', () => {
    const expected = {
      databaseType: 'postgres',
      exactNames: true,
      tables: [
        {
          name: 'Note',
          columns: [
            { name: 'id', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'closer', type: 'varchar', nullable: false, nativeType: 'text' },
            { name: 'brace', type: 'varchar', nullable: false, nativeType: 'text', description: 'a closing brace inside a string' },
            { name: 'comma_col', type: 'varchar', nullable: false, nativeType: 'text' },
            { name: 'bracket', type: 'varchar', nullable: false, nativeType: 'varchar(1)' },
            { name: 'quote', type: 'varchar', nullable: false, nativeType: 'text' },
            { name: 'slashes', type: 'varchar', nullable: false, nativeType: 'text' },
            { name: 'tags', type: 'integer', nullable: false, nativeType: 'integer[]' },
            { name: 'owner_id', type: 'integer', nullable: false, nativeType: 'integer' },
          ],
          primaryKey: 'id',
          primaryKeyColumns: ['id'],
          foreignKeys: [{ column: 'owner_id', referencedTable: 'owners', referencedColumn: 'owner_pk' }],
        },
        {
          name: 'owners',
          columns: [
            { name: 'owner_pk', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'org', type: 'varchar', nullable: false, nativeType: 'text' },
          ],
          primaryKey: 'owner_pk, org',
          primaryKeyColumns: ['owner_pk', 'org'],
        },
      ],
    };
    const source = fixture('edge-cases.prisma');

    expect(parsePrismaSchema(source)).toEqual(expected);
    // Windows line endings and a byte order mark change nothing.
    expect(parsePrismaSchema(`﻿${source.replace(/\n/g, '\r\n')}`)).toEqual(expected);
  });

  it('parses the review schema without invented columns', () => {
    const result = parsePrismaSchema(fixture('review-repro.prisma'));
    const summary = result.tables.map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => c.name),
      primaryKey: t.primaryKey,
      foreignKeys: t.foreignKeys,
    }));

    expect(summary).toEqual([
      {
        name: 'users',
        columns: ['id', 'email', 'name', 'role', 'password_hash', 'settings', 'created_at'],
        primaryKey: 'id',
        foreignKeys: undefined,
      },
      {
        name: 'orders',
        columns: ['id', 'user_id', 'total', 'location', 'createdAt'],
        primaryKey: 'id',
        foreignKeys: [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }],
      },
      {
        name: 'OrderItem',
        columns: ['orderId', 'productId', 'quantity'],
        primaryKey: 'orderId, productId',
        foreignKeys: undefined,
      },
    ]);
    expect(result.tables[0].description).toBe('A registered account');
    expect(result.tables[0].columns[3].enumValues).toEqual(['USER', 'ADMIN']);
    expect(result.tables[1].columns[3]).toEqual({
      name: 'location',
      type: 'varchar',
      nullable: true,
      nativeType: 'point',
    });
  });

  it('parses a full PostgreSQL schema', () => {
    expect(parsePrismaSchema(fixture('postgres-full.prisma'))).toEqual({
      databaseType: 'postgres',
      exactNames: true,
      tables: [
        {
          name: 'users',
          description: 'A registered account (one per email address)',
          columns: [
            { name: 'id', type: 'varchar', nullable: false, nativeType: 'uuid' },
            { name: 'email', type: 'varchar', nullable: false, nativeType: 'varchar(255)', description: 'Login email' },
            { name: 'display_name', type: 'varchar', nullable: true, nativeType: 'text' },
            {
              name: 'role',
              type: 'varchar',
              nullable: false,
              nativeType: 'role',
              enumValues: ['USER', 'admin', 'super-admin'],
            },
            {
              name: 'roles',
              type: 'varchar',
              nullable: false,
              nativeType: 'role[]',
              enumValues: ['USER', 'admin', 'super-admin'],
            },
            { name: 'tags', type: 'varchar', nullable: false, nativeType: 'text[]' },
            { name: 'settings', type: 'json', nullable: false, nativeType: 'jsonb' },
            { name: 'type', type: 'varchar', nullable: false, nativeType: 'text', description: 'account kind' },
            { name: 'created_at', type: 'timestamp', nullable: false, nativeType: 'timestamptz(6)' },
            { name: 'updatedAt', type: 'timestamp', nullable: false, nativeType: 'timestamp(3)' },
          ],
          primaryKey: 'id',
          primaryKeyColumns: ['id'],
        },
        {
          name: 'Profile',
          columns: [
            { name: 'user_id', type: 'varchar', nullable: false, nativeType: 'uuid' },
            { name: 'bio', type: 'varchar', nullable: false, nativeType: 'text' },
          ],
          primaryKey: 'user_id',
          primaryKeyColumns: ['user_id'],
          foreignKeys: [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }],
        },
        {
          name: 'Post',
          columns: [
            { name: 'id', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'title', type: 'varchar', nullable: false, nativeType: 'varchar(200)' },
            {
              name: 'status',
              type: 'varchar',
              nullable: false,
              nativeType: 'Status',
              enumValues: ['DRAFT', 'PUBLISHED'],
            },
            { name: 'author_id', type: 'varchar', nullable: false, nativeType: 'uuid' },
            { name: 'price', type: 'decimal', nullable: false, nativeType: 'decimal(10,2)' },
            { name: 'rating', type: 'decimal', nullable: false, nativeType: 'double precision' },
            { name: 'views', type: 'integer', nullable: false, nativeType: 'bigint' },
            { name: 'published', type: 'boolean', nullable: false, nativeType: 'boolean' },
            { name: 'location', type: 'varchar', nullable: true, nativeType: 'geography(Point,4326)' },
          ],
          primaryKey: 'id',
          primaryKeyColumns: ['id'],
          foreignKeys: [{ column: 'author_id', referencedTable: 'users', referencedColumn: 'id' }],
        },
        {
          name: 'comments',
          columns: [
            { name: 'postId', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'line_no', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'body', type: 'varchar', nullable: false, nativeType: 'text' },
          ],
          primaryKey: 'postId, line_no',
          primaryKeyColumns: ['postId', 'line_no'],
          foreignKeys: [{ column: 'postId', referencedTable: 'Post', referencedColumn: 'id' }],
        },
        {
          name: 'Reply',
          columns: [
            { name: 'id', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'comment_post_id', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'comment_line_no', type: 'integer', nullable: false, nativeType: 'integer' },
          ],
          primaryKey: 'id',
          primaryKeyColumns: ['id'],
          // Composite relation: columns paired by position, never a cross product.
          foreignKeys: [
            { column: 'comment_post_id', referencedTable: 'comments', referencedColumn: 'postId' },
            { column: 'comment_line_no', referencedTable: 'comments', referencedColumn: 'line_no' },
          ],
        },
        {
          name: 'PostStats',
          columns: [
            { name: 'postId', type: 'integer', nullable: false, nativeType: 'integer' },
            { name: 'comments', type: 'integer', nullable: false, nativeType: 'integer' },
          ],
          primaryKey: undefined,
          foreignKeys: undefined,
        },
      ],
    });
  });

  it('honors @@schema and sets referencedSchema across schemas', () => {
    expect(parsePrismaSchema(fixture('multi-schema.prisma')).tables).toEqual([
      {
        name: 'Account',
        schema: 'public',
        columns: [{ name: 'id', type: 'integer', nullable: false, nativeType: 'integer' }],
        primaryKey: 'id',
        primaryKeyColumns: ['id'],
      },
      {
        name: 'invoices',
        schema: 'billing',
        columns: [
          { name: 'id', type: 'integer', nullable: false, nativeType: 'integer' },
          { name: 'account_id', type: 'integer', nullable: false, nativeType: 'integer' },
        ],
        primaryKey: 'id',
        primaryKeyColumns: ['id'],
        foreignKeys: [
          { column: 'account_id', referencedTable: 'Account', referencedColumn: 'id', referencedSchema: 'public' },
        ],
      },
    ]);
  });

  it('uses MySQL native types and enum definitions', () => {
    expect(parsePrismaSchema(fixture('mysql.prisma'))).toEqual({
      databaseType: 'mysql',
      exactNames: true,
      tables: [
        {
          name: 'Product',
          columns: [
            { name: 'id', type: 'integer', nullable: false, nativeType: 'int unsigned' },
            { name: 'sku', type: 'varchar', nullable: false, nativeType: 'varchar(191)' },
            {
              name: 'size',
              type: 'varchar',
              nullable: true,
              nativeType: "enum('s','it''s large')",
              enumValues: ['s', "it's large"],
            },
            { name: 'title', type: 'varchar', nullable: false, nativeType: 'varchar(100)' },
            { name: 'body', type: 'varchar', nullable: true, nativeType: 'longtext' },
            { name: 'price', type: 'decimal', nullable: false, nativeType: 'decimal(8,2)' },
            { name: 'active', type: 'boolean', nullable: false, nativeType: 'tinyint(1)' },
            { name: 'addedAt', type: 'timestamp', nullable: false, nativeType: 'datetime(3)' },
            { name: 'blob', type: 'varchar', nullable: true, nativeType: 'longblob' },
          ],
          primaryKey: 'id',
          primaryKeyColumns: ['id'],
        },
      ],
    });
  });

  it('writes MySQL enum values the way COLUMN_TYPE does', () => {
    const result = parsePrismaSchema(`
      datasource db {
        provider = "mysql"
      }
      enum Path {
        WIN  @map("C:\\\\temp")
        HOME @map("it's ~")
      }
      model F {
        id   Int  @id
        path Path
      }
    `);
    expect(result.tables[0].columns[1]).toEqual({
      name: 'path',
      type: 'varchar',
      nullable: false,
      nativeType: "enum('C:\\\\temp','it''s ~')",
      enumValues: ['C:\\temp', "it's ~"],
    });
  });

  it('maps the datasource provider as 0.0.1 did', () => {
    const model = 'model T {\n  id Int @id\n  s String\n}\n';
    const withProvider = (provider: string) =>
      parsePrismaSchema(`datasource db {\n  provider = "${provider}"\n}\n${model}`);

    expect(withProvider('postgresql').databaseType).toBe('postgres');
    expect(withProvider('mysql').databaseType).toBe('mysql');
    expect(withProvider('sqlite').databaseType).toBe('sqlite');
    expect(withProvider('sqlserver').databaseType).toBe('mssql');
    expect(withProvider('cockroachdb').databaseType).toBe('postgres');
    expect(parsePrismaSchema(model).databaseType).toBe('postgres');

    expect(withProvider('sqlite').tables[0].columns.map((c) => c.nativeType)).toEqual(['INTEGER', 'TEXT']);
    expect(withProvider('sqlserver').tables[0].columns.map((c) => c.nativeType)).toEqual([
      'int',
      'nvarchar(1000)',
    ]);
  });

  it('keeps the old type mapping for every Prisma scalar', () => {
    const source = `model T {
      a Int
      b BigInt
      c String
      d Boolean
      e DateTime
      f Float
      g Decimal
      h Json
      i Bytes
    }`;
    const types = parsePrismaSchema(source).tables[0].columns.map((c) => c.type);
    const legacyTypes = legacy.parsePrismaSchema(source).tables[0].columns.map((c: any) => c.type);

    expect(types).toEqual(['integer', 'integer', 'varchar', 'boolean', 'timestamp', 'decimal', 'decimal', 'json', 'varchar']);
    expect(types).toEqual(legacyTypes);
  });

  it('never throws on malformed input', () => {
    const inputs = [
      '',
      'garbage { model } model X { a Int @default(\n',
      'model { }',
      'model A {\n  name String @default("unterminated\n  other Int\n}',
      'model A {\n  @@id([\n',
      '}}}{{{',
      'enum E { A B',
      'model B {\n  ok Int @id\n  ?? !!\n  also String\n}',
    ];
    for (const input of inputs) {
      expect(() => parsePrismaSchema(input)).not.toThrow();
    }

    const recovered = parsePrismaSchema('model B {\n  ok Int @id\n  ?? !!\n  also String\n}');
    expect(recovered.tables[0].columns.map((c) => c.name)).toEqual(['ok', 'also']);
    expect(parsePrismaSchema('model A {\n  name String @default("unterminated\n  other Int\n}').tables[0].columns.map((c) => c.name)).toEqual(['name', 'other']);
  });

  it('skips relation fields that have no foreign key side', () => {
    const result = parsePrismaSchema(`
      model A {
        id Int    @id
        bs B[]
        c  C?
      }
      model B {
        id  Int @id
        aId Int
        a   A   @relation(fields: [aId], references: [id])
      }
      model C {
        id  Int @id
        aId Int @unique
        a   A   @relation(fields: [aId], references: [id])
      }
    `);
    expect(result.tables.map((t) => [t.name, t.columns.map((c) => c.name), t.foreignKeys?.length ?? 0])).toEqual([
      ['A', ['id'], 0],
      ['B', ['id', 'aId'], 1],
      ['C', ['id', 'aId'], 1],
    ]);
  });
});
