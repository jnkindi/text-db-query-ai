# text-db-query-ai

> Convert natural language to SQL queries using AI. Secure, simple, and production-ready.

[![npm version](https://img.shields.io/npm/v/text-db-query-ai.svg)](https://www.npmjs.com/package/text-db-query-ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- 🤖 **AI-Powered**: Use OpenAI or Claude to generate SQL from natural language
- 🔒 **Secure by Default**: Built-in SQL injection prevention and access control
- ⚡ **Easy Setup**: Get started with 3 lines of code
- 🎯 **Multiple Databases**: PostgreSQL, MySQL, SQLite, MongoDB, MS SQL
- 🔌 **ORM Support**: Works with Prisma or direct database connections
- 📝 **TypeScript**: Full type safety and IntelliSense support
- ✅ **Well Tested**: 56 tests, 0 vulnerabilities

## Installation

```bash
npm install text-db-query-ai
```

Install your database driver:
```bash
npm install pg          # PostgreSQL
npm install mysql2      # MySQL
npm install sqlite3     # SQLite
```

## Quick Start

### With Prisma (Recommended)

```typescript
import { PrismaClient } from '@prisma/client';
import { createChatbotFromPrisma } from 'text-db-query-ai';

const prisma = new PrismaClient();

const chatbot = await createChatbotFromPrisma(prisma, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
});

// Ask questions in natural language!
const result = await chatbot.ask('Show me all users created this week');
console.log(result.results); // Array of user objects
console.log(result.query);   // Generated SQL query
```

### With Direct Database Connection

```typescript
import pg from 'pg';
import { createChatbotFromDatabase } from 'text-db-query-ai';

const pool = new pg.Pool({
  host: 'localhost',
  database: 'mydb',
  user: 'postgres',
  password: 'password',
});

const chatbot = await createChatbotFromDatabase(pool, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
});

const result = await chatbot.ask('What are the top 10 products by sales?');
console.log(result.results);
```

## API Keys

Get your API key from:
- **OpenAI**: https://platform.openai.com/api-keys
- **Anthropic (Claude)**: https://console.anthropic.com/

Add to `.env`:
```bash
OPENAI_API_KEY=your-key-here
# OR
ANTHROPIC_API_KEY=your-key-here
```

## Usage Examples

### Basic Query

```typescript
const result = await chatbot.ask('Show all active users');
// Returns: { query: '...', results: [...], metadata: {...} }
```

### With User Context (Security)

```typescript
const result = await chatbot.ask(
  'Show my orders',
  { userId: 123, role: 'user' }
);
// Automatically filters results for this user
```

### Get Query Explanation

```typescript
const result = await chatbot.askWithExplanation(
  'Calculate total revenue by product category'
);
console.log(result.explanation);
// "This query groups orders by product category and sums..."
```

### Custom Security Rules

```typescript
const chatbot = await createChatbotFromPrisma(prisma, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  security: {
    allowedOperations: ['SELECT'],           // Read-only
    maxRowLimit: 100,                        // Max 100 rows
    restrictedColumns: ['password', 'ssn'],  // Block sensitive data
    enableRowLevelSecurity: true,            // Auto-filter by user_id
    requireUserContext: true,                // Require user info
  },
});
```

### Express.js API

```typescript
import express from 'express';

const app = express();
app.use(express.json());

// Initialize once
const chatbot = await createChatbotFromPrisma(prisma, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
});

app.post('/api/query', async (req, res) => {
  try {
    const result = await chatbot.ask(req.body.question, {
      userId: req.user.id,
      role: req.user.role,
    });

    res.json({ success: true, data: result.results });
  } catch (error: any) {
    res.status(400).json({ success: false, error: error.message });
  }
});

app.listen(3000);
```

## Security Features

### SQL Injection Prevention

Automatically detects and blocks:
- Multiple statements (`DROP TABLE users; --`)
- UNION attacks
- Command execution (`EXEC`, `xp_cmdshell`)
- Dangerous operations (`DROP`, `TRUNCATE`, `ALTER`)

### Access Control

```typescript
security: {
  allowedOperations: ['SELECT', 'INSERT'],    // Allowed SQL operations
  allowedTables: ['users', 'orders'],         // Allowed tables
  restrictedColumns: ['password', 'ssn'],     // Blocked columns
  maxRowLimit: 100,                           // Max rows returned
}
```

### Row-Level Security

Automatically filters queries by user:

```typescript
// User asks: "Show all orders"
// Without RLS: SELECT * FROM orders
// With RLS:    SELECT * FROM orders WHERE user_id = 123

const chatbot = await createChatbotFromPrisma(prisma, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  security: {
    enableRowLevelSecurity: true,
  },
});
```

### Custom Validation

```typescript
security: {
  customValidator: async (query, userContext) => {
    // Admins can do anything
    if (userContext?.role === 'admin') return true;

    // Block DELETE for regular users
    if (query.toLowerCase().includes('delete')) return false;

    return true;
  },
}
```

## API Reference

### Main Functions

#### `createChatbotFromPrisma()`

Create a chatbot with Prisma.

```typescript
async function createChatbotFromPrisma(
  prismaClient: any,
  databaseType: 'postgres' | 'mysql' | 'sqlite' | 'mssql',
  config: {
    llmProvider: 'openai' | 'claude';
    apiKey: string;
    model?: string;
    security?: SecurityConfig;
    debug?: boolean;
  }
): Promise<ChatbotHelper>
```

#### `createChatbotFromDatabase()`

Create a chatbot with direct database connection.

```typescript
async function createChatbotFromDatabase(
  connection: any,
  databaseType: 'postgres' | 'mysql' | 'sqlite' | 'mssql',
  config: { /* same as above */ }
): Promise<ChatbotHelper>
```

#### `createQueryGenerator()`

Create a query generator with manual schema (advanced).

```typescript
function createQueryGenerator(config: {
  llm: {
    provider: 'openai' | 'claude';
    apiKey: string;
    model?: string;
    temperature?: number;
  };
  database: {
    databaseType: string;
    tables: Array<{
      name: string;
      columns: Array<{
        name: string;
        type: string;
        nullable?: boolean;
        description?: string;
      }>;
      primaryKey?: string;
      foreignKeys?: Array<{
        column: string;
        referencedTable: string;
        referencedColumn: string;
      }>;
    }>;
  };
  security?: SecurityConfig;
}): QueryGenerator
```

### ChatbotHelper Methods

#### `ask()`

Ask a question and get results.

```typescript
async ask(
  question: string,
  userContext?: { userId: string | number; role: string }
): Promise<{
  question: string;
  query: string;
  results: any[];
  metadata?: {
    operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
    tables: string[];
    estimatedComplexity?: 'low' | 'medium' | 'high';
  };
  warnings?: string[];
}>
```

#### `askWithExplanation()`

Get results with a human-readable explanation.

```typescript
async askWithExplanation(
  question: string,
  userContext?: { userId: string | number; role: string }
): Promise<{
  question: string;
  query: string;
  explanation: string;
  results: any[];
}>
```

### QueryGenerator Methods

#### `generateQuery()`

Generate SQL query (doesn't execute).

```typescript
async generateQuery(
  userInput: string,
  userContext?: UserContext
): Promise<{
  query: string;
  parameters?: any[];
  warnings?: string[];
  metadata?: {
    operation: string;
    tables: string[];
    estimatedComplexity?: string;
  };
}>
```

#### `validateApiKey()`

Check if LLM API key is valid.

```typescript
async validateApiKey(): Promise<boolean>
```

### Types

```typescript
interface SecurityConfig {
  allowedOperations?: ('SELECT' | 'INSERT' | 'UPDATE' | 'DELETE')[];
  allowedTables?: string[];
  restrictedColumns?: string[];
  maxRowLimit?: number;
  requireUserContext?: boolean;
  enableRowLevelSecurity?: boolean;
  customValidator?: (query: string, context?: UserContext) => Promise<boolean>;
}

interface UserContext {
  userId: string | number;
  role: string;
  permissions?: string[];
  metadata?: Record<string, any>;
}
```

## Error Handling

```typescript
import { TextToQueryError } from 'text-db-query-ai';

try {
  const result = await chatbot.ask('dangerous query');
} catch (error) {
  if (error instanceof TextToQueryError) {
    console.error('Error code:', error.code);
    console.error('Message:', error.message);

    switch (error.code) {
      case 'SECURITY_VALIDATION_FAILED':
        // Query blocked by security rules
        break;
      case 'INVALID_SQL_SYNTAX':
        // Generated SQL is invalid
        break;
      case 'OPENAI_API_ERROR':
      case 'CLAUDE_API_ERROR':
        // LLM API error
        break;
    }
  }
}
```

## Advanced Usage

### Manual Schema Definition

```typescript
import { createQueryGenerator } from 'text-db-query-ai';

const generator = createQueryGenerator({
  llm: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
  },
  database: {
    databaseType: 'postgres',
    tables: [
      {
        name: 'users',
        description: 'User accounts',
        columns: [
          { name: 'id', type: 'integer', description: 'User ID' },
          { name: 'email', type: 'varchar', nullable: false },
          { name: 'name', type: 'varchar' },
          { name: 'created_at', type: 'timestamp' },
        ],
        primaryKey: 'id',
      },
      {
        name: 'orders',
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'user_id', type: 'integer' },
          { name: 'total', type: 'decimal' },
          { name: 'status', type: 'varchar' },
        ],
        foreignKeys: [
          { column: 'user_id', referencedTable: 'users', referencedColumn: 'id' },
        ],
      },
    ],
  },
});

const result = await generator.generateQuery('Show all users');
console.log(result.query); // Generated SQL (not executed)
```

### Debug Mode

```typescript
const chatbot = await createChatbotFromPrisma(prisma, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  debug: true, // Enable debug logging
});
```

### Using Claude Instead of OpenAI

```typescript
const chatbot = await createChatbotFromPrisma(prisma, 'postgres', {
  llmProvider: 'claude',
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: 'claude-3-5-sonnet-20241022', // Optional: specify model
});
```

## Best Practices

### 1. Always Use User Context

```typescript
// ❌ Bad - no security context
const result = await chatbot.ask('Show orders');

// ✅ Good - includes user context
const result = await chatbot.ask('Show orders', {
  userId: req.user.id,
  role: req.user.role,
});
```

### 2. Enable Row-Level Security

```typescript
security: {
  enableRowLevelSecurity: true,  // Auto-filter by user_id
  requireUserContext: true,      // Require user info
}
```

### 3. Restrict Operations for Public APIs

```typescript
security: {
  allowedOperations: ['SELECT'],  // Read-only for public API
}
```

### 4. Set Row Limits

```typescript
security: {
  maxRowLimit: 100,  // Prevent large data dumps
}
```

### 5. Block Sensitive Columns

```typescript
security: {
  restrictedColumns: ['password', 'ssn', 'credit_card'],
}
```

### 6. Validate API Key on Startup

```typescript
const chatbot = await createChatbotFromPrisma(/* ... */);

if (!(await chatbot.generator.validateApiKey())) {
  throw new Error('Invalid LLM API key');
}
```

## Troubleshooting

### API Key Issues

**Problem**: `OPENAI_API_ERROR` or `CLAUDE_API_ERROR`

**Solution**:
1. Verify API key is correct
2. Check you have API credits
3. Ensure environment variable is loaded:
   ```typescript
   console.log(process.env.OPENAI_API_KEY); // Should not be undefined
   ```

### Security Validation Failed

**Problem**: Queries are being blocked

**Solution**:
1. Check `allowedOperations` includes your operation
2. Verify table is in `allowedTables` (if set)
3. Ensure column isn't in `restrictedColumns`
4. Check if `requireUserContext` is true but no context provided

### Row-Level Security Not Working

**Problem**: Users can see other users' data

**Solution**:
1. Enable RLS: `enableRowLevelSecurity: true`
2. Always pass `userContext` with `userId`
3. Ensure your tables have a `user_id` column

## Testing

```bash
npm test                    # Run all tests
npm run test:coverage      # Run with coverage
npm run test:watch         # Watch mode
```

## Examples

Check the `/examples` directory for complete working examples:
- `basic-usage.ts` - Simple getting started
- `prisma-integration.ts` - Prisma setup
- `direct-database.ts` - Direct DB connection
- `advanced-security.ts` - Security features
- `chatbot-express.ts` - Express.js REST API

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Add tests for new features
4. Ensure all tests pass: `npm test`
5. Submit a pull request

## License

MIT © [jnkindi](https://github.com/jnkindi)

## Links

- [GitHub Repository](https://github.com/jnkindi/text-db-query-ai)
- [npm Package](https://www.npmjs.com/package/text-db-query-ai)
- [Report Issues](https://github.com/jnkindi/text-db-query-ai/issues)

---

**Made with ❤️ for developers building AI-powered database interfaces**
