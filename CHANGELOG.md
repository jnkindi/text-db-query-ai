# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

0.1.0 fixes security holes in 0.0.1 that ordinary use can reach, stops rejecting ordinary queries, updates the providers for current models, and adds checks that reduce invented table and column names. Every 0.0.1 export, method signature and error code is kept, and so is the wording of the validator's error messages. Read [Behavior changes for existing users](#behavior-changes-for-existing-users) before upgrading.

### Added

- **Identifier check.** Generated SQL is checked against the schema for unknown tables, unknown columns and Postgres names that need quotes. `identifierCheck` (`'off'`, `'warn'`, `'retry'`, `'strict'`; default `'retry'`) and `maxCorrectionAttempts` (default 1) control it. In `'retry'` and `'strict'` mode the model gets the problems, close matches and the real columns, and is asked for a corrected query (once by default). `'strict'` throws the new `UNKNOWN_IDENTIFIERS` error when problems remain; the other modes return the query with warnings. `checkIdentifiers()` and `IdentifierChecker` run the same check on any SQL.
- **Abstention.** The model may answer `CANNOT_ANSWER: <reason>`, which is thrown as `INVALID_SQL_SYNTAX` with `details.cannotAnswer` and `details.reason`.
- **Prompt inputs.** `examples` (question and SQL pairs) and `instructions` (domain rules) in `TextToQueryConfig` and `EasySetupConfig`. The prompt is split into a static system prompt (rules, dialect rules, schema, security constraints, examples, instructions), rendered once per generator so it can be cached, and a user message that carries the user context and the question inside delimiters, marked as data.
- **Schema detail.** `ColumnSchema.nativeType`, `enumValues` and `sampleValues`; `TableSchema.schema` and `primaryKeyColumns`; `ForeignKeySchema.referencedSchema`; `DatabaseSchema.exactNames`. `SchemaAnalyzer.renderForModel()` shows the schema as the model sees it (dialect-quoted names, native types, keys, enum and sample values, descriptions, sensitive markers) and `getDialectRules()` the dialect rules.
- **Execution repair (opt-in).** `ChatbotHelper` accepts `{ repairAttempts }` (also `repairAttempts` in `EasySetupConfig` for `createChatbotFrom*`). A SELECT that the database rejects with a schema or syntax error is sent back to the model with the error text (at most 500 characters) and the repaired query is executed. Off by default, because it sends database error text to the LLM provider.
- **Generator methods and options.** `QueryGenerator.repairQuery()` and `explainQuery()`. `config.llmProvider` takes any `BaseLLMProvider` instead of creating one from `llm`. `config.logger` receives debug messages instead of `console.log`, with the API key redacted. `QueryResult.metadata.attempts` (model calls used) and `metadata.unknownIdentifiers`.
- **LLM options** (`LLMConfig`, and the same names in `EasySetupConfig`): `baseURL`, `timeout`, `maxRetries`, `defaultHeaders`; for OpenAI `reasoningEffort` and `tokenLimitParam`; for Claude `effort`, `fallbacks` and `promptCaching`.
- `BaseLLMProvider.generateWithSystem(system, prompt)`, with a default that joins the two and calls `generate()`, so existing subclasses keep working.
- **Security options** (`SecurityConfig`): `allowUnion`, `blockedFunctions`, `allowedFunctions`, `rowLevelSecurityColumn` and `enforceSensitiveColumns`.
- `SecurityValidator` takes an optional second argument `{ databaseType, schema }` (`SecurityValidatorOptions`). `QuerySanitizer` takes an optional `databaseType`, and has a new `enforceLimit(query, limit)` that also lowers a larger limit.
- **SQL analysis API.** `analyzeSql`, `tokenize`, `toSqlDialect`, `SqlLexError`, `sqlReadings`, `DEFAULT_BLOCKED_FUNCTIONS`, `isBlockedFunction`, `quoteIdentifier`, `formatIdentifier` and `needsQuoting`, with their types. This is the zero-dependency, dialect-aware lexer that the validator, sanitizer, row-level security and identifier check are built on.
- **Introspection options** (`SchemaExtractionOptions`): `schema` (default `public` on Postgres, `dbo` on SQL Server, the current database on MySQL) and `includeEnumValues` (default true).
- `DatabaseIntrospectionAdapter.executeQuery()` also accepts PGlite, the mysql2 callback API, better-sqlite3, `node:sqlite` and mssql pools.
- CI on Node 22, 24 and 26, a package-content check, a consumer install test on Node 18 to 26, an API compatibility test against the published 0.0.1 build, `SECURITY.md`, and a `NOTICE` file.

