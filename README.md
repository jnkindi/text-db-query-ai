# Text-DB-Query-AI

A secure, intelligent text-to-database query converter with LLM integration for building AI-powered chatbots and natural language database interfaces.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Usage Examples](#usage-examples)
- [Security Features](#security-features)
- [API Reference](#api-reference)
- [JavaScript Usage](#javascript-usage)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Best Practices](#best-practices)
- [Contributing](#contributing)

## Features

- **Easy Integration**: One-line setup with Sequelize, Prisma, or direct database connections
- **Multiple LLM Support**: OpenAI (GPT-4, GPT-3.5) or Claude (Anthropic)
- **Database Support**: PostgreSQL, MySQL, SQLite, MongoDB, MS SQL Server
- **Security First**:
  - SQL injection prevention
  - Query operation restrictions
  - Table and column access control
  - Row-level security (automatic user filtering)
  - Sensitive data protection
  - Custom validation rules
- **TypeScript & JavaScript**: Full support for both environments
- **Intelligent**: Context-aware query generation with user permissions
- **Well Tested**: 63+ tests with 90%+ coverage on security components

## Installation

```bash
npm install text-db-query-ai

# Install your ORM (optional)
npm install sequelize  # For Sequelize
npm install @prisma/client prisma  # For Prisma

# Install database driver (choose one)
npm install pg  # For PostgreSQL
npm install mysql2  # For MySQL
npm install sqlite3  # For SQLite
```

## Quick Start

### With Sequelize (Easiest)

```typescript
import { createChatbotFromSequelize } from 'text-db-query-ai';

// Just pass your Sequelize instance - schema is automatically extracted!
const chatbot = await createChatbotFromSequelize(sequelize, {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
});

// Ask questions and get results!
const result = await chatbot.ask('Show all users');
console.log(result.results); // Actual data from your database
console.log(result.query);   // Generated SQL query
```

### With Prisma

```typescript
import { PrismaClient } from '@prisma/client';
import { createChatbotFromPrisma } from 'text-db-query-ai';

const prisma = new PrismaClient();

const chatbot = await createChatbotFromPrisma(prisma, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
});

const result = await chatbot.ask('Show my recent orders', {
  userId: 123,
  role: 'user',
});
```

### With Direct Database Connection

```typescript
import pg from 'pg';
import { createChatbotFromDatabase } from 'text-db-query-ai';

const pool = new pg.Pool({
  host: 'localhost',
  database: 'mydb',
  user: 'user',
  password: 'password',
});

const chatbot = await createChatbotFromDatabase(pool, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
});

const result = await chatbot.ask('Show all orders from last week');
```

## Configuration

### Easy Setup Options

```typescript
interface EasySetupOptions {
  llmProvider: 'openai' | 'claude';
  apiKey: string;
  model?: string;          // Optional: defaults to 'gpt-4o-mini' or 'claude-3-5-sonnet-20241022'
  temperature?: number;    // Optional: defaults to 0.1 for consistency
  security?: SecurityConfig;
}
```

### Security Configuration

```typescript
interface SecurityConfig {
  // Only allow specific SQL operations
  allowedOperations?: ('SELECT' | 'INSERT' | 'UPDATE' | 'DELETE')[];

  // Only allow access to specific tables
  allowedTables?: string[];

  // Block access to sensitive columns
  restrictedColumns?: string[];

  // Maximum rows that can be returned
  maxRowLimit?: number;

  // Require user context for all queries
  requireUserContext?: boolean;

  // Automatically filter queries by user_id
  enableRowLevelSecurity?: boolean;

  // Custom validation function
  customValidator?: (query: string, context?: UserContext) => Promise<boolean>;
}
```

### Example with Full Security

```typescript
const chatbot = await createChatbotFromSequelize(
  sequelize,
  {
    llmProvider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    security: {
      allowedOperations: ['SELECT'],           // Read-only
      allowedTables: ['users', 'orders'],     // Only these tables
      restrictedColumns: ['password', 'ssn'], // Never access these
      maxRowLimit: 100,                       // Max 100 rows per query
      enableRowLevelSecurity: true,           // Auto-filter by user_id
      requireUserContext: true,               // Must provide user info
    },
  },
  {
    markSensitiveColumns: ['password', 'ssn', 'credit_card'],
  }
);
```

## Usage Examples

### Basic Chatbot Usage

```typescript
const chatbot = await createChatbotFromSequelize(sequelize, {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
});

// Simple query
const result = await chatbot.ask('Show active users from last month');
console.log(result.query);    // Generated SQL
console.log(result.results);  // Query results
console.log(result.warnings); // Any security warnings

// Query with user context (for row-level security)
const result2 = await chatbot.ask('Show my orders', {
  userId: 123,
  role: 'customer',
});

// Query with explanation
const result3 = await chatbot.askWithExplanation('Top 10 customers by revenue');
console.log(result3.explanation);
// "This query aggregates order totals by customer and sorts them..."
```

### Express.js REST API

```typescript
import express from 'express';
import { createChatbotFromDatabase } from 'text-db-query-ai';
import pg from 'pg';

const app = express();
app.use(express.json());

const pool = new pg.Pool({ /* config */ });

const chatbot = await createChatbotFromDatabase(pool, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  security: {
    allowedOperations: ['SELECT'],
    maxRowLimit: 100,
    enableRowLevelSecurity: true,
  },
});

app.post('/api/query', async (req, res) => {
  try {
    const { message, userId, role } = req.body;

    // Generate and execute query
    const result = await chatbot.ask(message, { userId, role });

    res.json({
      success: true,
      data: result.results,
      query: result.query,
      warnings: result.warnings,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

app.listen(3000, () => {
  console.log('Chatbot API running on http://localhost:3000');
});
```

### Custom Security Validation

```typescript
const chatbot = await createChatbotFromSequelize(sequelize, {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  security: {
    allowedOperations: ['SELECT', 'INSERT'],
    customValidator: async (query, userContext) => {
      // Admins can do anything
      if (userContext?.role === 'admin') {
        return true;
      }

      // Regular users cannot use DELETE
      if (query.toLowerCase().includes('delete')) {
        return false;
      }

      // Business-specific validation
      return true;
    },
  },
});
```

### Handling Sensitive Data

```typescript
const chatbot = await createChatbotFromPrisma(
  prisma,
  'postgres',
  {
    llmProvider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    security: {
      // Block these columns from ever being accessed
      restrictedColumns: ['password', 'ssn', 'credit_card'],
    },
  },
  {
    // Mark these as sensitive in schema (LLM will avoid them)
    markSensitiveColumns: ['password', 'ssn', 'credit_card'],
  }
);
```

### Manual Setup (Advanced Control)

For complete control over configuration:

```typescript
import { createQueryGenerator } from 'text-db-query-ai';

const generator = createQueryGenerator({
  llm: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-4o-mini',
    temperature: 0.1,
    maxTokens: 1000,
  },
  database: {
    databaseType: 'postgres',
    tables: [
      {
        name: 'users',
        columns: [
          { name: 'id', type: 'integer', description: 'User ID' },
          { name: 'email', type: 'varchar', description: 'User email' },
          { name: 'name', type: 'varchar', description: 'User name' },
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
        primaryKey: 'id',
        foreignKeys: [
          { column: 'user_id', referencedTable: 'users', referencedColumn: 'id' },
        ],
      },
    ],
  },
  security: {
    allowedOperations: ['SELECT'],
    maxRowLimit: 100,
  },
});

// Generate query (doesn't execute)
const result = await generator.generateQuery(
  'Show me orders from last week',
  { userId: 123, role: 'user' }
);

// You execute the query yourself
const data = await pool.query(result.query, result.parameters);
```

## Security Features

### 1. SQL Injection Prevention

Automatically detects and blocks:
- **Multiple statements**: `SELECT * FROM users; DROP TABLE users`
- **UNION attacks**: `SELECT * FROM users UNION SELECT * FROM passwords`
- **Command execution**: `EXEC xp_cmdshell 'dir'`
- **Dangerous commands**: `DROP`, `TRUNCATE`, `ALTER`, `CREATE`
- **SQL comments**: Used for injection attacks

### 2. Row-Level Security

Automatically filters queries by user ID:

```typescript
// User asks: "Show all orders"
// Without RLS: SELECT * FROM orders
// With RLS:    SELECT * FROM orders WHERE user_id = 123

const result = await chatbot.ask('Show all orders', {
  userId: 123,
  role: 'user',
});
```

### 3. Access Control

Fine-grained control over what can be accessed:

```typescript
security: {
  allowedOperations: ['SELECT'],           // Only reads
  allowedTables: ['users', 'orders'],     // Only these tables
  restrictedColumns: ['password', 'ssn'], // Never access these
  maxRowLimit: 100,                       // Max 100 rows
}
```

### 4. User Context Validation

Require authentication for all queries:

```typescript
security: {
  requireUserContext: true,
}

// This will fail
await chatbot.ask('Show users'); // Error: User context required

// This works
await chatbot.ask('Show users', { userId: 123, role: 'admin' });
```

## API Reference

### ChatbotHelper

Main class for easy integration:

```typescript
class ChatbotHelper {
  // Ask a question and get results
  async ask(question: string, userContext?: UserContext): Promise<{
    question: string;
    query: string;
    results: any[];
    metadata?: {
      operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
      tables: string[];
    };
    warnings?: string[];
  }>

  // Ask with detailed explanation
  async askWithExplanation(question: string, userContext?: UserContext): Promise<{
    question: string;
    query: string;
    explanation: string;
    results: any[];
  }>
}
```

### QueryGenerator

Lower-level API for advanced usage:

```typescript
class QueryGenerator {
  // Generate SQL from natural language
  async generateQuery(userInput: string, userContext?: UserContext): Promise<QueryResult>

  // Generate with explanation
  async generateQueryWithExplanation(userInput: string, userContext?: UserContext): Promise<QueryResult>

  // Validate LLM API key
  async validateApiKey(): Promise<boolean>

  // Get database schema as formatted string
  getSchema(): string

  // Get example queries for the schema
  getExampleQueries(): string[]
}
```

### Types

```typescript
interface UserContext {
  userId: string | number;
  role: string;
  permissions?: string[];
  metadata?: Record<string, any>;
}

interface QueryResult {
  query: string;
  parameters?: any[];
  explanation?: string;
  warnings?: string[];
  metadata?: {
    operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
    tables: string[];
    estimatedComplexity?: 'low' | 'medium' | 'high';
  };
}
```

## JavaScript Usage

The package works seamlessly with JavaScript (no TypeScript required):

### CommonJS

```javascript
const { createChatbotFromSequelize } = require('text-db-query-ai');

async function main() {
  const chatbot = await createChatbotFromSequelize(sequelize, {
    llmProvider: 'openai',
    apiKey: process.env.OPENAI_API_KEY,
  });

  const result = await chatbot.ask('Show all users');
  console.log(result.results);
}

main();
```

### ES Modules

```javascript
import { createChatbotFromDatabase } from 'text-db-query-ai';
import pg from 'pg';

const pool = new pg.Pool({ /* config */ });

const chatbot = await createChatbotFromDatabase(pool, 'postgres', {
  llmProvider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
});

const result = await chatbot.ask('Show recent orders');
console.log(result.results);
```

## Error Handling

```typescript
import { TextToQueryError } from 'text-db-query-ai';

try {
  const result = await chatbot.ask('dangerous query');
} catch (error) {
  if (error instanceof TextToQueryError) {
    console.error(`Error Code: ${error.code}`);
    console.error(`Message: ${error.message}`);

    // Common error codes:
    switch (error.code) {
      case 'SECURITY_VALIDATION_FAILED':
        // Query blocked by security rules
        break;
      case 'INVALID_SQL_SYNTAX':
        // Generated SQL is invalid
        break;
      case 'OPENAI_API_ERROR':
      case 'CLAUDE_API_ERROR':
        // LLM API error (check API key, quota, etc.)
        break;
      case 'UNSUPPORTED_PROVIDER':
        // Invalid LLM provider specified
        break;
    }
  }
}
```

## Testing

### Run Tests

```bash
# Run all tests
npm test

# Run with coverage report
npm run test:coverage

# Run security tests only
npm run test:security

# Run integration tests
npm run test:integration

# Watch mode for development
npm run test:watch
```

### Test Coverage

The package has comprehensive test coverage:

- **Security Validator**: 90% coverage (SQL injection, access control)
- **Query Sanitizer**: 95% coverage (input cleaning, validation)
- **Schema Analyzer**: 93% coverage (schema generation)
- **Sequelize Adapter**: 80% coverage (ORM integration)
- **63 total tests** covering all critical functionality

### Writing Tests

Example test for custom integration:

```typescript
import { createChatbotFromSequelize } from 'text-db-query-ai';

describe('My Chatbot', () => {
  it('should generate safe queries', async () => {
    const chatbot = await createChatbotFromSequelize(sequelize, {
      llmProvider: 'openai',
      apiKey: 'test-key',
      security: {
        allowedOperations: ['SELECT'],
      },
    });

    const result = await chatbot.ask('Show users');

    expect(result.query).toContain('SELECT');
    expect(result.query).not.toContain('DROP');
  });
});
```

## Troubleshooting

### API Key Issues

**Problem**: `OPENAI_API_ERROR` or `CLAUDE_API_ERROR`

**Solutions**:
1. Verify API key is correct
2. Check you have API credits/quota
3. Ensure environment variable is loaded:
   ```typescript
   console.log(process.env.OPENAI_API_KEY); // Should not be undefined
   ```
4. For OpenAI, check at https://platform.openai.com/api-keys
5. For Claude, check at https://console.anthropic.com/

### Security Validation Failures

**Problem**: Queries are being blocked

**Solutions**:
1. Check `allowedOperations` includes the operation you need
2. Verify table names are in `allowedTables` (if specified)
3. Ensure columns aren't in `restrictedColumns`
4. Check if `requireUserContext` is true but no context provided
5. Review custom validator logic if using one

### Row-Level Security Not Working

**Problem**: Users can see other users' data

**Solutions**:
1. Ensure `enableRowLevelSecurity: true` in config
2. Always pass `userContext` with `userId`:
   ```typescript
   await chatbot.ask('Show orders', { userId: 123, role: 'user' });
   ```
3. Verify your tables have a `user_id` column

### ORM Integration Issues

**Problem**: Schema not detected from Sequelize/Prisma

**Solutions**:
1. Ensure models are defined before calling setup function
2. For Sequelize: call `sequelize.sync()` first
3. For Prisma: run `prisma generate` first
4. Check database connection is working

### Query Quality Issues

**Problem**: Generated queries are incorrect or suboptimal

**Solutions**:
1. Add descriptions to your schema columns
2. Use more specific questions
3. Try different model (GPT-4 vs GPT-3.5)
4. Add table/column descriptions in schema
5. Use `askWithExplanation()` to understand the reasoning

### Installation Issues

**Problem**: Cannot install package or dependencies

**Solutions**:
1. Use Node.js 16 or higher: `node --version`
2. Clear npm cache: `npm cache clean --force`
3. Delete `node_modules` and `package-lock.json`, then reinstall
4. For sqlite3 issues, may need: `npm install sqlite3 --build-from-source`

## Environment Variables

Create a `.env` file in your project:

```bash
# Required: Choose one LLM provider
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Database (if using direct connection)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mydb
DB_USER=user
DB_PASSWORD=password
```

Load with `dotenv`:

```typescript
import 'dotenv/config';
```

## Best Practices

### 1. Always Use User Context

```typescript
// Bad - no user context
const result = await chatbot.ask('Show orders');

// Good - includes user context for security
const result = await chatbot.ask('Show orders', {
  userId: req.user.id,
  role: req.user.role,
});
```

### 2. Restrict Operations for Read-Only Chatbots

```typescript
security: {
  allowedOperations: ['SELECT'],  // Read-only
}
```

### 3. Set Reasonable Row Limits

```typescript
security: {
  maxRowLimit: 100,  // Prevent large data dumps
}
```

### 4. Protect Sensitive Columns

```typescript
security: {
  restrictedColumns: ['password', 'ssn', 'credit_card', 'api_key'],
}
```

### 5. Use Explicit Table Allowlist

```typescript
security: {
  allowedTables: ['users', 'orders', 'products'],  // Only these
}
```

### 6. Enable Row-Level Security

```typescript
security: {
  enableRowLevelSecurity: true,  // Auto-filter by user_id
}
```

### 7. Validate API Keys on Startup

```typescript
const isValid = await generator.validateApiKey();
if (!isValid) {
  throw new Error('Invalid LLM API key');
}
```

### 8. Handle Errors Gracefully

```typescript
try {
  const result = await chatbot.ask(userInput);
  return result;
} catch (error) {
  if (error instanceof TextToQueryError) {
    // Log error and return user-friendly message
    console.error('Query error:', error.code, error.message);
    return { error: 'Unable to process query. Please try again.' };
  }
  throw error;
}
```

### 9. Use Query Explanations for Transparency

```typescript
const result = await chatbot.askWithExplanation('complex query');
// Show explanation to user so they understand what's being queried
console.log(result.explanation);
```

### 10. Monitor and Log Queries

```typescript
const result = await chatbot.ask(userInput, userContext);

// Log for audit trail
logger.info({
  user: userContext.userId,
  question: userInput,
  query: result.query,
  timestamp: new Date(),
});
```

## Supported Databases

- **PostgreSQL** - Full support via `pg`
- **MySQL** - Full support via `mysql2`
- **SQLite** - Full support via `sqlite3`
- **MongoDB** - Supported (NoSQL queries)
- **MS SQL Server** - Supported via `mssql`

## Supported ORMs

- **Sequelize** - Automatic schema extraction
- **Prisma** - Automatic schema extraction
- **Direct Database** - Manual schema definition

## Examples Directory

Check the `/examples` directory for complete working examples:

- `basic-usage.ts` - Simple getting started example
- `sequelize-integration.ts` - Full Sequelize setup
- `prisma-integration.ts` - Full Prisma setup
- `direct-database.ts` - Direct database connection
- `chatbot-express.ts` - Express.js REST API
- `advanced-security.ts` - Complex security rules
- `javascript-usage.js` - CommonJS JavaScript example
- `javascript-esm.mjs` - ES Modules JavaScript example

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass: `npm test`
6. Commit your changes: `git commit -am 'Add feature'`
7. Push to the branch: `git push origin feature-name`
8. Create a Pull Request

### Development Setup

```bash
# Clone the repo
git clone https://github.com/yourusername/text-db-query-ai.git
cd text-db-query-ai

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Watch mode for development
npm run dev
```

## License

MIT License - see LICENSE file for details

## Support

- **Issues**: Open an issue on GitHub
- **Questions**: Check the troubleshooting section above
- **Feature Requests**: Open an issue with the "enhancement" label

## Changelog

### v1.0.0

- Initial release
- OpenAI and Claude support
- Sequelize and Prisma integration
- Comprehensive security features
- 63+ tests with high coverage
- Full TypeScript and JavaScript support

---

**Made with ❤️ for developers building AI-powered database interfaces**
