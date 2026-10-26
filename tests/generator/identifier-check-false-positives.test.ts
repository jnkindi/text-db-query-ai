/**
 * Valid dialect syntax that checkIdentifiers() used to report as unknown
 * tables or columns (review findings FP-1 to FP-4). In the default 'retry'
 * mode every false positive costs a correction call and can change
 * result.query of a query that needed no fix, so each case also checks that a
 * real unknown name next to the construct is still reported.
 * (src/generator/identifier-check.ts, src/sql/analyze.ts)
 */

import { checkIdentifiers, IdentifierIssue } from '../../src/generator/identifier-check';
import { DatabaseSchema, DatabaseType } from '../../src/types';

const labels = (issues: IdentifierIssue[]) => issues.map((i) => `${i.kind}:${i.name}`);

describe('FP-1: valid T-SQL', () => {
  const schema: DatabaseSchema = {
    databaseType: 'mssql',
    tables: [
      ['orders', 'id customer_id status total created_at'],
      ['customers', 'id first_name last_name country'],
      ['products', 'id name price description'],
    ].map(([name, cols]) => ({ name, columns: cols.split(' ').map((c) => ({ name: c, type: 'text' })) })),
  };

  const VALID_TSQL = [
    // (MAX) length of a type
    "SELECT STRING_AGG(CAST(name AS NVARCHAR(MAX)), ', ') FROM products",
    'SELECT CONVERT(VARCHAR(MAX), description) FROM products',
    'SELECT TRY_CONVERT(NVARCHAR(MAX), description, 1) FROM products',
    'SELECT CAST(total AS VARBINARY(MAX)) FROM orders',
    // `alias = expression` select items
    'SELECT TotalSales = SUM(total), status FROM orders GROUP BY status',
    'SELECT [Total Sales] = SUM(total) FROM orders',
    "SELECT full_name = c.first_name + ' ' + c.last_name FROM customers c",
    'SELECT id, Doubled = total * 2 FROM orders WHERE id IN (SELECT Latest = MAX(id) FROM orders)',
    // FOR JSON / FOR XML options
    'SELECT id, total FROM orders FOR JSON PATH',
    "SELECT id, total FROM orders FOR JSON PATH, ROOT('orders')",
    'SELECT id, total FROM orders FOR JSON AUTO',
    'SELECT id, total FROM orders FOR JSON PATH, INCLUDE_NULL_VALUES, WITHOUT_ARRAY_WRAPPER',
    "SELECT id FROM orders FOR XML RAW('order'), ELEMENTS XSINIL, ROOT('orders')",
    "SELECT STUFF((SELECT ',' + p.name FROM products p FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 1, '')",
    // PIVOT value list, UNPIVOT output columns
    'SELECT * FROM (SELECT status, total FROM orders) src PIVOT (SUM(total) FOR status IN ([paid], [new])) AS p',
    'SELECT p.[paid] FROM (SELECT status, total FROM orders) src PIVOT (SUM(total) FOR status IN ([paid])) p',
    'SELECT u.amount, u.kind FROM (SELECT id, price, id AS other FROM products) s UNPIVOT (amount FOR kind IN (price, other)) AS u',
  ];

  it.each(VALID_TSQL)('%s', (sql) => {
    expect(checkIdentifiers(sql, schema)).toEqual([]);
  });

  it('still reports genuinely unknown columns next to these constructs', () => {
    expect(labels(checkIdentifiers('SELECT CAST(nope AS NVARCHAR(MAX)) FROM products', schema))).toEqual(['unknown_column:nope']);
    expect(labels(checkIdentifiers('SELECT CONVERT(VARCHAR(MAX), nope) FROM products', schema))).toEqual(['unknown_column:nope']);
    expect(labels(checkIdentifiers('SELECT TotalSales = SUM(totl) FROM orders', schema))).toEqual(['unknown_column:totl']);
    expect(labels(checkIdentifiers('SELECT nope FROM orders FOR JSON PATH', schema))).toEqual(['unknown_column:nope']);
    expect(labels(checkIdentifiers("SELECT o.nope FROM orders o FOR XML PATH(''), TYPE", schema))).toEqual(['unknown_column:nope']);
    expect(
      labels(checkIdentifiers('SELECT * FROM (SELECT status, total FROM orders) src PIVOT (SUM(totl) FOR status IN ([paid])) AS p', schema))
    ).toEqual(['unknown_column:totl']);
  });

  it('reads `a = b` at the start of a select item as a comparison outside SQL Server', () => {
    const postgres: DatabaseSchema = { ...schema, databaseType: 'postgres' };
    expect(labels(checkIdentifiers('SELECT amount = 5 FROM orders', postgres))).toEqual(['unknown_column:amount']);
    expect(labels(checkIdentifiers('SELECT status = 5, MAX(nope) FROM orders', postgres))).toEqual(['unknown_column:nope']);
  });
});

