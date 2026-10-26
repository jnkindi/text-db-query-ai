/**
 * renderForModel() and getDialectRules() review fixes: foreign keys inside a
 * non-default schema (HAL-1), rendering only the allowed tables (PROMPT-1),
 * the SQLite case-folding rule (PROMPT-2), RESTRICTED markers (PROMPT-3) and
 * RETURNING only when writes are allowed (PROMPT-4). generateSchemaPrompt()
 * must not change (src/schema/analyzer.ts).
 */

import { SchemaAnalyzer } from '../../src/schema';
import { DatabaseSchema, DatabaseType, TableSchema } from '../../src/types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('text-db-query-ai-legacy');

describe('HAL-1: foreign keys inside the table own schema', () => {
  const tables = (schema: string): TableSchema[] => [
    {
      name: 'invoice',
      schema,
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'amount', type: 'decimal' },
      ],
      primaryKey: 'id',
    },
    {
      name: 'refund',
      schema,
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'invoice_id', type: 'integer' },
      ],
      primaryKey: 'id',
      // Same-schema FK: referencedSchema omitted, exactly as DatabaseIntrospectionAdapter and parsePrismaSchema emit it.
      foreignKeys: [{ column: 'invoice_id', referencedTable: 'invoice', referencedColumn: 'id' }],
    },
  ];

  const render = (databaseType: DatabaseType, schema: string): string =>
    new SchemaAnalyzer({ databaseType, exactNames: true, tables: tables(schema) }).renderForModel();

  it('postgres: billing.refund -> billing.invoice is written qualified', () => {
    const text = render('postgres', 'billing');
    expect(text).toContain('TABLE billing.invoice');
    expect(text).toContain('invoice_id integer FK -> billing.invoice.id');
  });

  it('mssql: sales.refund -> sales.invoice is written qualified', () => {
    const text = render('mssql', 'sales');
    expect(text).toContain('TABLE sales.invoice');
    expect(text).toContain('invoice_id integer FK -> sales.invoice.id');
  });

  it('default-schema targets stay unqualified', () => {
    expect(render('postgres', 'public')).toContain('invoice_id integer FK -> invoice.id');
    expect(render('mssql', 'dbo')).toContain('invoice_id integer FK -> invoice.id');
    expect(render('mysql', 'shop')).toContain('invoice_id integer FK -> invoice.id');
  });

  it('an explicit referencedSchema still wins', () => {
    const t = tables('billing');
    t[1].foreignKeys = [{ column: 'invoice_id', referencedTable: 'invoice', referencedColumn: 'id', referencedSchema: 'archive' }];
    expect(new SchemaAnalyzer({ databaseType: 'postgres', tables: t }).renderForModel()).toContain('FK -> archive.invoice.id');
  });
});

const SHOP: DatabaseSchema = {
  databaseType: 'postgres',
  tables: [
    {
      name: 'customers',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'country', type: 'text' },
        { name: 'email', type: 'text', sampleValues: ['a@example.com'] },
        { name: 'ssn', type: 'text', sensitive: true },
      ],
    },
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'customer_id', type: 'integer' },
        { name: 'total', type: 'numeric' },
      ],
      foreignKeys: [{ column: 'customer_id', referencedTable: 'customers', referencedColumn: 'id' }],
    },
    {
      name: 'invoices',
      schema: 'billing',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'order_id', type: 'integer' },
      ],
      foreignKeys: [{ column: 'order_id', referencedTable: 'orders', referencedColumn: 'id', referencedSchema: 'public' }],
    },
  ],
};

describe('PROMPT-1: only the allowed tables are rendered', () => {
  const render = (allowedTables: string[], schema: DatabaseSchema = SHOP) =>
    new SchemaAnalyzer(schema).renderForModel({ security: { allowedTables } });

  it('renders every table without allowedTables (or with an empty list)', () => {
    const all = new SchemaAnalyzer(SHOP).renderForModel();
    expect(all).toContain('TABLE customers');
    expect(all).toContain('TABLE billing.invoices');
    expect(new SchemaAnalyzer(SHOP).renderForModel({ security: {} })).toBe(all);
    expect(render([])).toBe(all);
  });

  it('leaves out tables allowedTables does not list, and foreign keys to them', () => {
    const text = render(['orders']);
    expect(text).toBe('TABLE orders\n  id integer\n  customer_id integer\n  total numeric');
    expect(text).not.toContain('customers');
  });

  it('matches like the validator: case-insensitively, unqualified for the default schema, schema.table exactly', () => {
    expect(render(['ORDERS', ' Customers '])).toContain('TABLE customers');
    expect(render(['ORDERS', ' Customers '])).toContain('customer_id integer FK -> customers.id');
    // `invoices` alone names the default schema's table, not billing.invoices
    expect(render(['invoices'])).toBe('(no tables)');
    expect(render(['billing.invoices'])).toBe('TABLE billing.invoices\n  id integer\n  order_id integer');
    expect(render(['billing.invoices', 'public.orders'])).toContain('order_id integer FK -> orders.id');
    expect(render(['public.orders'])).toContain('TABLE orders');
    expect(render(['other.orders'])).toBe('(no tables)');

    const inPublic: DatabaseSchema = {
      databaseType: 'postgres',
      tables: [{ name: 'orders', schema: 'public', columns: [{ name: 'id', type: 'integer' }] }],
    };
    expect(render(['orders'], inPublic)).toContain('TABLE orders');
  });

  it('on MySQL, where the default schema is the connection database, an unqualified entry matches any schema', () => {
    const mysql: DatabaseSchema = {
      databaseType: 'mysql',
      tables: [
        { name: 'orders', schema: 'shop', columns: [{ name: 'id', type: 'int' }] },
        { name: 'users', schema: 'shop', columns: [{ name: 'id', type: 'int' }] },
      ],
    };
    expect(render(['orders'], mysql)).toBe('TABLE orders\n  id int');
    expect(render(['shop.users'], mysql)).toBe('TABLE users\n  id int');
  });

  it('qualifies names only as far as the rendered tables need it', () => {
    const twoSchemas: DatabaseSchema = {
      databaseType: 'postgres',
      tables: [
        { name: 'a', schema: 'public', columns: [{ name: 'id', type: 'integer' }] },
        { name: 'b', schema: 'billing', columns: [{ name: 'id', type: 'integer' }] },
      ],
    };
    expect(new SchemaAnalyzer(twoSchemas).renderForModel()).toMatch(/^TABLE public\.a\n/);
    // Only the public table is allowed, so it is written the way the validator's `a` entry expects.
    expect(render(['a'], twoSchemas)).toBe('TABLE a\n  id integer');
    expect(render(['a', 'billing.b'], twoSchemas)).toBe('TABLE public.a\n  id integer\n\nTABLE billing.b\n  id integer');
  });

  it('leaves getSchema() text (generateSchemaPrompt) and the 0.0.1 methods untouched', () => {
    const analyzer = new SchemaAnalyzer(SHOP);
    analyzer.renderForModel({ security: { allowedTables: ['orders'], restrictedColumns: ['email'] } });
    expect(analyzer.generateSchemaPrompt()).toBe(new legacy.SchemaAnalyzer(SHOP).generateSchemaPrompt());
    expect(analyzer.getSensitiveColumns()).toEqual(new legacy.SchemaAnalyzer(SHOP).getSensitiveColumns());
  });
});

