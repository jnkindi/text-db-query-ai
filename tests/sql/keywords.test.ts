/**
 * Tests for keyword sets, the blocked-function list and identifier quoting
 * (src/sql/keywords.ts, src/sql/identifiers.ts)
 */

import {
  SQL_KEYWORDS,
  RESERVED_KEYWORDS,
  STATEMENT_KEYWORDS,
  DEFAULT_BLOCKED_FUNCTIONS,
  isBlockedFunction,
  isReservedKeyword,
} from '../../src/sql/keywords';
import { needsQuoting, quoteIdentifier } from '../../src/sql/identifiers';
import * as sqlIndex from '../../src/sql';

const words = (s: string): string[] => s.trim().split(/\s+/);

describe('SQL_KEYWORDS', () => {
  it('is uppercase', () => {
    for (const w of SQL_KEYWORDS) expect(w).toBe(w.toUpperCase());
  });

  it.each([
    ['clause words', 'SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET UNION INTERSECT EXCEPT JOIN ON USING AS WITH RECURSIVE'],
    ['types', 'INT INTEGER BIGINT SMALLINT DECIMAL NUMERIC REAL FLOAT DOUBLE PRECISION VARCHAR CHAR CHARACTER VARYING BOOLEAN DATE TIME TIMESTAMP TIMESTAMPTZ INTERVAL JSON JSONB BYTEA DATETIME DATETIME2 NVARCHAR TINYINT'],
    ['date parts', 'YEAR MONTH DAY HOUR MINUTE SECOND WEEK QUARTER EPOCH DOW DOY ISODOW ISOYEAR MICROSECOND MICROSECONDS MILLISECOND MILLISECONDS DAY_HOUR YEAR_MONTH'],
    ['constants', 'TRUE FALSE NULL UNKNOWN CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP LOCALTIME LOCALTIMESTAMP CURRENT_USER SESSION_USER'],
    ['window and fetch words', 'OVER PARTITION ROWS RANGE GROUPS UNBOUNDED PRECEDING FOLLOWING CURRENT ROW FIRST NEXT ONLY TIES NULLS LAST FILTER WITHIN EXCLUDE'],
    ['T-SQL hints and words', 'NOLOCK HOLDLOCK UPDLOCK ROWLOCK READPAST READUNCOMMITTED TOP PERCENT APPLY OPTION MAXRECURSION'],
    ['dialect words', 'ILIKE SIMILAR ISNULL NOTNULL REGEXP RLIKE GLOB SEPARATOR STRAIGHT_JOIN DISTINCTROW DUAL TABLESAMPLE LATERAL ORDINALITY NOCASE'],
  ])('includes %s', (_label, list) => {
    for (const w of words(list)) expect(SQL_KEYWORDS.has(w)).toBe(true);
  });

  it('leaves out common column names', () => {
    for (const w of words('NAME STATUS TYPE VALUE DATA LEVEL ROLE COMMENT SOURCE TEXT UUID PASSWORD EMAIL ID LANGUAGE MODE PLAN OPEN CLOSE TIMEZONE LOAD')) {
      expect(SQL_KEYWORDS.has(w)).toBe(false);
    }
  });
});

describe('RESERVED_KEYWORDS and isReservedKeyword', () => {
  it('contains words that must be quoted as identifiers', () => {
    for (const w of words('USER ORDER GROUP TABLE SELECT FROM WHERE')) expect(RESERVED_KEYWORDS.has(w)).toBe(true);
  });

  it('is per dialect', () => {
    expect(isReservedKeyword('user', 'postgres')).toBe(true);
    expect(isReservedKeyword('user', 'mysql')).toBe(false);
    expect(isReservedKeyword('key', 'mysql')).toBe(true);
    expect(isReservedKeyword('key', 'postgres')).toBe(false);
    expect(isReservedKeyword('top', 'mssql')).toBe(true);
    expect(isReservedKeyword('top', 'sqlite')).toBe(false);
    expect(isReservedKeyword('Order', 'sqlite')).toBe(true);
    expect(isReservedKeyword('name', 'postgres')).toBe(false);
    // generic is the union
    expect(isReservedKeyword('key')).toBe(true);
    expect(isReservedKeyword('top', 'generic')).toBe(true);
  });
});

