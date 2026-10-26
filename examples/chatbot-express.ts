/**
 * Express.js Chatbot API Example
 *
 * A REST API that turns questions into SQL and runs them on PostgreSQL.
 *
 * Connect with a database role that can only read the tables the chatbot
 * needs (DB_USER below), not with the application's owner role.
 *
 * Run: OPENAI_API_KEY=... DB_USER=chatbot_reader DB_PASSWORD=... npx ts-node chatbot-express.ts
 */

import express, { NextFunction, Request, Response } from 'express';
import pg from 'pg';
import { createQueryGenerator, TextToQueryError } from '../src';

const app = express();
app.use(express.json());

// Database connection pool
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'myapp',
  user: process.env.DB_USER || 'chatbot_reader',
  password: process.env.DB_PASSWORD,
  // Stop runaway queries on the server side
  statement_timeout: 5000,
});

// Initialize the query generator once
const generator = createQueryGenerator({
  llm: {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    // model defaults to 'gpt-6-luna'; pin it in production
  },
  database: {
    databaseType: 'postgres',
    tables: [
      {
        name: 'orders',
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'user_id', type: 'integer' },
          { name: 'total', type: 'decimal' },
          { name: 'status', type: 'varchar', enumValues: ['pending', 'paid', 'refunded'] },
          { name: 'created_at', type: 'timestamp' },
        ],
        primaryKey: 'id',
      },
    ],
  },
  security: {
    allowedOperations: ['SELECT'],
    allowedTables: ['orders'],
    maxRowLimit: 100,
    enableRowLevelSecurity: true, // every query is filtered to user_id = the caller
  },
});

interface AuthRequest extends Request {
  user?: {
    id: number;
    role: string;
  };
}

const authenticateUser = (req: AuthRequest, res: Response, next: NextFunction) => {
  // In a real app, validate a JWT or session here. Never trust user ids sent by the client.
  const userId = req.headers['x-user-id'] as string;
  const userRole = req.headers['x-user-role'] as string;

  if (!userId || !userRole) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  req.user = { id: parseInt(userId, 10), role: userRole };
  next();
};

/** Map generator errors to HTTP responses. */
function sendError(res: Response, error: unknown) {
  if (error instanceof TextToQueryError) {
    if (error.code === 'INVALID_SQL_SYNTAX' && error.details?.cannotAnswer) {
      return res.status(422).json({ success: false, error: `Cannot answer from this database: ${error.details.reason}` });
    }
    if (error.code === 'SECURITY_VALIDATION_FAILED') {
      return res.status(403).json({ success: false, error: 'That question is not allowed', code: error.code });
    }
    return res.status(400).json({ success: false, error: error.message, code: error.code });
  }
  console.error('Chat error:', error);
  return res.status(500).json({ success: false, error: 'Internal server error' });
}

// Chat endpoint: generate, then execute
app.post('/api/chat', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const queryResult = await generator.generateQuery(message, {
      userId: req.user!.id,
      role: req.user!.role,
    });

    // Run it read-only, whatever the validator allowed
    const client = await pool.connect();
    let rows: unknown[];
    try {
      await client.query('BEGIN READ ONLY');
      rows = (await client.query(queryResult.query)).rows;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    res.json({
      success: true,
      message,
      query: queryResult.query,
      data: rows,
      warnings: queryResult.warnings,
      metadata: queryResult.metadata,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Query explanation endpoint (does not execute)
app.post('/api/explain', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const result = await generator.generateQueryWithExplanation(req.body.message, {
      userId: req.user!.id,
      role: req.user!.role,
    });
    res.json({
      success: true,
      query: result.query,
      explanation: result.explanation,
      metadata: result.metadata,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Schema information endpoint (the 0.0.1 schema text and example queries)
app.get('/api/schema', (_req: Request, res: Response) => {
  res.json({
    schema: generator.getSchema(),
    examples: generator.getExampleQueries(),
  });
});

// Health check
app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    const apiKeyValid = await generator.validateApiKey(); // lists models; uses no tokens
    res.json({
      status: 'healthy',
      database: 'connected',
      llm: apiKeyValid ? 'connected' : 'disconnected',
    });
  } catch {
    res.status(503).json({ status: 'unhealthy', error: 'Service unavailable' });
  }
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Chatbot API running on port ${PORT}`);
  console.log(`
Available endpoints:
  POST /api/chat        - Ask a question and get the rows
  POST /api/explain     - Get the query and an explanation
  GET  /api/schema      - Schema info
  GET  /api/health      - Health check
  `);
});

export default app;
