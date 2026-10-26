/**
 * Runs PGlite in a plain Node process for the integration tests.
 *
 * PGlite's Emscripten loader calls `import()` under Node, which Jest's module
 * VM rejects unless Node runs with --experimental-vm-modules, so the tests talk
 * to this process over IPC instead of loading PGlite themselves.
 */

const { PGlite } = require('@electric-sql/pglite');

const db = new PGlite();

process.on('message', async ({ id, method, sql, params }) => {
  try {
    if (method === 'exec') {
      await db.exec(sql);
      process.send({ id, rows: [] });
    } else {
      const result = await db.query(sql, params);
      process.send({ id, rows: result.rows });
    }
  } catch (error) {
    process.send({ id, error: { message: error.message, code: error.code } });
  }
});

process.on('disconnect', () => {
  db.close().finally(() => process.exit(0));
});