### Changed

- **Node.js 18 or later** (`engines`). 0.0.1 already failed on Node 16, which has no global `fetch`.
- **Default models.** OpenAI: `gpt-6-luna` (was `gpt-4o-mini`, which OpenAI shuts down on 2027-01-14). Claude: `claude-opus-5-5` (was `claude-3-5-sonnet-20241022`, retired on 2025-10-28).
- **OpenAI requests.** `max_completion_tokens` on api.openai.com and Azure OpenAI, `max_tokens` for other `baseURL` endpoints (override with `tokenLimitParam`). `temperature` is sent only to non-reasoning models (gpt-4o, gpt-4.1, ...), to custom endpoints, or with `reasoningEffort: 'none'`. A parameter the server reports as unsupported is dropped or swapped and the request is retried once. `maxTokens` defaults to 8192 (was 1000).
- **Claude requests.** No `temperature` (the current API rejects sampling parameters) and no thinking parameter. Requests are streamed and collected with `finalMessage()`. `maxTokens` defaults to 16000 (was 1000). Server-side fallbacks (`fallbacks: 'default'`, beta `server-side-fallback-2026-07-01`) are on unless `fallbacks: false` or `baseURL` is not api.anthropic.com; if the API rejects them, the request is sent once more without. The system prompt is cached unless `promptCaching: false`. All text blocks are joined instead of reading only the first.
- `validateApiKey()` lists models instead of sending a message, so it uses no tokens.
- Both SDKs are loaded when a provider is created, not when the package is imported. The published `.d.ts` files no longer reference SDK types.
- `SecurityValidator`, `QuerySanitizer` and row-level security are rebuilt on the SQL lexer. Keywords are matched as tokens where they act (statement starts, nested statements, clauses), never inside names, quoted identifiers or strings. Error messages keep their 0.0.1 wording and pattern names.
- Schema introspection runs a fixed number of catalog queries whatever the number of tables (Postgres 5, MySQL 3, SQLite 2, SQL Server 5) instead of three or more per table. Both adapters share one implementation.
- `parsePrismaSchema()` is now a tokenizer and parser (see Fixed).
- Optional peer dependency ranges are widened to `>=` the current majors, so Prisma 6 and 7 and sqlite3 6 can be installed. The unused `prisma` CLI peer dependency is dropped.

### Fixed

- Stacked statements validated as one: `sanitize()` removed a trailing `;` before normalizing, so `SELECT id FROM t; DELETE FROM t; -- done` passed as a single SELECT. Comments are now removed token by token and only trailing semicolons are dropped.
- Ordinary names and strings were rejected as SQL commands: `created_at` (CREATE), `grants` (GRANT), `'dropped'` (DROP), `executed_at` (EXEC), `altered`, `revoked_at`, `truncated`, `'--'`, `'/*'` or `';'` inside a string. A restricted column `password` also blocked `password_updated_at`.
- CTEs (`WITH ...`) and queries starting with `(` failed with "Could not determine query operation". The LIMIT check read the first `LIMIT` anywhere, including inside subqueries.
- `validateSQLSyntax()` counted parentheses inside strings, and rejected queries starting with `(`.
- `extractFromMarkdown()` accepts ```` ``` ```` and `~~~` fences with any language tag, `<sql>` wrappers and a leading "sql" line.
- Metadata: words inside strings and names no longer count as joins, subqueries or GROUP BY in `estimatedComplexity`.
- MySQL 8 introspection returned tables without names (upper-case column labels).
- SQLite introspection crashed on reserved table names such as `order`, and `REFERENCES parent` without a column produced `parent.null`.
- Postgres introspection missed the primary keys of mixed-case tables such as Prisma's `"User"`, and paired the columns of composite foreign keys as a cross product.
- SQL Server introspection used a parameter (`@tableName`) it never declared.
- `includeDescriptions` was ignored.
- `PrismaAdapter` sent the SQL text as a bound value of a tagged `$queryRaw` call; it now uses `$queryRawUnsafe(sql, ...params)`.
- `parsePrismaSchema()` invented columns (`unique`, words from comments, relation fields) and lowercased names. It now honors `@map`, `@@map`, `@id`, `@@id`, `@@schema`, enums (with `@map` values), relations as foreign keys, `///` comments and `@db.*` types, and reads views like models.
- `executeQuery()` mapped over a mysql2 callback `Query` object instead of using its promise API.
- The publish workflow could not work: classic npm tokens were revoked and its actions ran on a removed Node runtime. Publishing now uses npm trusted publishing (OIDC) with provenance.