describe('STATEMENT_KEYWORDS', () => {
  it('contains DML and the prototype statement words, but not query words', () => {
    for (const w of words('INSERT UPDATE DELETE MERGE DROP CREATE ALTER TRUNCATE GRANT REVOKE COPY CALL EXEC EXECUTE DO ATTACH PRAGMA SET LOCK LOAD WAITFOR BEGIN COMMIT')) {
      expect(STATEMENT_KEYWORDS.has(w)).toBe(true);
    }
    for (const w of words('SELECT WITH VALUES TABLE FETCH OPEN CLOSE COMMENT END')) expect(STATEMENT_KEYWORDS.has(w)).toBe(false);
  });
});

describe('DEFAULT_BLOCKED_FUNCTIONS and isBlockedFunction', () => {
  it('is an uppercase, frozen list', () => {
    expect(Object.isFrozen(DEFAULT_BLOCKED_FUNCTIONS)).toBe(true);
    for (const f of DEFAULT_BLOCKED_FUNCTIONS) expect(f).toBe(f.toUpperCase());
  });

  it('blocks the dangerous functions from the research harness', () => {
    const blocked = words(`
      pg_sleep pg_sleep_for pg_read_file pg_read_binary_file pg_ls_dir pg_stat_file pg_terminate_backend
      pg_cancel_backend pg_reload_conf pg_rotate_logfile lo_import lo_export dblink dblink_exec set_config
      query_to_xml table_to_xml pg_advisory_lock pg_try_advisory_lock nextval setval sleep benchmark load_file
      get_lock sys_exec sys_eval load_extension writefile readfile fts3_tokenizer openrowset opendatasource
      openquery xp_cmdshell sp_executesql pg_file_write dbms_pipe utl_http
    `);
    for (const f of blocked) expect(isBlockedFunction(f)).toBe(true);
  });

  it('allows ordinary functions', () => {
    for (const f of words('count sum lower upper coalesce now date_trunc current_setting to_char json_agg replace position extract sleepy lo pg_size_pretty')) {
      expect(isBlockedFunction(f)).toBe(false);
    }
  });

  it('is case-insensitive and checks every part of a qualified name', () => {
    expect(isBlockedFunction('PG_SLEEP')).toBe(true);
    expect(isBlockedFunction('Pg_Sleep')).toBe(true);
    expect(isBlockedFunction('pg_catalog.pg_sleep')).toBe(true);
    expect(isBlockedFunction('dbms_pipe.receive_message')).toBe(true);
    expect(isBlockedFunction('master.dbo.xp_cmdshell')).toBe(true);
    expect(isBlockedFunction('public.lower')).toBe(false);
    expect(isBlockedFunction('')).toBe(false);
  });

  it('supports extra blocked names and prefix patterns', () => {
    expect(isBlockedFunction('my_func', ['MY_FUNC'])).toBe(true);
    expect(isBlockedFunction('audit_purge_all', ['audit_*'])).toBe(true);
    expect(isBlockedFunction('auditor', ['audit_*'])).toBe(false);
    expect(isBlockedFunction('lower', ['upper'])).toBe(false);
  });

  it('lets allowed names override the default list only', () => {
    expect(isBlockedFunction('nextval', undefined, ['nextval'])).toBe(false);
    expect(isBlockedFunction('pg_advisory_lock', [], ['PG_ADVISORY*'])).toBe(false);
    expect(isBlockedFunction('pg_catalog.nextval', [], ['nextval'])).toBe(false);
    expect(isBlockedFunction('setval', [], ['nextval'])).toBe(true);
    // An explicit extra block wins over an allow entry
    expect(isBlockedFunction('nextval', ['nextval'], ['nextval'])).toBe(true);
  });

  it('caches compiled patterns per array without mixing them up', () => {
    const a = ['foo'];
    const b = ['bar'];
    expect(isBlockedFunction('foo', a)).toBe(true);
    expect(isBlockedFunction('foo', b)).toBe(false);
    expect(isBlockedFunction('bar', b)).toBe(true);
  });
});

