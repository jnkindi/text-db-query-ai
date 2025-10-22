# Examples

This directory contains practical examples demonstrating how to use text-db-query-ai in real-world scenarios.

## Available Examples

### 1. Basic Usage (`basic-usage.ts`)
The simplest way to get started with text-db-query-ai.

**Topics covered:**
- Initial configuration
- API key validation
- Generating queries from natural language
- Handling query results
- Getting query explanations

**Run it:**
```bash
npm run basic
```

### 2. Advanced Security (`advanced-security.ts`)
Comprehensive security features demonstration.

**Topics covered:**
- Role-based access control
- Sensitive data protection
- Custom validation rules
- Row-level security
- SQL injection prevention
- Security testing scenarios

**Run it:**
```bash
npm run security
```

### 3. Express.js Chatbot API (`chatbot-express.ts`)
A complete REST API for a database chatbot.

**Topics covered:**
- Express.js integration
- Database connection pooling
- Authentication middleware
- Error handling
- Health checks
- Production-ready structure

**Run it:**
```bash
npm run express
```

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file:
```bash
cp ../.env.example .env
```

3. Add your API keys to `.env`:
```
OPENAI_API_KEY=sk-...
# or
ANTHROPIC_API_KEY=sk-ant-...
```

4. Run any example:
```bash
npm run basic
npm run security
npm run express
```

## Testing the Express API

Start the server:
```bash
npm run express
```

Send a chat message:
```bash
curl -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123" \
  -H "x-user-role: user" \
  -d '{"message": "Show me all users"}'
```

Get query explanation:
```bash
curl -X POST http://localhost:3000/api/explain \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123" \
  -H "x-user-role: user" \
  -d '{"message": "Find top customers"}'
```

Check health:
```bash
curl http://localhost:3000/api/health
```

## Customization

Each example can be customized:

- Modify the database schema
- Change security rules
- Add new tables
- Adjust LLM settings
- Add custom validation

## Real-World Integration

These examples can be adapted for:

- Discord bots
- Slack apps
- WhatsApp chatbots
- Telegram bots
- Web applications
- Mobile app backends
- Internal tools
- Admin dashboards

## Database Support

While examples use PostgreSQL, the package supports:
- PostgreSQL
- MySQL
- SQLite
- MongoDB
- MS SQL Server

Just change `databaseType` in the config.

## Need More Help?

- Check the main [README.md](../README.md)
- Read [QUICKSTART.md](../QUICKSTART.md)
- Open an issue on GitHub