### Security

- **Stacked statements** ending in `;` are rejected (see Fixed).
- **Row-level security** could leak and could be injected:
  - `WHERE a OR b` got `AND user_id = 5` appended, so other users' rows matched `a`. A top-level OR is now parenthesized.
  - The filter was inserted after `GROUP BY`. It now goes before GROUP BY, HAVING, WINDOW, ORDER BY, LIMIT, OFFSET, FETCH, FOR and RETURNING.
  - String user ids were interpolated without escaping. They are now quoted with `'` doubled (and `\` doubled on MySQL); NaN, Infinity, NUL characters and other types throw `SECURITY_VALIDATION_FAILED`.
  - Any `user_id` in the WHERE clause skipped the filter, so `WHERE user_id = 999` read user 999's rows. The filter is skipped only when an AND-only WHERE already has the same `user_id = <value>`.
  - Only the main table was filtered. Subqueries, CTE bodies, derived tables, extra joins, self-joins, UNION branches and the source of `INSERT ... SELECT` are now filtered too.
- **Dangerous queries passed validation:** `pg_sleep`, `pg_read_file`, `dblink`, `set_config`, `load_extension` and other functions; `SELECT ... INTO` and `INTO OUTFILE`; comma-joined and quoted tables outside `allowedTables` (`FROM allowed, secret`). See the list below.
- `restrictedColumns` are enforced through `*`, `t.*` and whole-row functions such as `row_to_json(t)` when the validator has a schema.
- Validation reads each dialect's quoting, comments and escapes the way the database does, and a validator without a database type requires every supported database to read the query the same way.
- The question and the user context are sent inside delimiters and marked as data; closing tags inside them are defused.
- Debug logging redacts the API key. No database error text or sample rows reach the LLM unless you opt in (`repairAttempts`, `sampleValues`).

### Behavior changes for existing users

#### Queries 0.0.1 accepted that are now rejected

Each line is one reason, with examples. All of them are dangerous or malformed; `tests/compat/security-differential.test.ts` checks the list against the published 0.0.1 build.

- Stacked statements are rejected even with a trailing ";" (0.0.1 accepted `SELECT 1; DELETE FROM users;`).
- T-SQL statements that follow another without ";" (`SELECT 1 DELETE FROM t`, `... WAITFOR`, `SHUTDOWN`, `SET`) count as multiple statements on mssql and in the generic dialect.
- `SELECT ... INTO` (a new table, a variable, `INTO OUTFILE` / `DUMPFILE`) is rejected.
- Locking reads (`FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, `FOR KEY SHARE`, `LOCK IN SHARE MODE`) are rejected.
- Calls to functions that sleep, read or write server files, open connections, change settings, take locks, advance sequences or run SQL from a string (`DEFAULT_BLOCKED_FUNCTIONS`, configurable with `blockedFunctions` / `allowedFunctions`) are rejected. Examples: `pg_sleep`, `pg_read_file`, `lo_export`, `set_config`, `dblink`, `pg_terminate_backend`, `ts_stat`, `query_to_xml`, `nextval`, `LOAD_FILE`, `SLEEP`, `BENCHMARK`, `GET_LOCK`, `load_extension`, `readfile`, `writefile`, `fsdir`, `eval`, `OPENQUERY`.
- Reading credential tables (`pg_shadow`, `pg_authid`, `pg_user_mapping(s)`, `mysql.user`, `sys.sql_logins`, `syslogins`) is rejected.
- Data-modifying statements nested in a query (writable CTEs, `(DELETE ...)`) need their operation in `allowedOperations`; upserts (`ON CONFLICT DO UPDATE`, `ON DUPLICATE KEY UPDATE`, `INSERT OR REPLACE`) need `UPDATE`.
- ODBC escape sequences (`{fn ...}`, `{oj ...}`, `{d ...}`, `{t ...}`, `{ts ...}`, `{call ...}`, `{escape ...}`) are rejected: they are server-side syntax that generated SQL never needs.
- Malformed SQL (an unterminated string, quoted identifier or comment, or unbalanced parentheses) is rejected by `validate()` instead of reaching the database.
- On MySQL and in the generic dialect, a string whose end depends on backslash escaping (`NO_BACKSLASH_ESCAPES`) is rejected; write quotes as `''` instead of `\'`.
- In the generic dialect (no `databaseType`) `#` starts a MySQL comment but is an operator to Postgres, so queries with `#` are rejected; set `databaseType`.
- In the generic dialect `$...$` is a Postgres dollar-quoted string to the database but code to the validator, so it is rejected; set `databaseType`.
- MySQL `#` comments in a query given straight to `validate()` are reported like `--` and `/*` (the sanitizer removes them in the generator).
- The row limit is read per dialect: MySQL `LIMIT offset, count`; `TOP n`; `FETCH FIRST n ROWS`; `LIMIT -1` (unlimited in SQLite); hex and exponent counts. 0.0.1 read only the first digits after `LIMIT`.
- A row count that is not a plain number (an expression, a subquery, `TOP`/`FETCH ... PERCENT`) can be neither checked against `maxRowLimit` nor lowered, so it is rejected. `LIMIT ALL` and a lone parameter still only warn.
- An `allowedTables` entry matches a reference with the same qualification only: `"orders"` does not allow `shop.orders` or `otherdb..orders` (another schema or database can hold a different table of that name), and `"billing.invoices"` does not allow a bare `invoices`.
- `allowedTables` now sees quoted, backticked, bracketed, schema-qualified and comma-listed tables (0.0.1 missed them, so they bypassed the allowlist).

