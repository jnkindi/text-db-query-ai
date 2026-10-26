/**
 * Public API compatibility with 0.0.1.
 *
 * Compares the published 0.0.1 build (the devDependency alias
 * `text-db-query-ai-legacy`) with the current source:
 *
 * - every 0.0.1 export still exists, with the same kind (class, function, object)
 * - every 0.0.1 prototype and static method still exists
 * - the default export keeps its keys
 * - the constructors and factories accept the arguments the 0.0.1 README used
 * - (compile time) the 0.0.1 parameter and config types are still accepted
 *
 * Nothing here calls an LLM: constructing a provider makes no request.
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as Legacy from 'text-db-query-ai-legacy';
import type * as Current from '../../src';

const legacy: typeof Legacy = require('text-db-query-ai-legacy');
const current: typeof Current = require('../../src');

type AnyRecord = Record<string, any>;
type AnyClass = abstract new (...args: any[]) => any;

const legacyExports: AnyRecord = legacy;
const currentExports: AnyRecord = current;

/**
 * 0.0.1 methods that were `private` in its .d.ts and may be dropped, as
 * 'Class.method'. Public and protected methods can never be listed here.
 * Add an entry only with a comment saying where the behavior went.
 */
const ALLOWED_PRIVATE_REMOVALS: ReadonlySet<string> = new Set<string>([]);

const CLASS_SOURCE = /^class\b/;
const DTS_CLASS = /^export declare (?:abstract )?class (\w+)/;
const DTS_PRIVATE_MEMBER = /^\s+private (?:static )?(?:readonly )?(\w+)/;
const BUILTIN_STATICS = new Set(['length', 'name', 'prototype', 'arguments', 'caller']);

/** 'class', 'function', 'object', ...: native classes are told apart from functions by their source. */
function kindOf(value: unknown): string {
  if (typeof value === 'function') {
    return CLASS_SOURCE.test(Function.prototype.toString.call(value)) ? 'class' : 'function';
  }
  return value === null ? 'null' : typeof value;
}

/**
 * Own and inherited members of `start`, stopping before `stop`, as name -> typeof
 * value ('accessor' for getters/setters). The nearest definition wins.
 */
