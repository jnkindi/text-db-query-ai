/**
 * Live smoke tests against the real APIs. Each provider's suite runs only when
 * its key is set (OPENAI_API_KEY, ANTHROPIC_API_KEY) and is skipped otherwise.
 * They make one small generation request per provider, which is billed.
 *
 *   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... npx jest tests/live
 */

import { ClaudeProvider } from '../../src/providers/claude';
import { OpenAIProvider } from '../../src/providers/openai';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM = [
  'You are a database query generator for PostgreSQL. Return only the SQL query, without explanations.',
  'Schema:',
  'Table users: id (integer, primary key), name (text), created_at (timestamp)',
].join('\n');
const QUESTION = 'How many users are there?';

/** Generated SQL should be a SELECT over users. */
function expectSimpleSql(sql: string): void {
  expect(sql).toMatch(/\bselect\b/i);
  expect(sql).toMatch(/\busers\b/i);
}

// Providers are created inside the tests: describe bodies run even when skipped.
(OPENAI_API_KEY ? describe : describe.skip)('OpenAI (live)', () => {
  jest.setTimeout(120000);

  it('the default model exists', async () => {
    const OpenAI = require('openai').default;
    const provider = new OpenAIProvider({ provider: 'openai', apiKey: OPENAI_API_KEY! });
    const model = await new OpenAI({ apiKey: OPENAI_API_KEY }).models.retrieve(provider.getDefaultModel());
    expect(model.id).toBe(provider.getDefaultModel());
  });

  it('validates the API key', async () => {
    const provider = new OpenAIProvider({ provider: 'openai', apiKey: OPENAI_API_KEY! });
    await expect(provider.validateApiKey()).resolves.toBe(true);
  });

  it('returns SQL for a simple question', async () => {
    const provider = new OpenAIProvider({ provider: 'openai', apiKey: OPENAI_API_KEY! });
    expectSimpleSql(await provider.generateWithSystem(SYSTEM, QUESTION));
  });
});

(ANTHROPIC_API_KEY ? describe : describe.skip)('Claude (live)', () => {
  jest.setTimeout(180000);

  it('the default model exists', async () => {
    const Anthropic = require('@anthropic-ai/sdk').default;
    const provider = new ClaudeProvider({ provider: 'claude', apiKey: ANTHROPIC_API_KEY! });
    const model = await new Anthropic({ apiKey: ANTHROPIC_API_KEY }).models.retrieve(provider.getDefaultModel());
    expect(model.id).toBe(provider.getDefaultModel());
  });

  it('validates the API key', async () => {
    const provider = new ClaudeProvider({ provider: 'claude', apiKey: ANTHROPIC_API_KEY! });
    await expect(provider.validateApiKey()).resolves.toBe(true);
  });

  it('returns SQL for a simple question (fallbacks and caching on)', async () => {
    const provider = new ClaudeProvider({ provider: 'claude', apiKey: ANTHROPIC_API_KEY! });
    expectSimpleSql(await provider.generateWithSystem(SYSTEM, QUESTION));
  });
});