#### Queries 0.0.1 wrongly rejected that are now accepted

- Names and strings that contain a keyword: `created_at`, `grants`, `executed_at`, `executor_id`, `altered`, `revoked_at`, `truncated`, `'dropped'`, `'please EXEC this'`.
- `--`, `/*` and `;` inside string literals.
- Restricted columns match exact identifiers: `restrictedColumns: ['password']` no longer blocks `password_updated_at`.
- CTEs (`WITH recent AS (...) SELECT ...`) and queries that start with `(`.
- A large `LIMIT` inside a subquery when the top-level limit is within `maxRowLimit`.

#### Row-level security output

- Single-table queries keep the 0.0.1 text (` WHERE user_id = 123`, or `... AND user_id = 123`), without the extra space 0.0.1 put before `ORDER BY` and `LIMIT`.
- A WHERE with a top-level `OR` is wrapped in parentheses before `AND user_id = ...` is added.
- The filter goes before GROUP BY, HAVING, ORDER BY and LIMIT instead of after GROUP BY.
- `WHERE user_id = 999` (or any other value) no longer skips the filter: the result is `WHERE user_id = 999 AND user_id = 5`.
- Each UNION, INTERSECT and EXCEPT branch gets the filter, not just the last one.
- With joins, the filter is qualified with the first table that has the column according to the schema (`WHERE o.user_id = 5`).
- Every other read of a table that holds user rows (subqueries, CTE bodies, derived tables, extra joins, self-joins, the source of `INSERT ... SELECT`) is replaced by a filtered derived table, for example `(SELECT id, user_id, total FROM orders AS __rls WHERE __rls.user_id = 5) orders`. Without a schema every table is assumed to hold user rows, so a lookup table in a subquery makes the query fail instead of leak.
- String user ids are escaped, and invalid ids throw `SECURITY_VALIDATION_FAILED` (see Security). Without a `databaseType`, a string id that contains a backslash throws, because no literal is safe for every database.
- `rowLevelSecurityColumn` selects the column (default `user_id`).

#### Models and requests

- The default models are now `gpt-6-luna` and `claude-opus-5-5`, and the default `maxTokens` 8192 and 16000 instead of 1000 (see Changed). Answers, latency and costs change accordingly. Pin `model` and `maxTokens` to control them.
- `temperature` is no longer sent to Claude, nor to OpenAI reasoning models on api.openai.com.
- The model gets a new system prompt and user message. `getSchema()` and `SchemaAnalyzer.generateSchemaPrompt()` still return the 0.0.1 text; the model sees `renderForModel()`. `generate()` on the built-in providers still sends the 0.0.1 system prompt.