describe('FP-2: system catalogs', () => {
  const schema = (databaseType: DatabaseType): DatabaseSchema => ({
    databaseType,
    tables: [{ name: 'orders', columns: [{ name: 'id', type: 'int' }, { name: 'total', type: 'decimal' }] }],
  });

  it('skips SQL Server sys.* views', () => {
    expect(checkIdentifiers('SELECT name FROM sys.tables', schema('mssql'))).toEqual([]);
    expect(
      checkIdentifiers('SELECT t.name, c.name FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id', schema('mssql'))
    ).toEqual([]);
    expect(checkIdentifiers('SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES', schema('mssql'))).toEqual([]);
  });

  it('skips the MySQL performance_schema, mysql and sys schemas', () => {
    expect(checkIdentifiers('SELECT digest_text FROM performance_schema.events_statements_summary_by_digest', schema('mysql'))).toEqual([]);
    expect(checkIdentifiers('SELECT user, host FROM mysql.user', schema('mysql'))).toEqual([]);
    expect(checkIdentifiers('SELECT * FROM sys.schema_unused_indexes', schema('mysql'))).toEqual([]);
  });

  it('still reports unknown user tables, and sys.* where sys is not a catalog', () => {
    expect(labels(checkIdentifiers('SELECT id FROM dbo.ordrs', schema('mssql')))).toEqual(['unknown_table:ordrs']);
    expect(labels(checkIdentifiers('SELECT id FROM shop.ordrs', schema('mysql')))).toEqual(['unknown_table:ordrs']);
    expect(labels(checkIdentifiers('SELECT name FROM sys.tables', schema('postgres')))).toEqual(['unknown_table:tables']);
    // Unqualified pg_* names stay reported (pinned in identifier-check.test.ts).
    expect(labels(checkIdentifiers('SELECT tablename FROM pg_tables', schema('postgres')))).toEqual(['unknown_table:pg_tables']);
  });
});

describe('FP-3: qualified pseudo-columns', () => {
  const schema = (databaseType: DatabaseType): DatabaseSchema => ({
    databaseType,
    tables: [
      { name: 'orders', columns: [{ name: 'id', type: 'integer' }, { name: 'total', type: 'integer' }] },
      { name: 'events', columns: [{ name: 'payload', type: 'text' }] },
    ],
  });

  it('sqlite: t.rowid, t._rowid_, t.oid', () => {
    expect(checkIdentifiers('SELECT rowid FROM orders', schema('sqlite'))).toEqual([]); // already accepted
    expect(checkIdentifiers('SELECT o.rowid FROM orders o', schema('sqlite'))).toEqual([]);
    expect(checkIdentifiers('SELECT e.rowid, e.payload FROM events e ORDER BY e.rowid DESC LIMIT 5', schema('sqlite'))).toEqual([]);
    expect(checkIdentifiers('SELECT e._rowid_, e.oid FROM events e JOIN orders o ON o.id = e.rowid', schema('sqlite'))).toEqual([]);
  });

  it('postgres: t.ctid, t.xmin, t.tableoid', () => {
    expect(checkIdentifiers('SELECT o.ctid, o.xmin, o.xmax, o.cmin, o.cmax, o.tableoid::regclass FROM orders o', schema('postgres'))).toEqual(
      []
    );
  });

  it('still reports unknown qualified columns, and pseudo-columns of another dialect', () => {
    expect(checkIdentifiers('SELECT o.rowid, o.nope FROM orders o', schema('sqlite')).map((i) => i.name)).toEqual(['nope']);
    expect(checkIdentifiers('SELECT o.rowid FROM orders o', schema('postgres')).map((i) => i.name)).toEqual(['rowid']);
    expect(checkIdentifiers('SELECT o.ctid FROM orders o', schema('sqlite')).map((i) => i.name)).toEqual(['ctid']);
    expect(checkIdentifiers('SELECT o.rowid FROM orders o', schema('mssql')).map((i) => i.name)).toEqual(['rowid']);
  });
});

