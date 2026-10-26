# text-db-query-ai

> Turn natural-language questions into SQL with OpenAI or Claude models, checked against your schema and your security rules before anything runs.

[![npm version](https://img.shields.io/npm/v/text-db-query-ai.svg)](https://www.npmjs.com/package/text-db-query-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **OpenAI or Claude.** Current default models, any OpenAI-compatible endpoint through `baseURL`, or a provider of your own.
- **Schema from the source.** Reads the schema from a live database or from Prisma, with a fixed number of catalog queries whatever the number of tables.
- **Fewer invented names.** The model sees a dialect-correct schema; the generated SQL is checked against it, and the model is asked to correct unknown tables and columns.
- **Validation before execution.** Allowed operations and tables, restricted columns, row limits, dangerous functions and statements, checked on a dialect-aware SQL lexer instead of substring matches.
- **Row-level filtering** by user id, as one layer next to the database's own permissions.
- **PostgreSQL, MySQL, SQLite and SQL Server**, through Prisma or a plain driver. TypeScript types included; works from CommonJS and ESM.

Upgrading from 0.0.1? Read [Upgrading from 0.0.1](#upgrading-from-001) and the [CHANGELOG](https://github.com/jnkindi/text-db-query-ai/blob/main/CHANGELOG.md).

## Installation

```bash
npm install text-db-query-ai
```

Requires Node.js 18 or later. The OpenAI and Anthropic SDKs are installed as dependencies and loaded only when a provider of that kind is created.

Install the driver for your database (they are optional peer dependencies):

```bash
npm install pg              # PostgreSQL (PGlite also works)
npm install mysql2          # MySQL
npm install sqlite3         # SQLite (better-sqlite3 and node:sqlite also work)
npm install mssql           # SQL Server
npm install @prisma/client  # or use Prisma for any of the above
```

The database type `'mongodb'` is still accepted for compatibility, but the package generates SQL only.

## API keys

- OpenAI: https://platform.openai.com/api-keys
- Anthropic (Claude): https://console.anthropic.com/

```bash
OPENAI_API_KEY=your-key-here
# or
ANTHROPIC_API_KEY=your-key-here
```

## Quick start

### OpenAI, with a direct database connection

```typescript
import pg from 'pg';
import { createChatbotFromDatabase } from 'text-db-query-ai';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Reads the schema from the database, then answers questions against it.
const chatbot = await createChatbotFromDatabase(pool, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  // model defaults to 'gpt-6-luna'
});

const result = await chatbot.ask('What are the top 10 products by revenue?', {
  userId: 123,
  role: 'user',
});
console.log(result.query);   // the SQL that ran
console.log(result.results); // the rows
```

### Claude, with Prisma

```typescript
import { PrismaClient } from '@prisma/client';
import { createChatbotFromPrisma } from 'text-db-query-ai';

const prisma = new PrismaClient();

const chatbot = await createChatbotFromPrisma(prisma, 'postgres', {
  llmProvider: 'claude',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  // model defaults to 'claude-opus-5-5'
});

const result = await chatbot.ask('Show me all users created this week', {
  userId: 123,
  role: 'user',
});
```

Every request needs a user context (`{ userId, role }`) unless you set `security.requireUserContext: false`. The default is `true`, as in 0.0.1; without a context the request fails with `SECURITY_VALIDATION_FAILED`.

### Choosing and pinning a model

| Provider | Default model | Notes |
|---|---|---|
| `'openai'` | `gpt-6-luna` | Any Chat Completions model ID works. |
| `'claude'` | `claude-opus-5-5` | `claude-sonnet-5-5` and `claude-haiku-5-5` cost less. |

Defaults can change in a later release. Pin the model in production so an upgrade does not change your costs or answers:

```typescript
import { PrismaClient } from '@prisma/client';
import { createChatbotFromPrisma } from 'text-db-query-ai';

const prisma = new PrismaClient();

const chatbot = await createChatbotFromPrisma(prisma, 'postgres', {
  llmProvider: 'claude',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-sonnet-5-5',
});
```

## LLM options

`createQueryGenerator()` takes these under `llm` (`LLMConfig`). The easy-setup functions (`createChatbotFrom*`, `createFrom*`) take the same names at the top level, with `llmProvider` instead of `provider`. All options except `provider` and `apiKey` are optional.

| Option | Applies to | What it does |
|---|---|---|
| `model` | both | Model ID. Defaults: `gpt-6-luna`, `claude-opus-5-5`. |
| `maxTokens` | both | Output token limit, including reasoning or thinking tokens. Defaults: 8192 (OpenAI reasoning and current models), 1000 (non-reasoning OpenAI models such as gpt-4o and gpt-4.1, as in 0.0.1), 16000 (Claude). An answer cut off at the limit throws (`CLAUDE_INVALID_RESPONSE` with `stopReason: 'max_tokens'`, or `OPENAI_EMPTY_RESPONSE` with `reason: 'length'`) instead of returning a partial query. |
| `temperature` | OpenAI | Sent only where it is accepted: non-reasoning models (gpt-4o, gpt-4.1, ...), custom `baseURL` endpoints, or `reasoningEffort: 'none'`. Default 0.1. Ignored for Claude, whose current API rejects sampling parameters. |
| `baseURL` | both | API base URL, for OpenAI-compatible endpoints, proxies and gateways. |
| `timeout` | both | Request timeout in milliseconds. |
| `maxRetries` | both | Automatic retries on connection errors, 429 and 5xx (SDK default: 2). |
| `defaultHeaders` | both | Extra HTTP headers on every request. |
| `reasoningEffort` | OpenAI | `'none'`, `'minimal'`, `'low'`, `'medium'`, `'high'`, `'xhigh'` or `'max'`, sent as `reasoning_effort`. Not sent unless set. |
| `tokenLimitParam` | OpenAI | `'max_completion_tokens'` (default on api.openai.com and Azure OpenAI) or `'max_tokens'` (default for any other `baseURL`). |
| `effort` | Claude | `'low'`, `'medium'`, `'high'`, `'xhigh'` or `'max'`, sent as `output_config.effort`. Not sent unless set. |
| `fallbacks` | Claude | When the model declines a request, let the API re-run it on Anthropic's recommended fallback model. Default `true`, except when `baseURL` points somewhere other than api.anthropic.com. |
| `promptCaching` | Claude | Cache the static part of the prompt (rules and schema). Default `true`. |

Behavior worth knowing:

- If the OpenAI API or a compatible server rejects `temperature`, `top_p`, `max_tokens`, `max_completion_tokens` or `reasoning_effort` as unsupported, the provider drops or swaps that field, retries once, and remembers the fix for later requests. If either API says the token limit is larger than the model can write, the request is retried once with the model's limit.
- Claude requests are streamed and collected with `finalMessage()`, so a large `maxTokens` does not hit the SDK's limit for non-streaming requests. If the API rejects `fallbacks`, the request is sent once more without it.
- A refusal or an empty answer is reported with the 0.0.1 error codes and extra fields: `OPENAI_EMPTY_RESPONSE` with `details.reason` (`'refusal'` or `'length'`), `CLAUDE_INVALID_RESPONSE` with `details.stopReason`.

```typescript
import { createQueryGenerator, LLMConfig, DatabaseSchema } from 'text-db-query-ai';

declare const schema: DatabaseSchema;

// OpenAI with a reasoning effort
const openai: LLMConfig = {
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-6-luna',
  reasoningEffort: 'low',
  maxTokens: 4000,
  timeout: 30_000,
};

// Claude with its own options
const claude: LLMConfig = {
  provider: 'claude',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-opus-5-5',
  effort: 'medium',
  maxTokens: 16000,
  fallbacks: true,
  promptCaching: true,
  maxRetries: 2,
};

// Any OpenAI-compatible Chat Completions endpoint (a local server, a gateway, another vendor)
const compatible: LLMConfig = {
  provider: 'openai',
  apiKey: process.env.LLM_API_KEY!,
  baseURL: 'http://localhost:11434/v1',
  model: 'my-local-model', // the model name your endpoint serves
  temperature: 0,
  defaultHeaders: { 'X-Team': 'analytics' },
};

const generator = createQueryGenerator({ llm: compatible, database: schema });
```

### Your own provider

Pass any `BaseLLMProvider` as `llmProvider` to `createQueryGenerator()` (it takes precedence over `llm`). Implement `generate(prompt)`; the default `generateWithSystem(system, prompt)` joins the two and calls it, so override `generateWithSystem` too if your API takes a separate system prompt. This is also how to test without calling an API:

```typescript
import { BaseLLMProvider, createQueryGenerator, DatabaseSchema } from 'text-db-query-ai';

declare const schema: DatabaseSchema;

class FixedAnswerProvider extends BaseLLMProvider {
  async generate(prompt: string): Promise<string> {
    return 'SELECT id, email FROM users';
  }
  async validateApiKey(): Promise<boolean> {
    return true;
  }
  getDefaultModel(): string {
    return 'fixed';
  }
}

const generator = createQueryGenerator({
  llm: { provider: 'openai', apiKey: 'unused' },
  llmProvider: new FixedAnswerProvider({ provider: 'openai', apiKey: 'unused' }),
  database: schema,
});
```

## Reducing invented tables and columns

Models invent names when the schema they see is wrong, incomplete or ambiguous. What helps:

### 1. Read the schema from the database or from Prisma

Introspection gives the model the real names, native types, keys, enum values and comments. `createFromDatabase()`, `createChatbotFromDatabase()`, `createFromPrisma()` and `createChatbotFromPrisma()` take extraction options as their last argument:

```typescript
import pg from 'pg';
import { createFromDatabase } from 'text-db-query-ai';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const generator = await createFromDatabase(
  pool,
  'postgres',
  { llmProvider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  {
    schema: 'public',                         // default: public / dbo / the current MySQL database
    includeTables: ['users', 'orders', 'products'],
    excludeTables: ['_prisma_migrations'],
    markSensitiveColumns: ['password', 'token', 'ssn'],
    includeDescriptions: true,                // table and column comments (default true)
    includeEnumValues: true,                  // enum labels (default true)
  }
);
```

Without a database connection, parse `schema.prisma` instead. `parsePrismaSchema()` keeps the database names (`@map`, `@@map`), enums, `///` comments and relations as foreign keys:

```typescript
import { readFileSync } from 'fs';
import { createQueryGenerator, parsePrismaSchema } from 'text-db-query-ai';

const generator = createQueryGenerator({
  llm: { provider: 'claude', apiKey: process.env.ANTHROPIC_API_KEY! },
  database: parsePrismaSchema(readFileSync('prisma/schema.prisma', 'utf8')),
});
```

Both set `exactNames: true` on the schema, so Postgres names such as Prisma's `"User"` are shown to the model with their quotes.

### 2. Describe the data in a hand-written schema

- `exactNames: true` says the names match the database exactly, including case. Set it when tables were really created with mixed case. Without it, a Postgres name like `Users` is shown unquoted, as in 0.0.1, because hand-written schemas often capitalize lowercase tables.
- `description` on tables and columns explains what they hold.
- `enumValues` lists the allowed values, so the model does not invent literals (`'complete'` for `'completed'`).
- `sampleValues` shows example values. They are sent to the LLM provider and never filled in automatically; they are not shown for sensitive columns. Do not put real personal data here.
- `nativeType` is the type exactly as the database reports it (`uuid`, `jsonb`, `varchar(255)`).

### 3. Give examples and domain rules

`examples` are question and SQL pairs shown to the model. `instructions` is free text for business rules. With `debug: true`, examples that reference unknown names are logged.

### 4. Check the SQL against the schema

`identifierCheck` decides what happens when the generated SQL names a table or column the schema does not have, or a Postgres name that needs quotes:

| Mode | Corrections for unknown names | Result when issues remain |
|---|---|---|
| `'retry'` (default) | up to `maxCorrectionAttempts` | The query is returned with warnings. |
| `'strict'` | up to `maxCorrectionAttempts` | Throws `UNKNOWN_IDENTIFIERS` (`details.issues`, `details.query`, `details.attempts`). |
| `'warn'` | none | The query is returned with warnings. |
| `'off'` | none | No check, no warnings. |

`maxCorrectionAttempts` (default 1) also applies, in every mode, to answers that are not valid SQL. Each correction is one more model call with the full prompt plus the problems found, the close matches and the real columns of the tables involved, so it costs about as much as the first call (less on Claude, where the system prompt is cached). `metadata.attempts` reports the number of calls and `metadata.unknownIdentifiers` the names that remain. A correction never makes a request fail that would have succeeded without it: if the corrected query fails validation, the earlier answer is returned with a warning. Set `maxCorrectionAttempts: 0` for exactly one model call per question.

```typescript
import { createQueryGenerator, DatabaseSchema } from 'text-db-query-ai';

const database: DatabaseSchema = {
  databaseType: 'postgres',
  exactNames: true,
  tables: [
    {
      name: 'Customer',
      description: 'One row per paying customer',
      columns: [
        { name: 'id', type: 'integer', nativeType: 'int4' },
        { name: 'email', type: 'varchar', sensitive: true },
        { name: 'country', type: 'varchar', sampleValues: ['US', 'DE', 'RW'] },
        { name: 'createdAt', type: 'timestamp', nativeType: 'timestamp(3)' },
      ],
      primaryKey: 'id',
    },
    {
      name: 'Order',
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'customerId', type: 'integer' },
        { name: 'status', type: 'varchar', enumValues: ['pending', 'paid', 'refunded'] },
        { name: 'total', type: 'decimal', description: 'Amount in cents' },
        { name: 'createdAt', type: 'timestamp', nativeType: 'timestamp(3)' },
      ],
      primaryKey: 'id',
      foreignKeys: [{ column: 'customerId', referencedTable: 'Customer', referencedColumn: 'id' }],
    },
  ],
};

const generator = createQueryGenerator({
  llm: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  database,
  examples: [
    {
      question: 'Revenue by country this year',
      sql: `SELECT c.country, SUM(o.total) AS revenue FROM "Order" o JOIN "Customer" c ON c.id = o."customerId" WHERE o.status = 'paid' AND o."createdAt" >= date_trunc('year', NOW()) GROUP BY c.country`,
    },
  ],
  instructions: 'Revenue means the sum of total over paid orders. Amounts are in cents.',
  identifierCheck: 'retry',
  maxCorrectionAttempts: 1,
});
```

### 5. Let the model say it cannot answer

The prompt allows the model to answer `CANNOT_ANSWER: <reason>` when the schema has no data for the question. That is thrown as `INVALID_SQL_SYNTAX` (the code 0.0.1 used for non-SQL answers) with `details.cannotAnswer = true`:

```typescript
import { QueryGenerator, TextToQueryError } from 'text-db-query-ai';

declare const generator: QueryGenerator;

try {
  const result = await generator.generateQuery('What is the weather in Kigali?', { userId: 1, role: 'user' });
  console.log(result.query, result.warnings, result.metadata?.unknownIdentifiers);
} catch (error) {
  if (error instanceof TextToQueryError && error.code === 'INVALID_SQL_SYNTAX' && error.details?.cannotAnswer) {
    console.log(`Not answerable from this database: ${error.details.reason}`);
  } else {
    throw error;
  }
}
```

### 6. Repair queries the database rejects (opt-in)

`ChatbotHelper` can send a SELECT that failed with a schema or syntax error (unknown column or table, syntax error, ambiguous name, grouping mistake) back to the model with the database's error message, then run the repaired query, which goes through the same checks. It is off by default because it sends database error text, truncated to 500 characters, to the LLM provider. Permission, connection, timeout and data errors are not repaired, so their text is not sent.

```typescript
import pg from 'pg';
import { createChatbotFromDatabase } from 'text-db-query-ai';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const chatbot = await createChatbotFromDatabase(pool, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  repairAttempts: 1, // default 0
});
```

You can check SQL against a schema yourself with `checkIdentifiers(sql, schema)`, which returns the issues (`kind`, `name`, `table`, `suggestions`, `message`).

## Security

### How a question becomes a query

1. The model gets the rules, the dialect rules, the schema and the security constraints in a system prompt, and the user context and question in a separate message, both marked as data.
2. The answer is taken out of any markdown fence and sanitized: comments and trailing semicolons are removed token by token, so a stacked statement stays visible.
3. Syntax and identifiers are checked (see above); the model may be asked for a correction.
4. Row-level security is applied, when it is enabled and a user context is given.
5. A row limit is added or lowered for SELECT queries, when `maxRowLimit` is set.
6. `SecurityValidator` validates the final query. A failure throws `SECURITY_VALIDATION_FAILED` with `details.errors`, and is never retried, so a different question is never answered silently.

### Security options

```typescript
import { SecurityConfig } from 'text-db-query-ai';

const security: SecurityConfig = {
  allowedOperations: ['SELECT'],          // default ['SELECT']
  allowedTables: ['orders', 'products'],  // default: all tables
  restrictedColumns: ['password_hash', 'users.email'],
  maxRowLimit: 100,
  requireUserContext: true,               // default true
  enableRowLevelSecurity: true,
  rowLevelSecurityColumn: 'user_id',      // default 'user_id'
  allowUnion: false,                      // default false
  blockedFunctions: ['internal_*'],
  allowedFunctions: [],
  enforceSensitiveColumns: true,          // default false (warn only)
  customValidator: async (query, userContext) => userContext?.role !== 'guest',
};
```

| Option | Default | Meaning |
|---|---|---|
| `allowedOperations` | `['SELECT']` | Statement types allowed: `SELECT`, `INSERT`, `UPDATE`, `DELETE`. Also applies to data-changing statements nested in a query (writable CTEs); upserts (`ON CONFLICT DO UPDATE`, `ON DUPLICATE KEY UPDATE`, `INSERT OR REPLACE`) need `UPDATE`. |
| `allowedTables` | all | Every table reference (joins, subqueries, comma lists, quoted names) must be listed. Case-insensitive; the qualification must match: `'orders'` allows `orders` but not `shop.orders`, and `'shop.orders'` does not allow a bare `orders`. CTE names are not tables. |
| `restrictedColumns` | none | Columns that may not appear. A bare entry restricts every column whose name contains it, as in 0.0.1 (`password` also restricts `password_hash`); strings, comments, table and function names never match. `'table.column'` restricts that table's column only, through its aliases. With a schema, `*`, `t.*` and whole-row functions (`row_to_json(t)` and similar) count as reading every column; `EXISTS (SELECT * ...)` and `COUNT(t.*)` do not. |
| `restrictedColumnsMatch` | `'contains'` | `'exact'` restricts only columns named exactly like a bare entry. |
| `maxRowLimit` | 1000 in the validator | A top-level `LIMIT`, `TOP` or `FETCH FIRST` above it is rejected, and so is a count that is not a plain number (an expression, a subquery, `PERCENT`). No limit, `LIMIT ALL` and a lone placeholder (`?`, `$1`, `:name`) only produce a warning. The generator adds the limit when it is missing and lowers a larger one. Without `maxRowLimit` the generator adds no limit, as in 0.0.1, but lowers one above 1000 instead of failing. |
| `requireUserContext` | `true` | Reject requests without a user context. |
| `enableRowLevelSecurity` | `true` in the validator | Add a `user_id = <userId>` filter (see below). The generator applies it only when this is set to `true` in its config and a user context is given, as in 0.0.1. |
| `rowLevelSecurityColumn` | `'user_id'` | The column row-level security filters on. |
| `allowUnion` | `false` | Allow `UNION` and `UNION ALL`. |
| `blockedFunctions` | none | Function names to block in addition to `DEFAULT_BLOCKED_FUNCTIONS`, case-insensitive; a trailing `*` matches a prefix. They take precedence over `allowedFunctions`. |
| `allowedFunctions` | none | Names from `DEFAULT_BLOCKED_FUNCTIONS` to allow anyway. |
| `enforceSensitiveColumns` | `false` | Reject queries that read schema columns marked `sensitive: true`. By default they only produce a warning. |
| `customValidator` | none | `async (query, userContext) => boolean`, run on the final query. `false` adds "Custom validation failed". |

Rejected whatever `allowedOperations` says. Keywords are matched as tokens where they act, never inside names, quoted identifiers or strings:

- more than one statement, also when the last one ends in `;` (and, on SQL Server or without a database type, statements that follow each other without `;`, including a second top-level query such as `SELECT * FROM orders SELECT * FROM secrets`)
- comments in a query given straight to `validate()` (the generator removes them first)
- `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`, `REVOKE`, `EXEC`/`EXECUTE`, `xp_cmdshell`, `sp_executesql`
- `SELECT ... INTO`, `INTO OUTFILE`, `INTO DUMPFILE`, and locking reads (`FOR UPDATE`, `FOR SHARE`, `LOCK IN SHARE MODE`)
- credential tables (`pg_shadow`, `pg_authid`, `pg_user_mapping(s)`, `mysql.user`, `sys.sql_logins`, `syslogins`), and `NEXT VALUE FOR` (it advances a sequence)
- ODBC escapes (`{fn ...}`, `{oj ...}`, `{call ...}`), MySQL executable comments (`/*! ... */`), and malformed SQL (unterminated strings, quoted names or comments, unbalanced parentheses)
- unless listed in `allowedFunctions`: functions that sleep, read or write server files, run programs, open connections, change settings, take locks, advance sequences or run SQL given as a string (`pg_sleep`, `pg_read_file`, `dblink`, `set_config`, `nextval`, `SLEEP`, `LOAD_FILE`, `load_extension`, `OPENROWSET`, `xp_*` and the rest of `DEFAULT_BLOCKED_FUNCTIONS`)

### Using SecurityValidator directly

`QueryGenerator` passes the database type and the schema to its validator. When you create one yourself, pass them as the second argument:

```typescript
import { SecurityValidator, QuerySanitizer, DatabaseSchema } from 'text-db-query-ai';

declare const schema: DatabaseSchema; // databaseType: 'postgres'
declare const sqlFromSomewhere: string;

const validator = new SecurityValidator(
  { allowedOperations: ['SELECT'], restrictedColumns: ['password_hash'], maxRowLimit: 100 },
  { databaseType: 'postgres', schema }
);

const sanitizer = new QuerySanitizer('postgres');
const sql = sanitizer.enforceLimit(sanitizer.sanitize(sqlFromSomewhere), 100);
const { valid, errors, warnings } = await validator.validate(sql, { userId: 42, role: 'user' });
```

- **`databaseType`** decides how quotes, comments, escapes and parameters are read. Without it (as with the 0.0.1 constructor), the validator must accept only what every supported database reads the same way, so it rejects `#` (a MySQL comment but a Postgres operator), dollar-quoted strings, `--` followed by a non-space, strings whose end depends on backslash escaping, and Postgres forms that SQL Server would read as two statements (`ARRAY(SELECT ...)`, `LATERAL (SELECT ...)`, `USING (SELECT ...)`); and row-level security refuses string user ids that contain a backslash.
- **`schema`** lets `*`, `t.*` and whole-row functions count as reading restricted and sensitive columns, enables the sensitive-column warning, and tells row-level security which tables hold user rows. Without a schema, `SELECT *` is not checked against `restrictedColumns`.

### Row-level security

`addRowLevelSecurity(query, userContext)` adds `rowLevelSecurityColumn = userId` to SELECT, UPDATE and DELETE queries:

```sql
-- single table: same text as 0.0.1
SELECT id FROM orders                       -> SELECT id FROM orders WHERE user_id = 5
-- an existing OR is parenthesized, and the filter goes before GROUP BY / ORDER BY / LIMIT
SELECT id FROM orders WHERE status = 'paid' OR total > 100 ORDER BY id
  -> SELECT id FROM orders WHERE (status = 'paid' OR total > 100) AND user_id = 5 ORDER BY id
-- a different user id in the query does not skip the filter
SELECT id FROM orders WHERE user_id = 999   -> SELECT id FROM orders WHERE user_id = 999 AND user_id = 5
-- joins: qualified with the first table that has the column (from the schema)
SELECT o.id, u.email FROM orders o JOIN users u ON u.id = o.user_id
  -> ... JOIN users u ON u.id = o.user_id WHERE o.user_id = 5
-- every other read of a user table (subqueries, CTE bodies, derived tables, more joins) is wrapped
SELECT id FROM orders WHERE total > (SELECT AVG(total) FROM orders)
  -> SELECT id FROM orders WHERE total > (SELECT AVG(total) FROM
       (SELECT * FROM orders AS __rls WHERE __rls.user_id = 5) orders) AND user_id = 5
```

Each UNION, INTERSECT and EXCEPT branch gets its own filter. A wrapped table lists its columns only when restricted or sensitive ones must be left out. When the schema shows no table of a join with the column, the unqualified 0.0.1 filter is used, so it binds to whichever table or derived table really has it. Numbers are inlined; strings are quoted with `'` doubled (and `\` doubled on MySQL); any other value throws `SECURITY_VALIDATION_FAILED`.

Know its limits:

- It is one equality filter on one column. It does not model tenants, teams, roles or shared rows.
- The main table of every SELECT, UPDATE or DELETE gets the filter, even a lookup table or a CTE without the column (`SELECT COUNT(*) FROM products` becomes `... WHERE user_id = 5`). Such queries fail at the database rather than leak, so with row-level security on, questions about tables without the column fail.
- With a schema, other tables are filtered only if the schema says they have the column; a table the schema does not list, and every table when there is no schema, is assumed to hold user rows, which again fails rather than leaks.
- It does not restrict what is written: `INSERT ... VALUES` can write rows for another user, and `UPDATE ... SET user_id = ...` can hand a user's rows to someone else. Keep `allowedOperations: ['SELECT']` when you rely on it.
- Views, table functions and stored functions are opaque: what they read inside is not filtered.
- A query that cannot be tokenized is returned unchanged; validation then rejects it.

### The real boundary is the database

The validator checks the SQL text against a policy. Treat it as one layer, and make the database enforce the rules that matter:

- Connect with a role that can read only the tables the feature needs: no writes, no DDL, no system catalogs, no file or network functions. Do not let it own the tables or be a superuser (owners and superusers bypass Postgres row-level security).
- Use the database's own row-level security (Postgres policies, SQL Server security policies) for per-user data, and set a statement timeout.
- Prefer a read replica for analytical questions.

For example, on Postgres:

```sql
CREATE ROLE chatbot_reader LOGIN PASSWORD '...';
GRANT SELECT ON orders, products TO chatbot_reader;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_owner ON orders FOR SELECT TO chatbot_reader
  USING (user_id = current_setting('app.user_id')::int);
ALTER ROLE chatbot_reader SET statement_timeout = '5s';
```

Then run each generated query in a transaction that sets the user. The validator blocks `set_config` and `SET` in generated SQL, so the model cannot change it:

```typescript
import pg from 'pg';
import { QueryGenerator, UserContext } from 'text-db-query-ai';

declare const generator: QueryGenerator;
const pool = new pg.Pool({ connectionString: process.env.CHATBOT_READER_URL });

async function answer(question: string, user: UserContext) {
  const { query } = await generator.generateQuery(question, user);
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.user_id', $1, true)", [String(user.userId)]);
    const { rows } = await client.query(query);
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

See [SECURITY.md](https://github.com/jnkindi/text-db-query-ai/blob/main/SECURITY.md) for what counts as a vulnerability and how to report one privately.

## Error handling

```typescript
import { TextToQueryError, ChatbotHelper } from 'text-db-query-ai';

declare const chatbot: ChatbotHelper;

try {
  const result = await chatbot.ask('Show my orders', { userId: 123, role: 'user' });
  console.log(result.results);
} catch (error) {
  if (!(error instanceof TextToQueryError)) throw error; // database and network errors
  switch (error.code) {
    case 'SECURITY_VALIDATION_FAILED': // blocked by the security rules: error.details.errors
      break;
    case 'INVALID_SQL_SYNTAX':         // not valid SQL, or error.details.cannotAnswer
      break;
    case 'UNKNOWN_IDENTIFIERS':        // only with identifierCheck: 'strict'
      break;
    case 'OPENAI_API_ERROR':
    case 'OPENAI_EMPTY_RESPONSE':      // error.details.reason: 'refusal' | 'length'
    case 'CLAUDE_API_ERROR':
    case 'CLAUDE_INVALID_RESPONSE':    // error.details.stopReason: 'refusal' | 'max_tokens' | ...
      break;
    case 'QUERY_GENERATION_FAILED':    // anything else during generation
      break;
  }
}
```

`UNSUPPORTED_PROVIDER` is thrown when `provider` is not `'openai'` or `'claude'`.

## Prisma notes

`PrismaAdapter` runs queries with `$queryRawUnsafe` and returns rows as Prisma gives them. Prisma returns integer aggregates such as `COUNT(*)` as `BigInt`, which `JSON.stringify` cannot serialize. Convert them before sending a response:

```typescript
import { ChatbotHelper } from 'text-db-query-ai';

declare const chatbot: ChatbotHelper;

const result = await chatbot.ask('How many orders were placed today?', { userId: 123, role: 'user' });
const body = JSON.stringify(result.results, (_key, value) =>
  typeof value === 'bigint' ? (Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()) : value
);
```

Alternatively, ask for integers in `instructions` (for example "Cast counts to integer with ::int"). Schema introspection through Prisma already converts BigInt catalog values.

## SQL analysis

The lexer and analysis that the validator and the identifier check use are exported:

- `analyzeSql(sql, dialect?)`: statements, main operation, tables (with schema, alias and position), CTE names, aliases, column references, called functions and nested statements. Throws `SqlLexError` on unterminated input.
- `tokenize(sql, dialect?, options?)`: every token with its type, text, value and offsets.
- `toSqlDialect(databaseType)`, `sqlReadings(dialect)`: the dialect for a database type, and every reading a check has to pass.
- `quoteIdentifier`, `formatIdentifier`, `needsQuoting`: identifier quoting per dialect.
- `DEFAULT_BLOCKED_FUNCTIONS`, `isBlockedFunction(name, extraBlocked?, allowed?)`.
- `checkIdentifiers(sql, schema)`, `IdentifierChecker`: schema checks, as used by the generator.

```typescript
import { analyzeSql, isBlockedFunction } from 'text-db-query-ai';

const analysis = analyzeSql(
  'SELECT u.id, COUNT(*) FROM users u JOIN orders o ON o.user_id = u.id GROUP BY u.id',
  'postgres'
);
console.log(analysis.operation);                  // 'SELECT'
console.log(analysis.tables.map((t) => t.name));  // ['users', 'orders']
console.log(analysis.functions);                  // ['COUNT']
console.log(isBlockedFunction('pg_catalog.pg_sleep')); // true
```

## API reference

### Setup functions

```typescript
import type {
  ChatbotHelper,
  EasySetupConfig,
  QueryGenerator,
  SchemaExtractionOptions,
  TextToQueryConfig,
} from 'text-db-query-ai';

type SqlDatabase = 'postgres' | 'mysql' | 'sqlite' | 'mssql';

// Schema read from Prisma or a connection, plus query execution
declare function createChatbotFromPrisma(prisma: any, databaseType: SqlDatabase, config: EasySetupConfig, options?: SchemaExtractionOptions): Promise<ChatbotHelper>;
declare function createChatbotFromDatabase(connection: any, databaseType: SqlDatabase, config: EasySetupConfig, options?: SchemaExtractionOptions): Promise<ChatbotHelper>;

// The same, without execution
declare function createFromPrisma(prisma: any, databaseType: SqlDatabase, config: EasySetupConfig, options?: SchemaExtractionOptions): Promise<QueryGenerator>;
declare function createFromDatabase(connection: any, databaseType: SqlDatabase, config: EasySetupConfig, options?: SchemaExtractionOptions): Promise<QueryGenerator>;

// A schema you provide
declare function createQueryGenerator(config: TextToQueryConfig): QueryGenerator;
```

`EasySetupConfig` has `llmProvider`, `apiKey`, `model`, `security`, `debug`, every option from [LLM options](#llm-options), the generator options `examples`, `instructions`, `identifierCheck`, `maxCorrectionAttempts`, `logger` and `userContext`, and `repairAttempts` (chatbots only).

`TextToQueryConfig` has `llm`, `database`, `security`, `userContext` (used when a call passes none), `debug`, `logger` (receives debug messages instead of `console.log`; API keys are redacted), `llmProvider`, `examples`, `instructions`, `identifierCheck` and `maxCorrectionAttempts`.

Supported connections: pg `Pool` and `Client`, PGlite, mysql2 (promise and callback APIs), sqlite3, better-sqlite3, `node:sqlite` and mssql `ConnectionPool`. Parameters use the driver's placeholders.

### ChatbotHelper

- `ask(question, userContext?)` resolves to `{ question, query, results, metadata, warnings }`.
- `askWithExplanation(question, userContext?)` adds `explanation` (one more model call).
- `new ChatbotHelper(generator, adapter, { repairAttempts })` builds one from parts, for example to keep a reference to the generator:

```typescript
import { PrismaClient } from '@prisma/client';
import { ChatbotHelper, PrismaAdapter, createFromPrisma } from 'text-db-query-ai';

const prisma = new PrismaClient();
const generator = await createFromPrisma(prisma, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
});
if (!(await generator.validateApiKey())) {
  throw new Error('Invalid LLM API key');
}
const chatbot = new ChatbotHelper(generator, new PrismaAdapter(prisma, 'postgres'));
```

### QueryGenerator

- `generateQuery(question, userContext?)` resolves to a `QueryResult` (does not execute).
- `generateQueryWithExplanation(question, userContext?)` adds `explanation`.
- `explainQuery(sql)` explains any query in plain language (one model call).
- `repairQuery(question, failedQuery, errorMessage, userContext?)` asks for a corrected query after a database error (used by `repairAttempts`).
- `validateApiKey()` lists models, which uses no tokens.
- `getSchema()` returns the 0.0.1 schema text; `getExampleQueries()` returns example queries.

```typescript
import { QueryResult } from 'text-db-query-ai';

const example: QueryResult = {
  query: 'SELECT id, total FROM orders WHERE user_id = 5 LIMIT 100',
  explanation: 'Generated SELECT query for: "my orders"',
  warnings: [],
  metadata: {
    operation: 'SELECT',
    tables: ['orders'],
    estimatedComplexity: 'low',
    attempts: 1,            // model calls used
    unknownIdentifiers: [], // names the schema does not have
  },
};
```

The lower-level classes are exported too: `SecurityValidator`, `QuerySanitizer`, `SchemaAnalyzer` (`renderForModel()` shows the schema as the model sees it), `PrismaAdapter`, `DatabaseIntrospectionAdapter`, `OpenAIProvider`, `ClaudeProvider` and `createLLMProvider`.

## Upgrading from 0.0.1

0.1.0 keeps every 0.0.1 export, method signature and error code, and the wording of the validator's error messages. What changes for existing code:

- Queries 0.0.1 accepted but that are dangerous or malformed are now rejected; ordinary queries it wrongly rejected (`created_at`, CTEs, `'--'` in a string, ...) now pass. The [CHANGELOG](https://github.com/jnkindi/text-db-query-ai/blob/main/CHANGELOG.md) lists each case.
- The default models are `gpt-6-luna` and `claude-opus-5-5`; the old Claude default was retired. Default `maxTokens` is 8192 (OpenAI reasoning and current models) and 16000 (Claude) instead of 1000; non-reasoning OpenAI models keep 1000.
- The identifier check runs by default and can make one extra model call per question. To keep exactly one call per question and no new warnings, as in 0.0.1, set `maxCorrectionAttempts: 0` and `identifierCheck: 'off'`.
- Row-level security now filters every read of a user table, so queries over several tables come back rewritten.
- Node.js 18 or later is required.

```typescript
import { createQueryGenerator, DatabaseSchema } from 'text-db-query-ai';

declare const schema: DatabaseSchema;

const generator = createQueryGenerator({
  llm: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini', // the 0.0.1 default, available until OpenAI shuts it down on 2027-01-14
    maxTokens: 1000,      // the 0.0.1 default
  },
  database: schema,
  maxCorrectionAttempts: 0, // one model call per question
  identifierCheck: 'off',   // no unknown-identifier warnings
});
```

## Testing

```bash
npm test                 # unit, differential and integration tests (no LLM calls)
npm run test:coverage    # with coverage
npm run typecheck
```

- Live smoke tests call the real APIs (billed) and run only with `LIVE_LLM_TESTS=1`, for each provider whose key is set: `LIVE_LLM_TESTS=1 OPENAI_API_KEY=... ANTHROPIC_API_KEY=... npx jest tests/live`.
- MySQL integration tests run when `MYSQL_URL` is set, for example `MYSQL_URL=mysql://root@127.0.0.1:3306/test`. They create and drop their own databases, so point them at a disposable server.
- Postgres tests run on PGlite in a child process; `PGLITE_RLS=1` adds a row-isolation suite.

## Examples

The [examples](https://github.com/jnkindi/text-db-query-ai/tree/main/examples) directory has:

- `basic-usage.ts`: a generator with a hand-written schema
- `reduce-hallucinations.ts`: schema details, examples, instructions and the identifier check
- `advanced-security.ts`: a locked-down setup with row-level security
- `prisma-integration.ts`, `direct-database.ts`: schema from Prisma or a connection
- `chatbot-express.ts`: an Express REST API
- `javascript-usage.js`, `javascript-esm.mjs`: plain JavaScript with SQLite

## Contributing

1. Fork the repository and create a branch.
2. Add tests for your change.
3. Run `npm run typecheck` and `npm test`.
4. Open a pull request.

Report security problems privately, as described in [SECURITY.md](https://github.com/jnkindi/text-db-query-ai/blob/main/SECURITY.md), not in a public issue.

## License

MIT © [jnkindi](https://github.com/jnkindi). See NOTICE for the licenses of the runtime dependencies.

## Links

- [GitHub repository](https://github.com/jnkindi/text-db-query-ai)
- [npm package](https://www.npmjs.com/package/text-db-query-ai)
- [Changelog](https://github.com/jnkindi/text-db-query-ai/blob/main/CHANGELOG.md)
- [Issues](https://github.com/jnkindi/text-db-query-ai/issues)