function members(start: object | null, stop: object, skip: ReadonlySet<string>): Map<string, string> {
  const found = new Map<string, string>();
  for (let obj = start; obj && obj !== stop; obj = Object.getPrototypeOf(obj)) {
    for (const name of Object.getOwnPropertyNames(obj)) {
      if (skip.has(name) || found.has(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(obj, name)!;
      found.set(name, 'value' in descriptor ? typeof descriptor.value : 'accessor');
    }
  }
  return found;
}

const SKIP_PROTOTYPE = new Set(['constructor']);
const prototypeMembers = (cls: AnyClass) => members(cls.prototype, Object.prototype, SKIP_PROTOTYPE);
const staticMembers = (cls: AnyClass) => members(cls, Function.prototype, BUILTIN_STATICS);

/** Members that 0.0.1 is missing from `now`, or that changed typeof, as readable strings. */
function missingMembers(before: Map<string, string>, now: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [name, type] of before) {
    const actual = now.get(name);
    if (actual !== type) problems.push(actual ? `${name} (${type} -> ${actual})` : name);
  }
  return problems;
}

/** Private member names per class, read from the 0.0.1 declaration files. */
function legacyPrivateMembers(): Map<string, Set<string>> {
  const distDir = path.dirname(require.resolve('text-db-query-ai-legacy'));
  const result = new Map<string, Set<string>>();
  for (const file of fs.readdirSync(distDir, { recursive: true, encoding: 'utf8' })) {
    if (!file.endsWith('.d.ts')) continue;
    let privates: Set<string> | undefined;
    for (const line of fs.readFileSync(path.join(distDir, file), 'utf8').split('\n')) {
      const cls = DTS_CLASS.exec(line);
      if (cls) {
        privates = new Set();
        result.set(cls[1], privates);
        continue;
      }
      const member = privates && DTS_PRIVATE_MEMBER.exec(line);
      if (member) privates!.add(member[1]);
    }
  }
  return result;
}

const LEGACY_PRIVATES = legacyPrivateMembers();
const legacyClassNames = Object.keys(legacyExports)
  .filter((name) => kindOf(legacyExports[name]) === 'class')
  .sort();

describe('0.0.1 API surface', () => {
  it('keeps every named export with the same kind', () => {
    const problems = Object.keys(legacyExports)
      .filter((name) => kindOf(currentExports[name]) !== kindOf(legacyExports[name]))
      .map((name) => `${name}: ${kindOf(legacyExports[name])} -> ${kindOf(currentExports[name])}`);
    expect(problems).toEqual([]);
  });

  it('keeps the CommonJS interop marker', () => {
    expect(currentExports.__esModule).toBe(legacyExports.__esModule);
  });

  it('finds the 0.0.1 classes to compare', () => {
    // Guards the describe.each below (and the class detection) against
    // silently comparing nothing.
    expect(legacyClassNames).toEqual([
      'BaseLLMProvider', 'ChatbotHelper', 'ClaudeProvider', 'DatabaseIntrospectionAdapter',
      'OpenAIProvider', 'PrismaAdapter', 'QueryGenerator', 'QuerySanitizer',
      'SchemaAnalyzer', 'SecurityValidator', 'TextToQueryError',
    ]);
    expect(LEGACY_PRIVATES.get('QueryGenerator')).toContain('buildPrompt');
  });

  describe.each(legacyClassNames)('%s', (name) => {
    const before: AnyClass = legacyExports[name];
    const now: AnyClass = currentExports[name];
    const exists = typeof now === 'function';
    // Entries look like 'method' or 'method (function -> accessor)'.
    const missing = exists ? missingMembers(prototypeMembers(before), prototypeMembers(now)) : ['(class missing)'];
    const missingStatics = exists ? missingMembers(staticMembers(before), staticMembers(now)) : ['(class missing)'];
    const privates = LEGACY_PRIVATES.get(name) ?? new Set<string>();
    const memberName = (entry: string) => entry.split(' ', 1)[0];

    it('keeps every public and protected prototype method', () => {
      expect(missing.filter((entry) => !privates.has(memberName(entry)))).toEqual([]);
    });

    it('keeps every private prototype method unless its removal is recorded', () => {
      const unrecorded = missing.filter((entry) =>
        privates.has(memberName(entry)) && !ALLOWED_PRIVATE_REMOVALS.has(`${name}.${memberName(entry)}`));
      expect(unrecorded).toEqual([]);
    });

    it('keeps every static member', () => {
      expect(missingStatics).toEqual([]);
    });
  });

  it('only allows recorded removals of methods that were private in 0.0.1', () => {
    const invalid = [...ALLOWED_PRIVATE_REMOVALS].filter((entry) => {
      const [cls, member] = entry.split('.');
      return !LEGACY_PRIVATES.get(cls)?.has(member);
    });
    expect(invalid).toEqual([]);
  });

  it('keeps the default export keys, kinds and identities', () => {
    const before: AnyRecord = legacy.default;
    const now: AnyRecord = current.default;
    const problems: string[] = [];
    for (const key of Object.keys(before)) {
      if (!(key in now)) {
        problems.push(`${key}: missing`);
      } else if (kindOf(now[key]) !== kindOf(before[key])) {
        problems.push(`${key}: ${kindOf(before[key])} -> ${kindOf(now[key])}`);
      } else if (before[key] === legacyExports[key] && now[key] !== currentExports[key]) {
        // In 0.0.1, default.X is the same object as the named export X.
        problems.push(`${key}: no longer the named export`);
      }
    }
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Constructors and factories, called the way the 0.0.1 README calls them
// ---------------------------------------------------------------------------

const API_KEY = 'sk-test-not-a-real-key';

/** The "Manual Schema Definition" example from the 0.0.1 README. */
const README_SCHEMA = {
  databaseType: 'postgres' as const,
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
      foreignKeys: [{ column: 'user_id', referencedTable: 'users', referencedColumn: 'id' }],
    },
  ],
};

const PRISMA_SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id     Int     @id @default(autoincrement())
  email  String  @unique
  name   String?
  orders Order[]
}

model Order {
  id     Int  @id
  userId Int
  user   User @relation(fields: [userId], references: [id])
}
`;

const PROVIDERS = ['openai', 'claude'] as const;
const USER = { userId: 123, role: 'user' };

/** A pg-style connection and a Prisma-style client that never touch a database. */
const fakePg = () => ({ query: async () => ({ rows: [] }) });
const fakePrisma = () => ({ $queryRawUnsafe: async () => [], $queryRaw: async () => [] });

/**
 * sqlite3 is a native module. Installed with --ignore-scripts (the publish job),
 * its binding is missing and the database-backed tests below are skipped.
 */
function loadSqlite3(): typeof import('sqlite3') | undefined {
  try {
    return require('sqlite3');
  } catch {
    return undefined;
  }
}
const sqlite3 = loadSqlite3();
const describeIfSqlite = sqlite3 ? describe : describe.skip;

describe('0.0.1 constructors and factories', () => {
  it.each(PROVIDERS)('createQueryGenerator and new QueryGenerator accept the README config (%s)', (provider) => {
    const config = { llm: { provider, apiKey: API_KEY }, database: README_SCHEMA };
    for (const generator of [current.createQueryGenerator(config), new current.QueryGenerator(config)]) {
      expect(generator).toBeInstanceOf(current.QueryGenerator);
      expect(generator.getSchema()).toContain('users');
    }

    const secured = new current.QueryGenerator({
      ...config,
      security: {
        allowedOperations: ['SELECT'],
        maxRowLimit: 100,
        enableRowLevelSecurity: true,
        requireUserContext: true,
        restrictedColumns: ['password', 'ssn', 'credit_card'],
      },
      userContext: USER,
      debug: false,
    });
    expect(secured).toBeInstanceOf(current.QueryGenerator);
  });

  it.each(PROVIDERS)('createLLMProvider builds the %s provider', (provider) => {
    const llm = current.createLLMProvider({ provider, apiKey: API_KEY });
    const expected = provider === 'openai' ? current.OpenAIProvider : current.ClaudeProvider;
    expect(llm).toBeInstanceOf(expected);
    expect(llm).toBeInstanceOf(current.BaseLLMProvider);
    expect(typeof llm.getDefaultModel()).toBe('string');
    expect(llm.getDefaultModel().length).toBeGreaterThan(0);
  });

  it('constructs the providers directly, with and without a model', () => {
    expect(new current.OpenAIProvider({ provider: 'openai', apiKey: API_KEY })).toBeInstanceOf(current.BaseLLMProvider);
    expect(new current.ClaudeProvider({ provider: 'claude', apiKey: API_KEY, model: 'claude-3-5-sonnet-20241022' }))
      .toBeInstanceOf(current.BaseLLMProvider);
  });

  it('rejects an unknown provider with the 0.0.1 error', () => {
    const config = { provider: 'gemini', apiKey: API_KEY } as any;
    const capture = (fn: () => unknown) => {
      try {
        fn();
      } catch (error: any) {
        return { name: error.name, code: error.code, message: error.message };
      }
      return undefined;
    };
    expect(capture(() => current.createLLMProvider(config))).toEqual(capture(() => legacy.createLLMProvider(config)));
  });

  it('lets a 0.0.1-style subclass of BaseLLMProvider implement only the 0.0.1 methods', () => {
    class EchoProvider extends current.BaseLLMProvider {
      async generate(prompt: string): Promise<string> {
        return prompt;
      }
      async validateApiKey(): Promise<boolean> {
        return true;
      }
      getDefaultModel(): string {
        return 'echo';
      }
      exposedConfig() {
        return this.config; // protected in 0.0.1
      }
    }
    const config = { provider: 'openai' as const, apiKey: API_KEY };
    const provider = new EchoProvider(config);
    expect(provider.exposedConfig()).toBe(config);
  });

  it('constructs SecurityValidator, QuerySanitizer and SchemaAnalyzer as in 0.0.1', async () => {
    const validators = [
      new current.SecurityValidator(),
      new current.SecurityValidator({ allowedOperations: ['SELECT'], maxRowLimit: 100 }),
    ];
    for (const validator of validators) {
      const result = await validator.validate('SELECT id FROM users LIMIT 10', USER);
      expect(Object.keys(result).sort()).toEqual(['errors', 'valid', 'warnings']);
    }

    const sanitizer = new current.QuerySanitizer();
    expect(typeof sanitizer.sanitize('SELECT id FROM users')).toBe('string');

    const analyzer = new current.SchemaAnalyzer(README_SCHEMA);
    expect(analyzer.getTableNames()).toEqual(new legacy.SchemaAnalyzer(README_SCHEMA).getTableNames());
  });

  it('constructs the adapters with the 0.0.1 arguments', () => {
    const pairs: Array<[{ getDatabaseType(): string }, { getDatabaseType(): string }]> = [
      [new current.PrismaAdapter(fakePrisma()), new legacy.PrismaAdapter(fakePrisma())],
      [current.createPrismaAdapter(fakePrisma(), 'mysql'), legacy.createPrismaAdapter(fakePrisma(), 'mysql')],
      [
        new current.DatabaseIntrospectionAdapter(fakePg(), 'postgres'),
        new legacy.DatabaseIntrospectionAdapter(fakePg(), 'postgres'),
      ],
      [current.createDatabaseAdapter(fakePg(), 'sqlite', {}), legacy.createDatabaseAdapter(fakePg(), 'sqlite', {})],
    ];
    for (const [now, before] of pairs) {
      expect(now.getDatabaseType()).toBe(before.getDatabaseType());
    }
  });

  it('constructs ChatbotHelper and keeps the generator the README reads from it', () => {
    const generator = current.createQueryGenerator({ llm: { provider: 'openai', apiKey: API_KEY }, database: README_SCHEMA });
    const helper = new current.ChatbotHelper(generator, current.createDatabaseAdapter(fakePg(), 'postgres'));
    // The 0.0.1 README calls chatbot.generator.validateApiKey().
    expect((helper as any).generator).toBe(generator);
  });

  it('constructs TextToQueryError with the 0.0.1 fields', () => {
    const details = { cause: 'test' };
    const error = new current.TextToQueryError('Something failed', 'QUERY_GENERATION_FAILED', details);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(current.TextToQueryError);
    expect({ name: error.name, message: error.message, code: error.code, details: error.details }).toEqual({
      name: 'TextToQueryError',
      message: 'Something failed',
      code: 'QUERY_GENERATION_FAILED',
      details,
    });
  });

  it('parses a Prisma schema into the 0.0.1 shape', () => {
    const before = legacy.parsePrismaSchema(PRISMA_SCHEMA);
    const now = current.parsePrismaSchema(PRISMA_SCHEMA);
    expect(now.databaseType).toBe(before.databaseType);
    expect(now.tables).toHaveLength(before.tables.length);
  });

  describeIfSqlite('README quick start against an in-memory SQLite database', () => {
    let db: import('sqlite3').Database;
    let all: (sql: string, params?: unknown[]) => Promise<unknown[]>;
    // A Prisma-style client over the same database ($queryRawUnsafe and $queryRaw).
    let prisma: object;
    const config = { llmProvider: 'openai' as const, apiKey: API_KEY };

    beforeAll(async () => {
      db = new sqlite3!.Database(':memory:');
      await new Promise<void>((resolve, reject) => db.exec(`
        CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT);
        CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), total REAL);
      `, (error) => (error ? reject(error) : resolve())));
      all = (sql, params = []) =>
        new Promise((resolve, reject) => db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))));
      prisma = {
        $queryRawUnsafe: (sql: string, ...values: unknown[]) => all(sql, values),
        $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => all(strings.join('?'), values),
      };
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => (db ? db.close(() => resolve()) : resolve()));
    });

    it('createChatbotFromDatabase(connection, type, { llmProvider, apiKey })', async () => {
      const chatbot = await current.createChatbotFromDatabase(db, 'sqlite', config);
      expect(chatbot).toBeInstanceOf(current.ChatbotHelper);
      expect((chatbot as any).generator.getSchema()).toContain('orders');
    });

    it('createChatbotFromPrisma(prisma, type, { llmProvider, apiKey, model })', async () => {
      const chatbot = await current.createChatbotFromPrisma(prisma, 'sqlite', {
        llmProvider: 'claude',
        apiKey: API_KEY,
        model: 'claude-3-5-sonnet-20241022',
      });
      expect(chatbot).toBeInstanceOf(current.ChatbotHelper);
      expect((chatbot as any).generator.getSchema()).toContain('users');
    });

    it('createFromDatabase and createFromPrisma return a QueryGenerator', async () => {
      expect(await current.createFromDatabase(db, 'sqlite', config)).toBeInstanceOf(current.QueryGenerator);
      expect(await current.createFromPrisma(prisma, 'sqlite', { ...config, debug: false }))
        .toBeInstanceOf(current.QueryGenerator);
    });
  });
});

// ---------------------------------------------------------------------------
// Compile-time checks: ts-jest type-checks this file, so a failed Assert below
// fails the suite with "Type 'false' does not satisfy the constraint 'true'".
// ---------------------------------------------------------------------------

type Assert<T extends true> = T;
/** True when every value of A is also a value of B. */
type Extends<A, B> = [A] extends [B] ? true : false;
type Both<A, B> = Extends<A, B> extends true ? Extends<B, A> : false;

/**
 * True when every public 0.0.1 method of L exists on C, accepts the arguments
 * it accepted in 0.0.1, and returns something a 0.0.1 caller can still use.
 */
type MethodsCompatible<L, C> = {
  [K in keyof L]-?: K extends keyof C
    ? L[K] extends (...args: infer A) => infer R
      ? C[K] extends (...args: any[]) => any
        ? Extends<A, Parameters<C[K]>> extends true
          ? Extends<ReturnType<C[K]>, R>
          : false
        : false
      : true
    : false;
}[keyof L];

/** True when a call that compiled against 0.0.1 still compiles. */
type AcceptsLegacyArgs<L extends (...args: any) => any, C extends (...args: any) => any> =
  Extends<Parameters<L>, Parameters<C>>;
type AcceptsLegacyCtorArgs<L extends AnyClass, C extends AnyClass> =
  Extends<ConstructorParameters<L>, ConstructorParameters<C>>;

export type TypeChecks = [
  // Inputs: everything 0.0.1 accepted is still accepted.
  Assert<Extends<Legacy.LLMProvider, Current.LLMProvider>>,
  Assert<Extends<Legacy.DatabaseType, Current.DatabaseType>>,
  Assert<Extends<Legacy.QueryOperation, Current.QueryOperation>>,
  Assert<Extends<Legacy.UserContext, Current.UserContext>>,
  Assert<Extends<Legacy.SecurityConfig, Current.SecurityConfig>>,
  Assert<Extends<Legacy.LLMConfig, Current.LLMConfig>>,
  Assert<Extends<Legacy.TextToQueryConfig, Current.TextToQueryConfig>>,
  Assert<Extends<Legacy.EasySetupConfig, Current.EasySetupConfig>>,
  Assert<Extends<Legacy.SchemaExtractionOptions, Current.SchemaExtractionOptions>>,
  // Custom adapters written against 0.0.1 still satisfy the interface.
  Assert<Extends<Legacy.ORMAdapter, Current.ORMAdapter>>,
  // Schema types are passed in and returned: both directions.
  Assert<Both<Legacy.ColumnSchema, Current.ColumnSchema>>,
  Assert<Both<Legacy.ForeignKeySchema, Current.ForeignKeySchema>>,
  Assert<Both<Legacy.TableSchema, Current.TableSchema>>,
  Assert<Both<Legacy.DatabaseSchema, Current.DatabaseSchema>>,
  // Outputs: code that reads a 0.0.1 result still compiles.
  Assert<Extends<Current.QueryResult, Legacy.QueryResult>>,

  // Functions and constructors.
  Assert<AcceptsLegacyArgs<typeof Legacy.createQueryGenerator, typeof Current.createQueryGenerator>>,
  Assert<AcceptsLegacyArgs<typeof Legacy.createLLMProvider, typeof Current.createLLMProvider>>,
  Assert<AcceptsLegacyArgs<typeof Legacy.createPrismaAdapter, typeof Current.createPrismaAdapter>>,
  Assert<AcceptsLegacyArgs<typeof Legacy.createDatabaseAdapter, typeof Current.createDatabaseAdapter>>,
  Assert<AcceptsLegacyArgs<typeof Legacy.parsePrismaSchema, typeof Current.parsePrismaSchema>>,
  Assert<AcceptsLegacyArgs<typeof Legacy.createFromPrisma, typeof Current.createFromPrisma>>,
  Assert<AcceptsLegacyArgs<typeof Legacy.createFromDatabase, typeof Current.createFromDatabase>>,
  Assert<AcceptsLegacyArgs<typeof Legacy.createChatbotFromPrisma, typeof Current.createChatbotFromPrisma>>,
  Assert<AcceptsLegacyArgs<typeof Legacy.createChatbotFromDatabase, typeof Current.createChatbotFromDatabase>>,
  Assert<AcceptsLegacyCtorArgs<typeof Legacy.QueryGenerator, typeof Current.QueryGenerator>>,
  Assert<AcceptsLegacyCtorArgs<typeof Legacy.SecurityValidator, typeof Current.SecurityValidator>>,
  Assert<AcceptsLegacyCtorArgs<typeof Legacy.QuerySanitizer, typeof Current.QuerySanitizer>>,
  Assert<AcceptsLegacyCtorArgs<typeof Legacy.SchemaAnalyzer, typeof Current.SchemaAnalyzer>>,
  Assert<AcceptsLegacyCtorArgs<typeof Legacy.BaseLLMProvider, typeof Current.BaseLLMProvider>>,
  Assert<AcceptsLegacyCtorArgs<typeof Legacy.OpenAIProvider, typeof Current.OpenAIProvider>>,
  Assert<AcceptsLegacyCtorArgs<typeof Legacy.ClaudeProvider, typeof Current.ClaudeProvider>>,
  Assert<AcceptsLegacyCtorArgs<typeof Legacy.PrismaAdapter, typeof Current.PrismaAdapter>>,
  Assert<AcceptsLegacyCtorArgs<typeof Legacy.DatabaseIntrospectionAdapter, typeof Current.DatabaseIntrospectionAdapter>>,
  Assert<AcceptsLegacyCtorArgs<typeof Legacy.TextToQueryError, typeof Current.TextToQueryError>>,
  // ChatbotHelper's constructor takes class instances, which TypeScript
  // compares nominally (private members), so it is covered at runtime above.

  // Public methods.
  Assert<MethodsCompatible<Legacy.QueryGenerator, Current.QueryGenerator>>,
  Assert<MethodsCompatible<Legacy.SecurityValidator, Current.SecurityValidator>>,
  Assert<MethodsCompatible<Legacy.QuerySanitizer, Current.QuerySanitizer>>,
  Assert<MethodsCompatible<Legacy.SchemaAnalyzer, Current.SchemaAnalyzer>>,
  Assert<MethodsCompatible<Legacy.BaseLLMProvider, Current.BaseLLMProvider>>,
  Assert<MethodsCompatible<Legacy.OpenAIProvider, Current.OpenAIProvider>>,
  Assert<MethodsCompatible<Legacy.ClaudeProvider, Current.ClaudeProvider>>,
  Assert<MethodsCompatible<Legacy.PrismaAdapter, Current.PrismaAdapter>>,
  Assert<MethodsCompatible<Legacy.DatabaseIntrospectionAdapter, Current.DatabaseIntrospectionAdapter>>,
  Assert<MethodsCompatible<Legacy.ChatbotHelper, Current.ChatbotHelper>>,
];
