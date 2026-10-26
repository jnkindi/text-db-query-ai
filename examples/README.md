# Examples

Practical examples of text-db-query-ai. The TypeScript examples import the package source (`../src`) and run with ts-node; the JavaScript examples import `text-db-query-ai` by name, as an application would.

Some examples show something without an API key (`reduce-hallucinations.ts`, `advanced-security.ts` and the JavaScript examples): they run that part first and stop before the first model call when the key is not set.

## Available examples

### `basic-usage.ts`
A query generator with a hand-written schema: API key check, generating queries, warnings and metadata, explanations.

```bash
OPENAI_API_KEY=... npx ts-node basic-usage.ts
```

### `reduce-hallucinations.ts`
Fewer invented tables and columns: an exact schema (`exactNames`, descriptions, `enumValues`, `sampleValues`), `examples`, `instructions`, the identifier check (`identifierCheck`, `maxCorrectionAttempts`), `checkIdentifiers()`, and questions the schema cannot answer (`CANNOT_ANSWER`).

```bash
ANTHROPIC_API_KEY=... npx ts-node reduce-hallucinations.ts
```

### `advanced-security.ts`
A locked-down setup: read-only, `allowedTables`, restricted and sensitive columns, `maxRowLimit`, row-level security, `blockedFunctions` and a role check written with `analyzeSql()`. Shows what the validator blocks and how row-level security rewrites queries, then runs the same policy through the generator.

```bash
ANTHROPIC_API_KEY=... npx ts-node advanced-security.ts
```

### `chatbot-express.ts`
A REST API: authentication middleware, generation, read-only execution on PostgreSQL, error mapping (including `CANNOT_ANSWER`), schema and health endpoints.

```bash
OPENAI_API_KEY=... DB_USER=chatbot_reader DB_PASSWORD=... npx ts-node chatbot-express.ts
```

### `direct-database.ts`
Schema introspection without an ORM, for PostgreSQL, MySQL or SQLite, with `ChatbotHelper` (generate and execute) or a generator only.

```bash
DB=postgres DATABASE_URL=postgres://... OPENAI_API_KEY=... npx ts-node direct-database.ts
DB=sqlite SQLITE_FILE=./mydb.sqlite OPENAI_API_KEY=... npx ts-node direct-database.ts
```

### `prisma-integration.ts`
Schema from Prisma (`createChatbotFromPrisma`, `createFromPrisma`), BigInt results, a chatbot built from parts, and `parsePrismaSchema()` for a schema file without a connection. Needs `@prisma/client` and a generated client (see the file header).

### `javascript-usage.js` and `javascript-esm.mjs`
Plain JavaScript from CommonJS and from an ES module, with an in-memory SQLite database.

```bash
OPENAI_API_KEY=... node javascript-usage.js
ANTHROPIC_API_KEY=... node javascript-esm.mjs
```

## Setup

1. Install the example dependencies:

   ```bash
   npm install
   ```

2. For the JavaScript examples, build the package and install it here:

   ```bash
   (cd .. && npm install && npm run build)
   npm install --no-save ..
   ```

3. Set an API key in the environment (or in a `.env` file you load yourself; see `../.env.example`):

   ```bash
   export OPENAI_API_KEY=sk-...
   # or
   export ANTHROPIC_API_KEY=sk-ant-...
   ```

## Testing the Express API

```bash
OPENAI_API_KEY=... npx ts-node chatbot-express.ts
```

Ask a question:

```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123" \
  -H "x-user-role: user" \
  -d '{"message": "Show my orders from last week"}'
```

Get a query and its explanation:

```bash
curl -X POST http://localhost:3000/api/explain \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123" \
  -H "x-user-role: user" \
  -d '{"message": "What did I spend per month this year?"}'
```

Check health:

```bash
curl http://localhost:3000/api/health
```

## Databases

The examples use PostgreSQL and SQLite; the package also supports MySQL and SQL Server. Set `databaseType` (or the second argument of the `create*` functions) to `'postgres'`, `'mysql'`, `'sqlite'` or `'mssql'`.

## More

- The main [README](../README.md): every option, the security model and the API reference
- The [CHANGELOG](../CHANGELOG.md): what changed in 0.1.0