describe('FP-4: index hints, MEMBER OF and OUTPUT', () => {
  const schema = (databaseType: DatabaseType): DatabaseSchema => ({
    databaseType,
    tables: [
      { name: 'orders', columns: ['id', 'status', 'total', 'metadata', 'user_id'].map((name) => ({ name, type: 'text' })) },
      { name: 'users', columns: ['id', 'email'].map((name) => ({ name, type: 'text' })) },
    ],
  });

  const CASES: Array<[DatabaseType, string]> = [
    ['mysql', "SELECT id FROM orders USE INDEX (idx_status) WHERE status = 'paid'"],
    ['mysql', "SELECT id FROM orders FORCE INDEX (idx_status) WHERE status = 'paid'"],
    ['mysql', 'SELECT id FROM orders IGNORE KEY (idx_status, idx_total) ORDER BY total'],
    ['mysql', 'SELECT o.id FROM orders o USE INDEX FOR JOIN (idx_user) JOIN users u ON u.id = o.user_id'],
    ['mysql', 'SELECT id FROM orders FORCE INDEX FOR ORDER BY (idx_total) ORDER BY total LIMIT 5'],
    ['mysql', 'SELECT id FROM orders USE INDEX (idx_status), IGNORE INDEX (idx_total) WHERE status = 1'],
    ['mysql', 'SELECT o.id, u.email FROM orders o USE INDEX (idx_user), users u WHERE u.id = o.user_id'],
    ['sqlite', "SELECT id FROM orders INDEXED BY idx_status WHERE status = 'x'"],
    ['sqlite', "SELECT o.id FROM orders o INDEXED BY idx_status JOIN users u NOT INDEXED ON u.id = o.user_id"],
    ['mssql', "SELECT id FROM orders o WITH (NOLOCK, INDEX(ix_status)) WHERE o.status = 'x'"],
    ['mssql', "SELECT id FROM orders WITH (INDEX(ix_status, ix_total)) WHERE status = 'x'"],
    ['mssql', "SELECT id FROM orders WITH (INDEX = ix_status) WHERE status = 'x'"],
    ['mssql', "SELECT id FROM orders WITH (FORCESEEK (ix_status (status))) WHERE status = 'x'"],
    ['mssql', "SELECT id FROM orders (NOLOCK, INDEX(ix_status)) WHERE status = 'x'"],
    ['mysql', "SELECT id FROM orders WHERE 5 MEMBER OF (metadata->'$.ids')"],
    ['mssql', "UPDATE orders SET status = 'x' OUTPUT inserted.id, deleted.status WHERE id = 1"],
    ['mssql', 'DELETE FROM orders OUTPUT deleted.* WHERE id = 1'],
    ['mssql', "INSERT INTO orders (id, status) OUTPUT INSERTED.id VALUES (1, 'x')"],
  ];

  it.each(CASES)('[%s] %s', (dialect, sql) => {
    expect(checkIdentifiers(sql, schema(dialect))).toEqual([]);
  });

  it('still reports unknown columns next to hints and operators', () => {
    expect(labels(checkIdentifiers('SELECT nope FROM orders USE INDEX (idx_status)', schema('mysql')))).toEqual(['unknown_column:nope']);
    expect(labels(checkIdentifiers('SELECT id FROM orders INDEXED BY idx_status WHERE nope = 1', schema('sqlite')))).toEqual([
      'unknown_column:nope',
    ]);
    expect(labels(checkIdentifiers('SELECT o.nope FROM orders o WITH (NOLOCK, INDEX(ix_status))', schema('mssql')))).toEqual([
      'unknown_column:nope',
    ]);
    expect(labels(checkIdentifiers('SELECT id FROM orders WHERE 5 MEMBER OF (nope)', schema('mysql')))).toEqual(['unknown_column:nope']);
    expect(
      labels(checkIdentifiers("UPDATE orders SET status = 'x' OUTPUT inserted.id WHERE nope = 1", schema('mssql')))
    ).toEqual(['unknown_column:nope']);
  });

  it('still reports a column named like a hint word where it is a column', () => {
    expect(labels(checkIdentifiers('SELECT member FROM orders', schema('mysql')))).toEqual(['unknown_column:member']);
    expect(labels(checkIdentifiers('SELECT output FROM orders', schema('mssql')))).toEqual(['unknown_column:output']);
  });
});
