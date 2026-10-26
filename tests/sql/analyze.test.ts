/**
 * Tests for analyzeSql(): operation, statements, nested statements, tables,
 * CTEs, aliases and functions (src/sql/analyze.ts)
 */

import {
  analyzeSql,
  findTopLevel,
  significantTokens,
  splitStatements,
  SqlAnalysis,
  TableReference,
} from '../../src/sql/analyze';
import { SqlDialect, SqlLexError, tokenize } from '../../src/sql/lexer';

/** Tables as "[catalog.]schema.name alias" strings, for compact assertions. */
function tables(sql: string, dialect: SqlDialect = 'postgres'): string[] {
  return analyzeSql(sql, dialect).tables.map(fmt);
}

function fmt(t: TableReference): string {
  const parts = [t.catalog !== undefined ? `${t.catalog}.` : '', t.schema !== undefined ? `${t.schema}.` : '', t.name];
  return parts.join('') + (t.alias !== undefined ? ` ${t.alias}` : '');
}

function op(sql: string, dialect: SqlDialect = 'postgres'): SqlAnalysis['operation'] {
  return analyzeSql(sql, dialect).operation;
}

describe('analyzeSql: operation', () => {
  it('detects plain statements', () => {
    expect(op('SELECT 1')).toBe('SELECT');
    expect(op('select * from t')).toBe('SELECT');
    expect(op('INSERT INTO t (a) VALUES (1)')).toBe('INSERT');
    expect(op('UPDATE t SET a = 1')).toBe('UPDATE');
    expect(op('DELETE FROM t')).toBe('DELETE');
    expect(op('  \n SELECT 1')).toBe('SELECT');
    expect(op('/* lead */ SELECT 1')).toBe('SELECT');
  });

  it('resolves WITH to the main statement', () => {
    expect(op('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('SELECT');
    expect(op('WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 5) SELECT n FROM t')).toBe('SELECT');
    expect(op('WITH a AS (SELECT 1), b AS (SELECT 2), c (x, y) AS (SELECT 3, 4) SELECT * FROM a, b, c')).toBe('SELECT');
    expect(op('WITH a AS MATERIALIZED (SELECT 1), b AS NOT MATERIALIZED (SELECT 2) SELECT * FROM a, b')).toBe('SELECT');
    expect(op('WITH x AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM x)')).toBe('DELETE');
    expect(op('WITH x AS (SELECT 1) UPDATE t SET a = 1')).toBe('UPDATE');
    expect(op('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe('INSERT');
    expect(op('WITH x AS (SELECT 1) (SELECT * FROM x)')).toBe('SELECT');
  });

  it('resolves a Postgres SEARCH / CYCLE clause', () => {
    expect(
      op(
        'WITH RECURSIVE t(id, parent) AS (SELECT id, parent FROM nodes UNION ALL SELECT n.id, n.parent FROM nodes n JOIN t ON n.parent = t.id) CYCLE id SET is_cycle USING path SELECT * FROM t'
      )
    ).toBe('SELECT');
    expect(
      op(
        'WITH RECURSIVE t AS (SELECT 1 AS id) SEARCH DEPTH FIRST BY id SET ordercol SELECT * FROM t ORDER BY ordercol'
      )
    ).toBe('SELECT');
  });

  it('skips leading parentheses', () => {
    expect(op('(SELECT 1)')).toBe('SELECT');
    expect(op('((SELECT id FROM a) UNION (SELECT id FROM b)) LIMIT 5')).toBe('SELECT');
    expect(op('(SELECT id FROM a) UNION (SELECT id FROM b) LIMIT 5')).toBe('SELECT');
    expect(op('(DELETE FROM users)')).toBe('DELETE');
  });

  it('returns null for statements that are not SELECT/INSERT/UPDATE/DELETE', () => {
    expect(op("VALUES (1, 'a'), (2, 'b')")).toBeNull();
    expect(op('TABLE users')).toBeNull();
    expect(op('MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE')).toBeNull();
    expect(op('REPLACE INTO t VALUES (1)', 'mysql')).toBeNull();
    expect(op('EXPLAIN SELECT 1')).toBeNull();
    expect(op('DROP TABLE users')).toBeNull();
    expect(op("COPY users TO PROGRAM 'curl evil'")).toBeNull();
    expect(op('WITH garbage')).toBeNull();
    expect(op('')).toBeNull();
    expect(op(';;')).toBeNull();
    expect(op('42')).toBeNull();
  });

  it('uses statement 0 when there are several', () => {
    const a = analyzeSql('SELECT 1; DELETE FROM users;');
    expect(a.operation).toBe('SELECT');
    expect(a.statements).toHaveLength(2);
    expect(a.tables.map((t) => t.name)).toEqual(['users']);
  });
});

describe('analyzeSql: statements and comments', () => {
  it('drops trailing and empty statements', () => {
    expect(analyzeSql('SELECT 1;').statements).toHaveLength(1);
    expect(analyzeSql(';SELECT 1;;').statements).toHaveLength(1);
    expect(analyzeSql('SELECT 1; SELECT 2').statements).toHaveLength(2);
    expect(analyzeSql('').statements).toEqual([]);
  });

  it('does not split on ; inside strings, identifiers or comments', () => {
    expect(analyzeSql("SELECT 'a; b', \"c;d\" -- e; f").statements).toHaveLength(1);
    expect(analyzeSql('SELECT $$a; b$$', 'postgres').statements).toHaveLength(1);
    expect(analyzeSql('SELECT [a;b] FROM t', 'mssql').statements).toHaveLength(1);
  });

  it('splits on ; inside parentheses too (conservative)', () => {
    expect(analyzeSql('SELECT (1; DROP TABLE x)').statements).toHaveLength(2);
  });

  it('statements hold significant tokens only, tokens hold everything', () => {
    const a = analyzeSql('SELECT /* c */ 1 -- d');
    expect(a.hasComments).toBe(true);
    expect(a.statements[0].map((t) => t.text)).toEqual(['SELECT', '1']);
    expect(a.tokens.map((t) => t.text).join('')).toBe('SELECT /* c */ 1 -- d');
    expect(analyzeSql('SELECT 1').hasComments).toBe(false);
  });

  it('throws SqlLexError on unterminated input', () => {
    expect(() => analyzeSql("SELECT 'x")).toThrow(SqlLexError);
  });

  it('passes the backslash mode to the lexer', () => {
    const sql = "SELECT 'a\\'; DROP TABLE x; -- '";
    expect(analyzeSql(sql, 'mysql').statements).toHaveLength(1);
    expect(analyzeSql(sql, 'mysql', { backslashEscapes: false }).statements).toHaveLength(2);
  });
});

describe('analyzeSql: nestedStatements', () => {
  it('finds DML in writable CTEs', () => {
    expect(analyzeSql('WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d').nestedStatements).toEqual([
      { keyword: 'DELETE', start: 11 },
    ]);
    expect(analyzeSql('WITH x AS (UPDATE users SET a=1 RETURNING *) SELECT * FROM x').nestedStatements.map((s) => s.keyword)).toEqual(['UPDATE']);
    expect(analyzeSql('WITH x AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM x').nestedStatements.map((s) => s.keyword)).toEqual(['INSERT']);
    expect(analyzeSql('WITH a AS (SELECT 1), b AS NOT MATERIALIZED (DELETE FROM t) SELECT 1').nestedStatements.map((s) => s.keyword)).toEqual(['DELETE']);
  });

  it('finds a statement right after a leading (', () => {
    expect(analyzeSql('(DELETE FROM users)').nestedStatements).toEqual([{ keyword: 'DELETE', start: 1 }]);
    expect(analyzeSql('SELECT * FROM (MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE) x').nestedStatements.map((s) => s.keyword)).toEqual(['MERGE']);
  });

  it('finds the main statement of a nested WITH', () => {
    expect(analyzeSql('SELECT * FROM (WITH x AS (SELECT 1) DELETE FROM t RETURNING *) y').nestedStatements.map((s) => s.keyword)).toEqual(['DELETE']);
  });

  it('ignores subqueries, functions and columns named like statements', () => {
    expect(analyzeSql('SELECT (SELECT 1), REPLACE(name, a, b), (load + 1), (lock IS NULL), (copy) FROM t').nestedStatements).toEqual([]);
    expect(analyzeSql('SELECT * FROM t WHERE x IN (call, set)').nestedStatements).toEqual([]);
  });
});

describe('analyzeSql: tables', () => {
  it('reads comma joins', () => {
    expect(tables('SELECT * FROM allowed, secret')).toEqual(['allowed', 'secret']);
    expect(tables('SELECT * FROM a x, b AS y, c')).toEqual(['a x', 'b y', 'c']);
  });

  it('reads every JOIN form', () => {
    expect(
      tables(
        'SELECT * FROM a JOIN b ON a.id = b.id INNER JOIN c ON true LEFT JOIN d ON true LEFT OUTER JOIN e ON true ' +
          'RIGHT JOIN f ON true RIGHT OUTER JOIN g ON true FULL JOIN h ON true FULL OUTER JOIN i ON true CROSS JOIN j NATURAL JOIN k'
      )
    ).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']);
    expect(tables('SELECT * FROM a STRAIGHT_JOIN b ON a.id = b.id', 'mysql')).toEqual(['a', 'b']);
    expect(tables('SELECT * FROM a CROSS APPLY dbo.fn(a.id) f OUTER APPLY (SELECT * FROM b) x', 'mssql')).toEqual(['a', 'b']);
  });

  it('reads tables after a join condition that contains CASE ... END', () => {
    expect(tables('SELECT * FROM a JOIN b ON b.x = CASE WHEN a.y = 1 THEN 2 ELSE 3 END, c')).toEqual(['a', 'b', 'c']);
    expect(tables('SELECT * FROM a JOIN b ON a.t::timestamp with time zone = b.t, c')).toEqual(['a', 'b', 'c']);
  });

  it('handles LATERAL and ONLY', () => {
    expect(tables('SELECT * FROM users u CROSS JOIN LATERAL (SELECT * FROM orders o WHERE o.uid = u.id) l')).toEqual(['users u', 'orders o']);
    expect(tables('SELECT * FROM ONLY parent p, LATERAL unnest(p.tags) t(tag)')).toEqual(['parent p']);
    expect(tables('UPDATE ONLY t SET a = 1')).toEqual(['t']);
  });

  it('reads schema-qualified and three-part names', () => {
    expect(analyzeSql('SELECT * FROM public.users').tables[0]).toMatchObject({ name: 'users', schema: 'public', quoted: false });
    expect(analyzeSql('SELECT * FROM [db].[dbo].[Users] u', 'mssql').tables[0]).toMatchObject({
      name: 'Users',
      schema: 'dbo',
      catalog: 'db',
      alias: 'u',
      quoted: true,
    });
    const dbdot = analyzeSql('SELECT * FROM db..t', 'mssql').tables[0];
    expect(dbdot).toMatchObject({ name: 't', catalog: 'db' });
    expect(dbdot.schema).toBeUndefined();
    expect(tables('SELECT * FROM srv.db.dbo.t', 'mssql')).toEqual(['srv.db.dbo.t']);
  });

  it('keeps the original case of quoted names', () => {
    expect(analyzeSql('SELECT * FROM "User" AS "u"').tables[0]).toMatchObject({ name: 'User', alias: 'u', quoted: true });
    expect(analyzeSql('SELECT * FROM `shop`.`Orders` o', 'mysql').tables[0]).toMatchObject({ name: 'Orders', schema: 'shop', alias: 'o', quoted: true });
    expect(analyzeSql('SELECT * FROM [Order Details]', 'mssql').tables[0]).toMatchObject({ name: 'Order Details', quoted: true });
    expect(analyzeSql('SELECT * FROM MyTable').tables[0]).toMatchObject({ name: 'MyTable', quoted: false });
  });

  it('records start/end offsets of the qualified name', () => {
    const sql = 'SELECT * FROM public."User" u';
    const t = analyzeSql(sql).tables[0];
    expect(sql.slice(t.start, t.end)).toBe('public."User"');
  });

  it('reads aliases with and without AS', () => {
    expect(tables('SELECT * FROM users AS u JOIN orders o ON o.uid = u.id')).toEqual(['users u', 'orders o']);
    expect(tables('SELECT * FROM users "Who"')).toEqual(['users Who']);
    expect(tables('SELECT * FROM users WHERE id = 1')).toEqual(['users']);
  });

  it('reads derived tables as their inner tables', () => {
    const a = analyzeSql('SELECT s.n FROM (SELECT count(*) AS n FROM orders) AS s');
    expect(a.tables.map(fmt)).toEqual(['orders']);
    expect(a.aliases).toEqual(expect.arrayContaining(['s', 'n']));
    expect(tables('SELECT * FROM ((SELECT 1 FROM a) UNION (SELECT 2 FROM b)) x')).toEqual(['a', 'b']);
    expect(tables('SELECT * FROM (VALUES (1), (2)) AS v(x)')).toEqual([]);
  });

  it('reads parenthesized joins', () => {
    expect(tables('SELECT * FROM (a JOIN b ON a.id = b.id) j, c')).toEqual(['a', 'b', 'c']);
    expect(tables('SELECT * FROM ((a JOIN b ON true) JOIN c ON true)')).toEqual(['a', 'b', 'c']);
  });

  it('excludes table functions', () => {
    expect(tables('SELECT * FROM generate_series(1, 10) AS g(d)')).toEqual([]);
    expect(tables('SELECT * FROM users u, unnest(u.tags) WITH ORDINALITY AS t(tag, n)')).toEqual(['users u']);
    expect(tables("SELECT value FROM json_each('[1,2,3]')", 'sqlite')).toEqual([]);
    expect(tables("SELECT * FROM JSON_TABLE(doc, '$[*]' COLUMNS (a INT PATH '$.a')) AS jt", 'mysql')).toEqual([]);
    expect(tables('SELECT * FROM pg_catalog.pg_ls_dir(\'.\')')).toEqual([]);
    const a = analyzeSql("SELECT * FROM dblink('host=x', 'DELETE FROM t') AS t(a int)");
    expect(a.tables).toEqual([]);
    expect(a.functions).toContain('DBLINK');
  });

  it('treats the deprecated T-SQL hint form as a table, not a function', () => {
    expect(tables('SELECT id FROM secret (NOLOCK)', 'mssql')).toEqual(['secret']);
    const hinted = analyzeSql('SELECT id FROM secret s (NOLOCK, INDEX(ix))', 'mssql');
    expect(hinted.tables.map(fmt)).toEqual(['secret s']);
    expect(hinted.aliases).toEqual(['s']);
    expect(tables('SELECT id FROM orders WITH (NOLOCK) WHERE x = 1', 'mssql')).toEqual(['orders']);
  });

  it('excludes CTE names', () => {
    const a = analyzeSql('WITH m AS (SELECT user_id FROM orders) SELECT * FROM users u JOIN m ON m.user_id = u.id');
    expect(a.tables.map(fmt)).toEqual(['orders', 'users u']);
    expect(a.cteNames).toEqual(['m']);
    expect(tables('WITH RECURSIVE tree AS (SELECT id FROM c UNION ALL SELECT c.id FROM c JOIN tree t ON c.p = t.id) SELECT * FROM tree')).toEqual(['c', 'c']);
  });

  it('scopes CTE names correctly', () => {
    // Inside a non-recursive CTE body its own name is the real table
    expect(tables('WITH users AS (SELECT * FROM users WHERE active) SELECT * FROM users')).toEqual(['users']);
    // A CTE inside a subquery does not hide a table outside it
    expect(tables('SELECT * FROM (WITH secret AS (SELECT 1) SELECT * FROM secret) a, secret')).toEqual(['secret']);
    // Earlier CTEs are visible in later CTE bodies, later ones are not visible in earlier bodies
    expect(tables('WITH a AS (SELECT * FROM b), b AS (SELECT * FROM a) SELECT * FROM a, b')).toEqual(['b']);
    // T-SQL and SQLite: a self-reference is recursive without RECURSIVE
    expect(tables('WITH t AS (SELECT 1 AS id UNION ALL SELECT id + 1 FROM t) SELECT * FROM t', 'mssql')).toEqual([]);
    expect(tables('WITH t AS (SELECT 1 AS id UNION ALL SELECT id + 1 FROM t) SELECT * FROM t', 'sqlite')).toEqual([]);
    expect(tables('WITH t AS (SELECT 1 AS id UNION ALL SELECT id + 1 FROM t) SELECT * FROM t', 'postgres')).toEqual(['t']);
    // Postgres: a quoted name with different case is a different relation
    expect(tables('WITH tree AS (SELECT 1) SELECT * FROM "Tree", tree, TREE')).toEqual(['Tree']);
  });

  it('reads INSERT, UPDATE, DELETE, MERGE and SELECT INTO targets', () => {
    const ins = analyzeSql('INSERT INTO t (a, b) SELECT x, y FROM s');
    expect(ins.tables.map(fmt)).toEqual(['t', 's']);
    expect(ins.columns.map((c) => c.name)).toEqual(['a', 'b', 'x', 'y']);
    expect(tables('INSERT INTO public.t AS x (a) VALUES (1)')).toEqual(['public.t x']);
    expect(tables('INSERT IGNORE INTO t VALUES (1)', 'mysql')).toEqual(['t']);
    expect(tables('INSERT OR REPLACE INTO t VALUES (1)', 'sqlite')).toEqual(['t']);
    expect(tables('UPDATE t SET a = 1 WHERE b = 2')).toEqual(['t']);
    expect(tables('UPDATE t1 JOIN t2 ON t1.id = t2.id SET t1.a = t2.a', 'mysql')).toEqual(['t1', 't2']);
    expect(tables('UPDATE t SET a = u.a FROM u WHERE t.id = u.id')).toEqual(['t', 'u']);
    expect(tables('DELETE FROM t USING u WHERE t.id = u.id')).toEqual(['t', 'u']);
    expect(tables('DELETE FROM t1, t2 USING t1 JOIN t2 ON t1.id = t2.id', 'mysql')).toEqual(['t1', 't2', 't1', 't2']);
    expect(tables('MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a')).toEqual(['t', 's']);
    expect(tables('MERGE INTO t AS tgt USING (SELECT * FROM s) AS src ON tgt.id = src.id WHEN NOT MATCHED THEN INSERT (id) VALUES (src.id)')).toEqual(['t tgt', 's']);
    expect(tables('SELECT * INTO backup_users FROM users')).toEqual(['backup_users', 'users']);
    expect(tables('SELECT * INTO TEMP TABLE t2 FROM users')).toEqual(['t2', 'users']);
    expect(tables('SELECT * INTO #tmp FROM users', 'mssql')).toEqual(['#tmp', 'users']);
    expect(tables("SELECT * FROM users INTO OUTFILE '/tmp/x'", 'mysql')).toEqual(['users']);
    expect(tables('SELECT id INTO @v FROM users', 'mysql')).toEqual(['users']);
    expect(tables('TABLE users')).toEqual(['users']);
    expect(tables('TRUNCATE TABLE a, b')).toEqual(['a', 'b']);
  });

  it('resolves T-SQL UPDATE/DELETE targets that are aliases', () => {
    expect(tables('UPDATE u SET u.x = 1 FROM users u', 'mssql')).toEqual(['users u']);
    expect(tables('DELETE u FROM users u JOIN orders o ON o.uid = u.id', 'mssql')).toEqual(['users u', 'orders o']);
    expect(tables('DELETE users WHERE id = 1', 'mssql')).toEqual(['users']);
  });

  it('does not treat JOIN ... USING (col) as a table', () => {
    const a = analyzeSql('SELECT * FROM a JOIN b USING (id) JOIN c USING (id, x)');
    expect(a.tables.map(fmt)).toEqual(['a', 'b', 'c']);
    expect(a.columns.map((c) => c.name)).toEqual(['id', 'id', 'x']);
  });

  it('does not read FROM inside functions or IS DISTINCT FROM as a table', () => {
    expect(tables('SELECT EXTRACT(YEAR FROM o.created_at) FROM orders o')).toEqual(['orders o']);
    expect(tables("SELECT SUBSTRING(name FROM 1 FOR 3), TRIM(BOTH 'x' FROM name) FROM t")).toEqual(['t']);
    expect(tables('SELECT a IS DISTINCT FROM b, c IS NOT DISTINCT FROM d FROM t')).toEqual(['t']);
    expect(tables('SELECT EXTRACT(EPOCH FROM (SELECT max(d) FROM secret)) FROM t')).toEqual(['secret', 't']);
  });

  it('reads tables in subqueries anywhere', () => {
    expect(tables('SELECT (SELECT max(x) FROM a) FROM b WHERE c IN (SELECT y FROM d) AND EXISTS (SELECT 1 FROM e)')).toEqual(['a', 'b', 'd', 'e']);
  });

  it('skips MySQL DUAL', () => {
    expect(tables('SELECT 1 FROM DUAL', 'mysql')).toEqual([]);
    expect(tables('SELECT 1 FROM dual', 'postgres')).toEqual(['dual']);
  });

  it('reports a table named like a non-reserved keyword', () => {
    expect(tables('SELECT * FROM user', 'mysql')).toEqual(['user']);
    expect(tables('SELECT * FROM month')).toEqual(['month']);
    expect(tables('SELECT * FROM offset', 'mysql')).toEqual(['offset']);
    expect(tables('SELECT * FROM limit', 'mssql')).toEqual(['limit']);
    expect(tables('SELECT * FROM a, status, data')).toEqual(['a', 'status', 'data']);
  });
});

describe('analyzeSql: aliases, CTE columns, stars and functions', () => {
  it('collects every kind of alias', () => {
    const a = analyzeSql(
      'WITH c (x, y) AS (SELECT 1, 2) SELECT count(*) total, s.n AS cnt, f.v FROM (SELECT 1 n) s, generate_series(1, 2) AS f(v) WINDOW w AS (ORDER BY 1)'
    );
    expect(a.aliases).toEqual(expect.arrayContaining(['x', 'y', 'total', 'cnt', 's', 'n', 'f', 'v', 'w']));
    expect(a.cteNames).toEqual(['c']);
  });

  it('adds excluded for ON CONFLICT', () => {
    const a = analyzeSql('INSERT INTO t (id, a) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET a = excluded.a');
    expect(a.aliases).toContain('excluded');
    expect(a.columns.map((c) => `${c.qualifier ?? ''}.${c.name}`)).toEqual(['.id', '.a', '.id', '.a', 'excluded.a']);
  });

  it('collects star qualifiers', () => {
    expect(analyzeSql('SELECT * FROM t').starQualifiers).toEqual(['']);
    expect(analyzeSql('SELECT t.*, u.* FROM t, u').starQualifiers).toEqual(['t', 'u']);
    expect(analyzeSql('SELECT DISTINCT * FROM t').starQualifiers).toEqual(['']);
    expect(analyzeSql('SELECT TOP 5 * FROM t', 'mssql').starQualifiers).toEqual(['']);
    expect(analyzeSql('SELECT "s"."t".* FROM s.t').starQualifiers).toEqual(['t']);
    expect(analyzeSql('DELETE FROM t RETURNING *').starQualifiers).toEqual(['']);
    // Not stars: multiplication and COUNT(*)
    expect(analyzeSql('SELECT a * b, COUNT(*) FROM t').starQualifiers).toEqual([]);
  });

  it('collects uppercased function names', () => {
    const a = analyzeSql('SELECT pg_catalog.pg_sleep(1), "MyFn"(x), lower(y), count(*) FROM t WHERE x IN (1) AND EXISTS (SELECT 1)');
    expect(a.functions).toEqual(['PG_SLEEP', 'MYFN', 'LOWER', 'COUNT']);
    expect(analyzeSql('SELECT CAST(x AS DECIMAL(10,2)), x::numeric(10,2) FROM t').functions).toEqual(['CAST']);
    expect(analyzeSql('MERGE INTO t USING s ON true WHEN NOT MATCHED THEN INSERT (a) VALUES (1)').functions).toEqual([]);
  });
});

describe('significantTokens, splitStatements, findTopLevel', () => {
  it('significantTokens drops whitespace and comments', () => {
    expect(significantTokens(tokenize('SELECT /*x*/ 1 -- y\n')).map((t) => t.text)).toEqual(['SELECT', '1']);
  });

  it('splitStatements splits at ; and drops empty statements', () => {
    const st = splitStatements(tokenize('SELECT 1; ; SELECT 2;'));
    expect(st.map((s) => s.map((t) => t.text).join(' '))).toEqual(['SELECT 1', 'SELECT 2']);
    // Works on significant tokens too
    expect(splitStatements(significantTokens(tokenize('a;b')))).toHaveLength(2);
  });

  it('findTopLevel finds words at paren depth 0 relative to from', () => {
    const toks = significantTokens(tokenize('SELECT a FROM (SELECT b FROM t WHERE x) s WHERE y ORDER BY z'));
    const where = findTopLevel(toks, ['WHERE']);
    expect(toks[where + 1].text).toBe('y');
    expect(findTopLevel(toks, ['ORDER', 'LIMIT'])).toBe(toks.findIndex((t) => t.value === 'ORDER'));
    expect(findTopLevel(toks, ['LIMIT'])).toBe(-1);
    // Searching inside the subquery stops at its closing paren
    const inner = toks.findIndex((t) => t.text === 'b');
    const innerWhere = findTopLevel(toks, ['WHERE'], inner);
    expect(toks[innerWhere + 1].text).toBe('x');
    expect(findTopLevel(toks, ['ORDER'], inner)).toBe(-1);
    // `to` bounds the search
    expect(findTopLevel(toks, ['ORDER'], 0, where)).toBe(-1);
    // Punctuation and operators match by value; quoted identifiers and strings never do
    expect(findTopLevel(significantTokens(tokenize("SELECT 'WHERE', \"WHERE\"; x")), [';', 'WHERE'])).toBe(4);
  });
});
