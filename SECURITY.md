# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes |
| 0.0.x   | No. 0.0.1 has known validator and row-level security bypasses that 0.1.0 fixes; see the CHANGELOG. |

Fixes are released as a new 0.1.x patch version.

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a security
problem. Report it privately through GitHub Security Advisories:

https://github.com/jnkindi/text-db-query-ai/security/advisories/new

(or the repository's **Security** tab, then **Report a vulnerability**).

A useful report includes:

- the text-db-query-ai version and the database type (`postgres`, `mysql`, `sqlite`, `mssql`)
- the `security` configuration and, if relevant, the user context
- the SQL that got through (or the model output that produced it) and what it did
- the smallest code that reproduces it

Do not include real API keys, credentials or production data.

The maintainer aims to acknowledge a report within 7 days, agree on a fix and a
disclosure date with you, and credit you in the published advisory unless you
prefer otherwise.

## What counts as a security issue

This library turns model output into SQL that your application runs. Its
security boundary is the check between the two: `SecurityValidator`,
`QuerySanitizer` and the row-level security rewrite. A model that writes a bad
query is expected; the library letting that query through is the bug.

Please report privately:

- **Validator bypasses.** A query that `SecurityValidator.validate()` accepts, or
  that `QueryGenerator.generateQuery()` returns, although it breaks the
  configured policy. For example: a second statement; an operation not in
  `allowedOperations`; DDL or permission changes; a table outside
  `allowedTables`; a `restrictedColumns` column, including through `*`, `t.*` or
  row-to-JSON functions when a schema is known; a blocked function such as
  `pg_sleep`, `pg_read_file` or `load_extension`; file access such as
  `INTO OUTFILE`; a `maxRowLimit` that is not enforced.
- **Parser confusion.** Comments, quoting, dollar quoting, backslash escapes or
  dialect differences that hide a statement, keyword or function from the
  validator.
- **Row-level security bypasses.** A query rewritten by `addRowLevelSecurity()`
  that can still read or change other users' rows, or a `userId` value that
  injects SQL into the filter.
- **Validated is not what runs.** Any step after validation (sanitizing, limit
  handling, retries) that changes what the query does.
- **Prompt injection that defeats the checks.** Text in a question, schema
  description or user context that gets a disallowed query past the validator.
  A model that writes a disallowed query which the validator then rejects is
  working as intended.
- **Data leaving without consent.** Data you did not opt into (database error
  messages, sample rows, sensitive columns) sent to the LLM provider, or API keys
  and credentials appearing in errors, logs or prompts.

Not security issues (open a normal issue instead):

- SQL that is wrong but allowed by your configuration, or that names tables or
  columns that do not exist.
- Behavior your configuration permits, for example deletes when
  `allowedOperations` includes `DELETE`.
- Slow or expensive queries within the configured limits. Use a statement
  timeout in the database.
- Valid queries that are rejected (false positives). These are bugs, not
  vulnerabilities.
- Vulnerabilities in a database driver, ORM or LLM SDK itself. Report those
  upstream; if this package makes one reachable, report it here as well.

## Running generated SQL safely

The validator is one layer of defense, not the only one:

- Run generated queries with a database role that can read only the tables the
  feature needs, and nothing else (no writes, no system catalogs, no file or
  network functions).
- Set a statement timeout, and use the database's own row-level security
  policies where it has them.
- Keep API keys in environment variables or a secret manager. Never commit
  `.env` files, and rotate any key that was exposed.