#### Identifier check on by default

- `identifierCheck` defaults to `'retry'` with `maxCorrectionAttempts: 1`: when the first answer names an unknown table or column, or is not valid SQL, the model is called a second time. Results gain warnings for problems that remain, and `metadata.attempts` and `metadata.unknownIdentifiers`. No new error is thrown; only `'strict'` throws `UNKNOWN_IDENTIFIERS`.

#### Generator limits

- Without `security.maxRowLimit`, the generator still adds no LIMIT, but now lowers a `LIMIT` above 1000 (the validator's default maximum) instead of failing validation.

#### Introspection output

- Tables and columns now come back correct where 0.0.1 got them wrong (see Fixed): MySQL 8 table names, SQLite reserved names, Postgres primary keys of mixed-case tables, composite keys and foreign keys, SQL Server tables.
- Composite primary keys set `primaryKey` to the columns joined with `", "` and `primaryKeyColumns` to the list.
- Introspected schemas carry `nativeType`, `enumValues`, `schema`, `referencedSchema`, descriptions from comments, and `exactNames: true`. The normalized `type` keeps the 0.0.1 mapping.
- SQL Server introspection reads one schema, `dbo` by default, where 0.0.1 listed the tables of every schema. Postgres and MySQL read `public` and the current database, as before. The new `schema` option chooses another one.
- `parsePrismaSchema()` returns the database names and no invented columns, so its output differs from 0.0.1 for most schemas.

#### Exact names

- `DatabaseSchema.exactNames` says the names match the database exactly, including case. The adapters and `parsePrismaSchema()` set it, so Postgres names such as `"User"` are shown to the model with their quotes and checked case-sensitively. Hand-written schemas without it keep the 0.0.1 casing: a Postgres name like `Users` is shown unquoted, as hand-written schemas often capitalize lowercase tables. Reserved words and names that are not plain identifiers are quoted either way.

#### Generic dialect

- A `SecurityValidator` without a database type (every 0.0.1-style `new SecurityValidator(config)`) uses the generic dialect, which also validates the query as each supported database reads it. It rejects `#`, `$...$` dollar quotes, `--` followed by a non-space, backslash-dependent strings and T-SQL statements stacked without `;` (see the list above). Pass `{ databaseType }` as the second argument to validate for one database. `QueryGenerator` does this for you.

#### Keeping 0.0.1 behavior where possible

The security fixes cannot be turned off. To keep the rest close to 0.0.1 (the README has a full example under "Upgrading from 0.0.1"):

- Pin the model and the token limit: `model: 'gpt-4o-mini'` (until OpenAI shuts it down on 2027-01-14) and `maxTokens: 1000`. The old Claude default `claude-3-5-sonnet-20241022` no longer exists; pin a current model such as `claude-sonnet-5-5` instead.
- `maxCorrectionAttempts: 0`: one model call per question, and invalid SQL fails at once, as in 0.0.1.
- `identifierCheck: 'off'`: no unknown-identifier warnings and no `metadata.unknownIdentifiers`.
- Pass `{ databaseType }` to a `SecurityValidator` you create yourself, so the generic-dialect rejections above do not apply to queries your database reads unambiguously.

### Dependencies

- `@anthropic-ai/sdk` `^0.67.0` -> `^1.3.0`. The SDK is licensed Apache-2.0 since 1.0.0 (0.x was MIT); `NOTICE` records it. It adds the dependencies `@opentelemetry/api` (Apache-2.0) and `standardwebhooks` (MIT).
- `openai` `^6.7.0` -> `^6.49.0`. openai 7 is not used because it requires Node.js 22; it is deferred to a major release.
- Peer dependencies: `@prisma/client`, `mysql2`, `pg` and `sqlite3` are now `>=` ranges; `prisma` is no longer a peer dependency.

## [0.0.1]

- First release.

[0.1.0]: https://github.com/jnkindi/text-db-query-ai/releases/tag/v0.1.0
[0.0.1]: https://www.npmjs.com/package/text-db-query-ai/v/0.0.1