describe('needsQuoting and quoteIdentifier', () => {
  it('postgres: uppercase letters and reserved words need quoting', () => {
    expect(needsQuoting('User', 'postgres')).toBe(true);
    expect(needsQuoting('user', 'postgres')).toBe(true);
    expect(needsQuoting('order', 'postgres')).toBe(true);
    expect(needsQuoting('users', 'postgres')).toBe(false);
    expect(needsQuoting('created_at', 'postgres')).toBe(false);
    expect(needsQuoting('createdAt', 'postgres')).toBe(true);
    expect(needsQuoting('a$b', 'postgres')).toBe(false);
    expect(quoteIdentifier('User', 'postgres')).toBe('"User"');
    expect(quoteIdentifier('say "hi"', 'postgres')).toBe('"say ""hi"""');
  });

  it('mysql: case does not matter, reserved words and odd characters need quoting', () => {
    expect(needsQuoting('order', 'mysql')).toBe(true);
    expect(needsQuoting('User', 'mysql')).toBe(false);
    expect(needsQuoting('user', 'mysql')).toBe(false);
    expect(needsQuoting('my table', 'mysql')).toBe(true);
    expect(quoteIdentifier('order', 'mysql')).toBe('`order`');
    expect(quoteIdentifier('a`b', 'mysql')).toBe('`a``b`');
  });

  it('mssql: brackets with ]] escapes', () => {
    expect(needsQuoting('weird]name', 'mssql')).toBe(true);
    expect(needsQuoting('Users', 'mssql')).toBe(false);
    expect(needsQuoting('user', 'mssql')).toBe(true);
    expect(quoteIdentifier('weird]name', 'mssql')).toBe('[weird]]name]');
    expect(quoteIdentifier('Order Details', 'mssql')).toBe('[Order Details]');
  });

  it('sqlite and generic: double quotes', () => {
    expect(needsQuoting('Order', 'sqlite')).toBe(true);
    expect(needsQuoting('Orders', 'sqlite')).toBe(false);
    expect(quoteIdentifier('Order', 'sqlite')).toBe('"Order"');
    expect(needsQuoting('a$b', 'generic')).toBe(true);
    expect(needsQuoting('key', 'generic')).toBe(true);
    expect(quoteIdentifier('x', 'generic')).toBe('"x"');
  });

  it('empty, digit-leading and non-ASCII names need quoting', () => {
    for (const d of ['postgres', 'mysql', 'sqlite', 'mssql', 'generic'] as const) {
      expect(needsQuoting('', d)).toBe(true);
      expect(needsQuoting('1abc', d)).toBe(true);
      expect(needsQuoting('café', d)).toBe(true);
      expect(needsQuoting('with-dash', d)).toBe(true);
    }
  });
});

describe('src/sql index', () => {
  it('re-exports the public API', () => {
    for (const name of [
      'tokenize',
      'toSqlDialect',
      'SqlLexError',
      'analyzeSql',
      'significantTokens',
      'splitStatements',
      'findTopLevel',
      'SQL_KEYWORDS',
      'RESERVED_KEYWORDS',
      'STATEMENT_KEYWORDS',
      'DEFAULT_BLOCKED_FUNCTIONS',
      'isBlockedFunction',
      'isReservedKeyword',
      'needsQuoting',
      'quoteIdentifier',
    ]) {
      expect((sqlIndex as Record<string, unknown>)[name]).toBeDefined();
    }
  });
});