describe('PROMPT-3: restricted columns are marked RESTRICTED', () => {
  const render = (restrictedColumns: string[], restrictedColumnsMatch?: 'contains' | 'exact') =>
    new SchemaAnalyzer(SHOP).renderForModel({ security: { restrictedColumns, restrictedColumnsMatch } });

  it('marks a bare entry in every table and drops its sample values', () => {
    const text = render(['email']);
    expect(text).toContain('  email text RESTRICTED\n');
    expect(text).not.toContain('a@example.com');
    expect(text).toContain('  country text\n');
  });

  it('marks a sensitive restricted column with both markers', () => {
    expect(render(['ssn'])).toContain('  ssn text RESTRICTED SENSITIVE');
    expect(render([])).toContain('  ssn text SENSITIVE');
  });

  it('matches like the validator: contains by default, exact on request, table.column and schema.table.column', () => {
    expect(render(['mail'])).toContain('email text RESTRICTED');
    expect(render(['mail'], 'exact')).not.toContain('RESTRICTED');
    const scoped = render(['orders.id']);
    expect(scoped).toContain('TABLE orders\n  id integer RESTRICTED');
    expect(scoped).toContain('TABLE customers\n  id integer\n');
    expect(render(['billing.invoices.id'])).toContain('TABLE billing.invoices\n  id integer RESTRICTED');
    expect(render(['other.invoices.id'])).not.toContain('RESTRICTED');
  });
});

describe('PROMPT-2: SQLite case-insensitive matching', () => {
  const rules = new SchemaAnalyzer({ databaseType: 'sqlite', tables: [] }).getDialectRules();

  it('does not recommend LOWER() for non-ASCII text', () => {
    expect(rules).not.toMatch(/LOWER\([^)]*\)\s+for other text/i);
    expect(rules).toContain(
      'LIKE and LOWER()/UPPER() fold case for ASCII letters only; for other letters compare the exact value or both spellings.'
    );
  });

  // The fact behind the rule, checked on the real engine when the driver is installed.
  let sqlite3: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sqlite3 = require('sqlite3');
  } catch {
    sqlite3 = undefined;
  }
  (sqlite3 ? it : it.skip)('sqlite lower() leaves non-ASCII letters unchanged', async () => {
    const db = new sqlite3.Database(':memory:');
    const row: any = await new Promise((resolve, reject) =>
      db.get("SELECT lower('ÉCOLE') AS lowered, 'école' LIKE 'ÉCOLE' AS liked", (err: Error | null, r: unknown) =>
        err ? reject(err) : resolve(r)
      )
    );
    await new Promise((resolve) => db.close(resolve));
    expect(row).toEqual({ lowered: 'École', liked: 0 });
  });
});

describe('PROMPT-4: dialect rules follow the allowed operations', () => {
  const rules = (databaseType: DatabaseType, allowedOperations?: Array<'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'>) =>
    new SchemaAnalyzer({ databaseType, tables: [] }).getDialectRules({ allowedOperations });

  it('mentions RETURNING only when INSERT, UPDATE or DELETE is allowed', () => {
    expect(rules('postgres')).not.toContain('RETURNING');
    expect(rules('postgres', ['SELECT'])).not.toContain('RETURNING');
    expect(rules('postgres')).toContain('CTEs (WITH) and JSON operators (->, ->>) are available.');
    expect(rules('postgres', ['SELECT', 'UPDATE'])).toContain('CTEs (WITH), RETURNING and JSON operators (->, ->>) are available.');
  });

  it('warns about integer division where it truncates', () => {
    for (const d of ['postgres', 'sqlite', 'mssql'] as DatabaseType[]) expect(rules(d)).toMatch(/integers truncates/);
    expect(rules('mysql')).not.toMatch(/integers truncates/);
  });
});
