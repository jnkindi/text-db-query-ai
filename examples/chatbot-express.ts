/**
 * Express.js Chatbot API Example
 *
 * A complete REST API for a database chatbot using Express.js
 */

import express, { Request, Response } from 'express';
import { createQueryGenerator, TextToQueryError } from '../src';
import pg from 'pg';

const app = express();
app.use(express.json());

// Database connection pool
const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'myapp',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
});

// Initialize query generator
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
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'email', type: 'varchar' },
          { name: 'name', type: 'varchar' },
          { name: 'role', type: 'varchar' },
        ],
      },
      {
        name: 'orders',
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'user_id', type: 'integer' },
          { name: 'total', type: 'decimal' },
          { name: 'status', type: 'varchar' },
          { name: 'created_at', type: 'timestamp' },
        ],
        foreignKeys: [
          { column: 'user_id', referencedTable: 'users', referencedColumn: 'id' },
        ],
      },
    ],
  },
  security: {
    allowedOperations: ['SELECT'],
    maxRowLimit: 100,
    enableRowLevelSecurity: true,
  },
  debug: true,
});

// Middleware to validate user
interface AuthRequest extends Request {
  user?: {
    id: number;
    role: string;
  };
}

const authenticateUser = (req: AuthRequest, res: Response, next: Function) => {
  // In a real app, validate JWT token or session
  const userId = req.headers['x-user-id'] as string;
  const userRole = req.headers['x-user-role'] as string;

  if (!userId || !userRole) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  req.user = {
    id: parseInt(userId),
    role: userRole,
  };

  next();
};

// Chat endpoint
app.post('/api/chat', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Generate SQL query from natural language
    const queryResult = await generator.generateQuery(message, {
      userId: req.user!.id,
      role: req.user!.role,
    });

    // Execute the query
    const dbResult = await pool.query(queryResult.query, queryResult.parameters);

    // Return results
    res.json({
      success: true,
      message,
      query: queryResult.query,
      data: dbResult.rows,
      rowCount: dbResult.rowCount,
      warnings: queryResult.warnings,
      metadata: queryResult.metadata,
    });
  } catch (error: any) {
    console.error('Chat error:', error);

    if (error instanceof TextToQueryError) {
      return res.status(400).json({
        success: false,
        error: error.message,
        code: error.code,
        details: error.details,
      });
    }

    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

// Query explanation endpoint
app.post('/api/explain', authenticateUser, async (req: AuthRequest, res: Response) => {
  try {
    const { message } = req.body;

    const result = await generator.generateQueryWithExplanation(message, {
      userId: req.user!.id,
      role: req.user!.role,
    });

    res.json({
      success: true,
      query: result.query,
      explanation: result.explanation,
      metadata: result.metadata,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

// Schema information endpoint
app.get('/api/schema', (req: Request, res: Response) => {
  res.json({
    schema: generator.getSchema(),
    examples: generator.getExampleQueries(),
  });
});

// Health check
app.get('/api/health', async (req: Request, res: Response) => {
  try {
    // Check database connection
    await pool.query('SELECT 1');

    // Check LLM API key
    const apiKeyValid = await generator.validateApiKey();

    res.json({
      status: 'healthy',
      database: 'connected',
      llm: apiKeyValid ? 'connected' : 'disconnected',
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: 'Service unavailable',
    });
  }
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: Function) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Chatbot API running on port ${PORT}`);
  console.log(`
Available endpoints:
  POST /api/chat        - Send a message to the chatbot
  POST /api/explain     - Get query explanation
  GET  /api/schema      - Get database schema info
  GET  /api/health      - Health check
  `);
});

export default app;
