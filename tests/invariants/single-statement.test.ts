/**
 * Guarantee 1: a query that passes SecurityValidator.validate() is read by the
 * target database as a single statement.
 *
 * Method: a table of stacking payloads (a benign SELECT followed by a second,
 * data-modifying statement reached with/without ';', comments, strings, quoted
 * identifiers, dollar quotes) is validated per dialect. Every one must be
 * rejected. The rejection is load-bearing: the same text run through the real
 * engine's multi-statement path (sqlite3 exec / PGlite simple-protocol exec)
 * executes the injected statement, so a sentinel table proves two statements
 * would run. Queries that pass validation and contain an in-token separator are
 * run on the engine and must succeed as one statement.
 *
 * sqlite3 runs in-process; Postgres runs through one PGlite process (closed in
 * afterAll).
 */
import { SecurityValidator } from '../../src/security';
import type { DatabaseType } from '../../src/types';
import { loadSqlite3, openSqlite, SqliteEngine } from './helpers';
import { startPGlite, PGliteProcess } from '../integration/helpers/pglite-process';

const USER = { userId: 1, role: 'user' };
const CFG = { allowedOperations: ['SELECT' as const], requireUserContext: false, allowUnion: true };

/** Stacking attempts: a SELECT then a data-modifying statement on `rls_victim`. */
const STACKING: string[] = [
  'SELECT 1; DROP TABLE rls_victim',
  'SELECT 1;DROP TABLE rls_victim',
  'SELECT 1 ; DELETE FROM rls_victim',
  'SELECT 1; DELETE FROM rls_victim; -- trailing',
  'SELECT 1 ; ; UPDATE rls_victim SET hacked = 1',
  "SELECT 'a;b' AS x; DROP TABLE rls_victim",
  "SELECT 1 /* c */ ; DROP TABLE rls_victim",
  'SELECT 1; INSERT INTO rls_victim VALUES (99, 1)',
  'SELECT id FROM rls_victim; DELETE FROM rls_victim; -- done',
];

/** Valid single statements with separators hidden inside tokens. */
const SINGLE_OK_SQLITE: string[] = [
  "SELECT ';' AS x",
  "SELECT 'a;b;c' AS x",
  "SELECT '-- not a comment' AS x",
  "SELECT '/* not a comment */' AS x",
  'SELECT 1 AS "a;b"',
  'SELECT 1 AS `a;b`',
  'SELECT 1 AS [a;b]',
];
const SINGLE_OK_PG: string[] = [
  "SELECT ';' AS x",
  "SELECT 'a;b;c' AS x",
  "SELECT '-- not a comment' AS x",
  'SELECT 1 AS "a;b"',
  'SELECT $$a;b$$ AS x',
  'SELECT $tag$a;b;$tag$ AS x',
];

const sqlite3 = loadSqlite3();
const describeSqlite = sqlite3 ? describe : describe.skip;

describeSqlite('guarantee 1: single statement (SQLite)', () => {
  let db: SqliteEngine;
  const resetVictim = async (): Promise<void> => {
    await db.exec('DROP TABLE IF EXISTS rls_victim; CREATE TABLE rls_victim (id INTEGER, hacked INTEGER); INSERT INTO rls_victim VALUES (1, 0);');
  };
  const victimIntact = async (): Promise<boolean> => {
    try {
      const rows = await db.all('SELECT id, hacked FROM rls_victim');
      return rows.length === 1 && Number(rows[0].id) === 1 && Number(rows[0].hacked) === 0;
    } catch {
      return false; // table dropped -> not intact
    }
  };

  beforeAll(() => {
    db = openSqlite(sqlite3);
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(resetVictim);

  const validator = new SecurityValidator(CFG, { databaseType: 'sqlite' });

  it.each(STACKING)('rejects the stacked statement %p', async (sql) => {
    const r = await validator.validate(sql, USER);
    expect(r.valid).toBe(false);
  });

  it('the stacking risk is real: sqlite3 exec runs the injected statement', async () => {
    await db.exec('SELECT 1; UPDATE rls_victim SET hacked = 1');
    expect(await victimIntact()).toBe(false); // proves exec runs >1 statement
  });

  it.each(SINGLE_OK_SQLITE)('runs as one statement on SQLite: %p', async (sql) => {
    const r = await validator.validate(sql, USER);
    expect(r.valid).toBe(true);
    await db.exec(sql); // one statement; a mis-split would error on the fragment
    expect(await victimIntact()).toBe(true);
  });
});

describe('guarantee 1: single statement (Postgres / PGlite)', () => {
  jest.setTimeout(60000);
  let pg: PGliteProcess;
  const resetVictim = () =>
    pg.exec('DROP TABLE IF EXISTS rls_victim; CREATE TABLE rls_victim (id int, hacked int); INSERT INTO rls_victim VALUES (1, 0);');
  const victimIntact = async (): Promise<boolean> => {
    try {
      const { rows } = await pg.query('SELECT id, hacked FROM rls_victim');
      return rows.length === 1 && Number(rows[0].id) === 1 && Number(rows[0].hacked) === 0;
    } catch {
      return false;
    }
  };

  beforeAll(() => {
    pg = startPGlite();
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(resetVictim);

  const validator = new SecurityValidator(CFG, { databaseType: 'postgres' });

  it.each(STACKING)('rejects the stacked statement %p', async (sql) => {
    const r = await validator.validate(sql, USER);
    expect(r.valid).toBe(false);
  });

  it('the stacking risk is real: PGlite simple-protocol exec runs the injected statement', async () => {
    await pg.exec('SELECT 1; UPDATE rls_victim SET hacked = 1');
    expect(await victimIntact()).toBe(false);
  });

  it.each(SINGLE_OK_PG)('runs as one statement on Postgres: %p', async (sql) => {
    const r = await validator.validate(sql, USER);
    expect(r.valid).toBe(true);
    await pg.exec(sql);
    expect(await victimIntact()).toBe(true);
    // Extended protocol rejects multiple commands outright; one command must run.
    await expect(pg.query(sql)).resolves.toBeDefined();
  });
});

describe('guarantee 1: generic dialect rejects every stacking form', () => {
  const validator = new SecurityValidator(CFG, {});
  it.each(STACKING)('rejects %p', async (sql) => {
    const r = await validator.validate(sql, USER);
    expect(r.valid).toBe(false);
  });
});
