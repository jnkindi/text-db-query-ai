/**
 * Prisma ORM Adapter
 */

import {
  DatabaseSchema,
  TableSchema,
  ColumnSchema,
  ForeignKeySchema,
  DatabaseType,
} from '../types';
import { ORMAdapter, SchemaExtractionOptions, IntrospectionExecutor } from './types';
import { introspectSchema } from './introspection';

/**
 * Prisma adapter for automatic schema extraction and query execution
 */
export class PrismaAdapter implements ORMAdapter {
  private prisma: any;
  private databaseType: DatabaseType;
  private options: SchemaExtractionOptions;

  constructor(
    prisma: any,
    databaseType: DatabaseType = 'postgres',
    options: SchemaExtractionOptions = {}
  ) {
    this.prisma = prisma;
    this.databaseType = databaseType;
    this.options = options;
  }

  /**
   * Extract schema from Prisma by introspecting the database.
   *
   * Runs a fixed number of catalog queries through `$queryRawUnsafe`, whatever
   * the number of tables. BigInt values in catalog rows are converted to numbers.
   */
  async extractSchema(): Promise<DatabaseSchema> {
    const execute: IntrospectionExecutor = (sql, params) =>
      this.prisma.$queryRawUnsafe(sql, ...(params || []));
    try {
      return await introspectSchema(execute, this.databaseType, this.options);
    } catch (error: any) {
      throw new Error(`Failed to extract Prisma schema: ${error.message}`);
    }
  }

  /**
   * Execute a raw SQL query using Prisma.
   *
   * Parameters are bound with the database's placeholders (`$1` on PostgreSQL,
   * `?` on MySQL and SQLite, `@P1` on SQL Server). Results are returned as
   * Prisma gives them (BigInt for integer aggregates, for example).
   *
   * A failure is thrown as an Error with the 0.0.1 message ("Failed to execute
   * query: ..."), carrying the Prisma error's `code` and `meta` when it has
   * them, and the Prisma error itself as `cause`.
   *
   * @param query - SQL to run
   * @param parameters - Values bound to the placeholders
   */
  async executeQuery(query: string, parameters?: any[]): Promise<any> {
    try {
      if (parameters && parameters.length > 0) {
        return await this.prisma.$queryRawUnsafe(query, ...parameters);
      }
      return await this.prisma.$queryRawUnsafe(query);
    } catch (error: any) {
      throw wrapQueryError(error);
    }
  }

  /**
   * Get the database type
   */
  getDatabaseType(): string {
    return this.databaseType;
  }
}

/**
 * The executeQuery error for a failed Prisma call. The database's own error
 * code is in `meta.code` of a P2010 error (the SQLSTATE on Postgres), which
 * ChatbotHelper reads to tell a schema or syntax error it can repair from, say,
 * a permission error. `cause` is not enumerable, as with `new Error(message, { cause })`.
 */
function wrapQueryError(error: any): Error {
  const wrapped: Error & { code?: unknown; meta?: unknown } = new Error(`Failed to execute query: ${error?.message}`);
  if (error?.code !== undefined) wrapped.code = error.code;
  if (error?.meta !== undefined) wrapped.meta = error.meta;
  Object.defineProperty(wrapped, 'cause', { value: error, writable: true, configurable: true });
  return wrapped;
}

/**
 * Helper function to create a Prisma adapter from Prisma schema
 */
export function createPrismaAdapter(
  prismaClient: any,
  databaseType?: DatabaseType,
  options?: SchemaExtractionOptions
): PrismaAdapter {
  return new PrismaAdapter(prismaClient, databaseType, options);
}

// ---------------------------------------------------------------------------
// schema.prisma tokenizer
// ---------------------------------------------------------------------------

type PrismaTokenType = 'ident' | 'string' | 'number' | 'punct' | 'newline' | 'doc';

interface PrismaToken {
  type: PrismaTokenType;
  value: string;
  /** A string that reached the end of its line without a closing quote. */
  unterminated?: boolean;
}

const STRING_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t' };

function isIdentStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isIdentPart(code: number): boolean {
  return isIdentStart(code) || isDigit(code);
}

/**
 * Split a Prisma schema into tokens. `//` comments are dropped, `///` doc
 * comments are kept, and newlines are kept because they end fields. Never
 * throws: an unterminated string ends at the end of its line.
 */
function tokenizePrismaSchema(source: string): PrismaToken[] {
  const tokens: PrismaToken[] = [];
  const length = source.length;
  let i = 0;

  while (i < length) {
    const ch = source[i];
    const code = source.charCodeAt(i);

    if (ch === '\n') {
      tokens.push({ type: 'newline', value: '\n' });
      i++;
    } else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '﻿') {
      i++;
    } else if (ch === '/' && source[i + 1] === '/') {
      let end = source.indexOf('\n', i);
      if (end === -1) end = length;
      if (source[i + 2] === '/') {
        tokens.push({ type: 'doc', value: source.slice(i + 3, end).trim() });
      }
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < length && source[j] !== '"' && source[j] !== '\n') {
        if (source[j] === '\\' && j + 1 < length && source[j + 1] !== '\n') {
          value += STRING_ESCAPES[source[j + 1]] ?? source[j + 1];
          j += 2;
        } else {
          value += source[j];
          j++;
        }
      }
      if (source[j] === '"') {
        tokens.push({ type: 'string', value });
        i = j + 1;
      } else {
        tokens.push({ type: 'string', value, unterminated: true });
        i = j;
      }
    } else if (isIdentStart(code)) {
      let j = i + 1;
      while (j < length && isIdentPart(source.charCodeAt(j))) j++;
      tokens.push({ type: 'ident', value: source.slice(i, j) });
      i = j;
    } else if (isDigit(code) || (ch === '-' && isDigit(source.charCodeAt(i + 1)))) {
      let j = i + 1;
      while (j < length && (isDigit(source.charCodeAt(j)) || source[j] === '.')) j++;
      tokens.push({ type: 'number', value: source.slice(i, j) });
      i = j;
    } else if (ch === '@' && source[i + 1] === '@') {
      tokens.push({ type: 'punct', value: '@@' });
      i += 2;
    } else {
      tokens.push({ type: 'punct', value: ch });
      i++;
    }
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// schema.prisma parser
// ---------------------------------------------------------------------------

type PrismaValue =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'array'; items: PrismaValue[] }
  | { kind: 'call'; name: string; args: PrismaArgument[] };

interface PrismaArgument {
  name?: string;
  value: PrismaValue;
}

/** `@id`, `@db.VarChar(255)`, `@@map("users")`: name without the @ signs. */
interface PrismaAttribute {
  name: string;
  args: PrismaArgument[];
}

interface PrismaField {
  name: string;
  type: string;
  typeArgs: PrismaArgument[];
  optional: boolean;
  list: boolean;
  attributes: PrismaAttribute[];
  doc?: string;
}

interface PrismaBlock {
  keyword: string;
  name: string;
  /** Model and view fields, or enum values (with an empty type). */
  fields: PrismaField[];
  attributes: PrismaAttribute[];
  /** key = value pairs of datasource and generator blocks. */
  settings: Map<string, PrismaValue>;
  doc?: string;
}

const BLOCK_KEYWORDS = new Set(['model', 'view', 'enum', 'type', 'datasource', 'generator']);
const SETTINGS_BLOCKS = new Set(['datasource', 'generator']);

function isPunct(token: PrismaToken | undefined, value: string): boolean {
  return token !== undefined && token.type === 'punct' && token.value === value;
}

/**
 * Recursive-descent parser over the tokens. It is tolerant: anything it does
 * not understand is skipped up to the end of the line (or block), so it never
 * throws, whatever the input.
 */
class PrismaSchemaParser {
  private pos = 0;

  constructor(private readonly tokens: PrismaToken[]) {}

  parse(): PrismaBlock[] {
    const blocks: PrismaBlock[] = [];
    let docs: string[] = [];

    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];
      if (token.type === 'newline') {
        this.pos++;
        continue;
      }
      if (token.type === 'doc') {
        docs.push(token.value);
        this.pos++;
        continue;
      }
      const name = this.tokens[this.pos + 1];
      if (
        token.type === 'ident' &&
        BLOCK_KEYWORDS.has(token.value) &&
        name?.type === 'ident' &&
        isPunct(this.tokens[this.pos + 2], '{')
      ) {
        this.pos += 3;
        blocks.push(this.parseBlock(token.value, name.value, docs));
      } else if (isPunct(token, '{')) {
        this.skipBlock();
      } else {
        this.pos++;
      }
      docs = [];
    }

    return blocks;
  }

  /** Parse the body of a block whose opening brace was consumed. */
  private parseBlock(keyword: string, name: string, docs: string[]): PrismaBlock {
    const block: PrismaBlock = {
      keyword,
      name,
      fields: [],
      attributes: [],
      settings: new Map(),
      doc: joinDocs(docs),
    };
    let pending: string[] = [];

    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];
      if (isPunct(token, '}')) {
        this.pos++;
        break;
      }
      if (token.type === 'newline') {
        this.pos++;
        continue;
      }
      if (token.type === 'doc') {
        pending.push(token.value);
        this.pos++;
        continue;
      }

      if (isPunct(token, '@@')) {
        this.pos++;
        const attribute = this.parseAttribute();
        if (attribute) block.attributes.push(attribute);
      } else if (token.type === 'ident' && SETTINGS_BLOCKS.has(keyword)) {
        this.pos++;
        if (this.atPunct('=')) {
          this.pos++;
          const value = this.parseValue();
          if (value) block.settings.set(token.value, value);
        }
      } else if (token.type === 'ident') {
        this.pos++;
        const field = keyword === 'enum' ? this.parseEnumValue(token.value) : this.parseField(token.value);
        if (field) {
          const trailing = this.takeTrailingDoc();
          field.doc = joinDocs(trailing ? [...pending, trailing] : pending);
          block.fields.push(field);
        }
      }
      pending = [];
      this.skipToLineEnd();
    }

    return block;
  }

  /** `name Type[]? @attr(...) ...` after the field name. */
  private parseField(name: string): PrismaField | undefined {
    const typeToken = this.tokens[this.pos];
    if (!typeToken || typeToken.type !== 'ident') return undefined;
    this.pos++;

    const field: PrismaField = {
      name,
      type: typeToken.value,
      typeArgs: this.atPunct('(') ? this.parseArguments() : [],
      optional: false,
      list: false,
      attributes: [],
    };

    // Modifiers: `[]` and `?` (accepted in either order, to be lenient).
    for (;;) {
      if (this.atPunct('?')) {
        field.optional = true;
        this.pos++;
      } else if (this.atPunct('[') && isPunct(this.tokens[this.pos + 1], ']')) {
        field.list = true;
        this.pos += 2;
      } else {
        break;
      }
    }

    this.parseFieldAttributes(field.attributes);
    return field;
  }

  /** `VALUE @map("x")` inside an enum block. */
  private parseEnumValue(name: string): PrismaField {
    const value: PrismaField = { name, type: '', typeArgs: [], optional: false, list: false, attributes: [] };
    this.parseFieldAttributes(value.attributes);
    return value;
  }

  private parseFieldAttributes(attributes: PrismaAttribute[]): void {
    while (this.atPunct('@')) {
      this.pos++;
      const attribute = this.parseAttribute();
      if (attribute) attributes.push(attribute);
    }
  }

  /** Attribute name (`id`, `db.VarChar`) and optional arguments, after the @ or @@. */
  private parseAttribute(): PrismaAttribute | undefined {
    const name = this.parseDottedName();
    if (!name) return undefined;
    return { name, args: this.atPunct('(') ? this.parseArguments() : [] };
  }

  private parseDottedName(): string | undefined {
    const first = this.tokens[this.pos];
    if (!first || first.type !== 'ident') return undefined;
    this.pos++;
    let name = first.value;
    while (this.atPunct('.') && this.tokens[this.pos + 1]?.type === 'ident') {
      name += `.${this.tokens[this.pos + 1].value}`;
      this.pos += 2;
    }
    return name;
  }

  /** `( [name:] value, ... )`; newlines inside are ignored. Stops before a block's `}`. */
  private parseArguments(): PrismaArgument[] {
    const args: PrismaArgument[] = [];
    this.pos++; // (

    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];
      // An unterminated string cannot continue on the next line: end the list there.
      if (token.type === 'newline' && this.tokens[this.pos - 1]?.unterminated) break;
      if (token.type === 'newline' || isPunct(token, ',')) {
        this.pos++;
        continue;
      }
      if (isPunct(token, ')')) {
        this.pos++;
        break;
      }
      if (isPunct(token, '}')) break;

      let name: string | undefined;
      if (token.type === 'ident' && isPunct(this.tokens[this.pos + 1], ':')) {
        name = token.value;
        this.pos += 2;
      }
      const value = this.parseValue();
      if (value) args.push({ name, value });
      else if (this.pos < this.tokens.length && !this.atPunct(')') && !this.atPunct('}')) this.pos++;
    }

    return args;
  }

  private parseValue(): PrismaValue | undefined {
    const token = this.tokens[this.pos];
    if (!token) return undefined;

    if (token.type === 'string') {
      this.pos++;
      return { kind: 'string', value: token.value };
    }
    if (token.type === 'number') {
      this.pos++;
      return { kind: 'number', value: token.value };
    }
    if (token.type === 'ident') {
      const name = this.parseDottedName() as string;
      if (this.atPunct('(')) return { kind: 'call', name, args: this.parseArguments() };
      return { kind: 'ident', value: name };
    }
    if (isPunct(token, '[')) {
      this.pos++;
      const items: PrismaValue[] = [];
      while (this.pos < this.tokens.length) {
        const current = this.tokens[this.pos];
        if (current.type === 'newline' && this.tokens[this.pos - 1]?.unterminated) break;
        if (current.type === 'newline' || isPunct(current, ',')) {
          this.pos++;
          continue;
        }
        if (isPunct(current, ']')) {
          this.pos++;
          break;
        }
        if (isPunct(current, '}') || isPunct(current, ')')) break;
        const item = this.parseValue();
        if (item) items.push(item);
        else this.pos++;
      }
      return { kind: 'array', items };
    }
    return undefined;
  }

  /** A `///` comment at the end of the current line, if any. */
  private takeTrailingDoc(): string | undefined {
    for (let i = this.pos; i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.type === 'newline' || isPunct(token, '}')) return undefined;
      if (token.type === 'doc') return token.value;
    }
    return undefined;
  }

  /** Skip what is left of the line, but not a closing brace. */
  private skipToLineEnd(): void {
    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];
      if (token.type === 'newline' || isPunct(token, '}')) return;
      this.pos++;
    }
  }

  /** Skip a `{ ... }` block, nested braces included. */
  private skipBlock(): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos++];
      if (token.type !== 'punct') continue;
      if (token.value === '{') depth++;
      else if (token.value === '}' && --depth <= 0) return;
    }
  }

  private atPunct(value: string): boolean {
    return isPunct(this.tokens[this.pos], value);
  }
}

function joinDocs(docs: string[]): string | undefined {
  const text = docs.filter((doc) => doc !== '').join(' ');
  return text === '' ? undefined : text;
}

function findAttribute(attributes: PrismaAttribute[], name: string): PrismaAttribute | undefined {
  return attributes.find((attribute) => attribute.name === name);
}

/** The argument called `name`, or else the first positional argument. */
function argument(attribute: PrismaAttribute | undefined, name: string): PrismaValue | undefined {
  if (!attribute) return undefined;
  return namedArgument(attribute, name) ?? attribute.args.find((arg) => arg.name === undefined)?.value;
}

/** The argument called `name` only (for `fields:` and `references:`). */
function namedArgument(attribute: PrismaAttribute | undefined, name: string): PrismaValue | undefined {
  return attribute?.args.find((arg) => arg.name === name)?.value;
}

function stringArgument(attribute: PrismaAttribute | undefined, name: string): string | undefined {
  const value = argument(attribute, name);
  return value?.kind === 'string' ? value.value : undefined;
}

/** Field names of `[a, b(sort: Desc)]`. */
function fieldList(value: PrismaValue | undefined): string[] {
  if (!value) return [];
  const items = value.kind === 'array' ? value.items : [value];
  const names: string[] = [];
  for (const item of items) {
    if (item.kind === 'ident') names.push(item.value);
    else if (item.kind === 'call') names.push(item.name);
  }
  return names;
}

function valueText(value: PrismaValue): string {
  switch (value.kind) {
    case 'string':
    case 'number':
    case 'ident':
      return value.value;
    case 'array':
      return value.items.map(valueText).join(',');
    case 'call':
      return `${value.name}(${value.args.map((arg) => valueText(arg.value)).join(',')})`;
  }
}

// ---------------------------------------------------------------------------
// Prisma types
// ---------------------------------------------------------------------------

const SCALAR_TYPES = new Set([
  'String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes', 'Unsupported',
]);

/** Native column types Prisma uses when a field has no `@db.*` attribute. */
const PRISMA_DEFAULT_NATIVE_TYPES: Partial<Record<DatabaseType, Record<string, string>>> = {
  postgres: {
    String: 'text', Boolean: 'boolean', Int: 'integer', BigInt: 'bigint', Float: 'double precision',
    Decimal: 'decimal(65,30)', DateTime: 'timestamp(3)', Json: 'jsonb', Bytes: 'bytea',
  },
  mysql: {
    String: 'varchar(191)', Boolean: 'tinyint(1)', Int: 'int', BigInt: 'bigint', Float: 'double',
    Decimal: 'decimal(65,30)', DateTime: 'datetime(3)', Json: 'json', Bytes: 'longblob',
  },
  sqlite: {
    String: 'TEXT', Boolean: 'BOOLEAN', Int: 'INTEGER', BigInt: 'BIGINT', Float: 'REAL',
    Decimal: 'DECIMAL', DateTime: 'DATETIME', Json: 'TEXT', Bytes: 'BLOB',
  },
  mssql: {
    String: 'nvarchar(1000)', Boolean: 'bit', Int: 'int', BigInt: 'bigint', Float: 'float(53)',
    Decimal: 'decimal(32,16)', DateTime: 'datetime2', Bytes: 'varbinary(max)',
  },
};

const UNSIGNED_PREFIX = 'Unsigned';
const SINGLE_QUOTE = /'/g;
const BACKSLASH = /\\/g;

/** A value as MySQL writes it in COLUMN_TYPE: `it's` -> `'it''s'`, `a\b` -> `'a\\b'`. */
function mysqlEnumLiteral(value: string): string {
  return `'${value.replace(BACKSLASH, '\\\\').replace(SINGLE_QUOTE, "''")}'`;
}

/** `@db.VarChar(255)` -> "varchar(255)", `@db.UnsignedInt` -> "int unsigned", `@db.DoublePrecision` -> "double precision". */
function formatNativeType(attributeName: string, args: PrismaArgument[]): string {
  let name = attributeName.slice(3); // drop "db."
  let suffix = '';
  if (name.startsWith(UNSIGNED_PREFIX) && name.length > UNSIGNED_PREFIX.length) {
    name = name.slice(UNSIGNED_PREFIX.length);
    suffix = ' unsigned';
  }
  const base = name === 'DoublePrecision' ? 'double precision' : name.toLowerCase();
  const list = args.map((arg) => {
    const text = valueText(arg.value);
    return arg.value.kind === 'ident' ? text.toLowerCase() : text;
  });
  return `${base}${list.length > 0 ? `(${list.join(',')})` : ''}${suffix}`;
}

/**
 * Map Prisma types to SQL types
 */
function mapPrismaType(type: string): string {
  switch (type) {
    case 'Int':
    case 'BigInt':
      return 'integer';
    case 'String':
      return 'varchar';
    case 'Boolean':
      return 'boolean';
    case 'DateTime':
      return 'timestamp';
    case 'Float':
    case 'Decimal':
      return 'decimal';
    case 'Json':
      return 'json';
    default:
      return 'varchar';
  }
}

function providerToDatabaseType(provider: string | undefined): DatabaseType {
  switch (provider) {
    case 'mysql':
      return 'mysql';
    case 'sqlite':
      return 'sqlite';
    case 'sqlserver':
      return 'mssql';
    default:
      // postgresql, postgres, cockroachdb, and anything unknown (as in 0.0.1)
      return 'postgres';
  }
}

interface PrismaEnum {
  dbName: string;
  values: string[];
}

interface ResolvedModel {
  block: PrismaBlock;
  tableName: string;
  schema?: string;
  /** Prisma field name -> database column name */
  columnNames: Map<string, string>;
}

/**
 * Helper to extract schema from prisma.schema file.
 *
 * Reads `model` and `view` blocks as tables and `enum` blocks as the allowed
 * values of enum columns. Names keep their case and honor `@map` / `@@map`.
 * Relation fields are not columns: a relation with `fields` and `references`
 * becomes one foreign key per column pair. `///` comments become descriptions.
 * Never throws on malformed input.
 */
export function parsePrismaSchema(schemaContent: string): DatabaseSchema {
  const blocks = new PrismaSchemaParser(tokenizePrismaSchema(schemaContent)).parse();

  let provider: string | undefined;
  let sawDatasource = false;
  const enums = new Map<string, PrismaEnum>();
  const models = new Map<string, ResolvedModel>();

  for (const block of blocks) {
    if (block.keyword === 'datasource' && !sawDatasource) {
      sawDatasource = true;
      const value = block.settings.get('provider');
      if (value?.kind === 'string') provider = value.value;
    } else if (block.keyword === 'enum') {
      enums.set(block.name, {
        dbName: stringArgument(findAttribute(block.attributes, 'map'), 'name') ?? block.name,
        values: block.fields.map(
          (value) => stringArgument(findAttribute(value.attributes, 'map'), 'name') ?? value.name
        ),
      });
    } else if (block.keyword === 'model' || block.keyword === 'view') {
      const columnNames = new Map<string, string>();
      for (const field of block.fields) {
        columnNames.set(field.name, stringArgument(findAttribute(field.attributes, 'map'), 'name') ?? field.name);
      }
      models.set(block.name, {
        block,
        tableName: stringArgument(findAttribute(block.attributes, 'map'), 'name') ?? block.name,
        schema: stringArgument(findAttribute(block.attributes, 'schema'), 'name'),
        columnNames,
      });
    }
  }

  const databaseType = providerToDatabaseType(provider);
  const nativeDefaults = PRISMA_DEFAULT_NATIVE_TYPES[databaseType] ?? {};
  const tables: TableSchema[] = [];

  for (const model of models.values()) {
    const columns: ColumnSchema[] = [];
    const foreignKeys: ForeignKeySchema[] = [];
    let primaryKeyColumns: string[] = [];

    for (const field of model.block.fields) {
      const isScalar = SCALAR_TYPES.has(field.type);
      const enumInfo = isScalar ? undefined : enums.get(field.type);

      if (!isScalar && !enumInfo) {
        // Relation field (or a composite type): not a column.
        const target = models.get(field.type);
        const relation = findAttribute(field.attributes, 'relation');
        if (target && relation) {
          const from = fieldList(namedArgument(relation, 'fields'));
          const to = fieldList(namedArgument(relation, 'references'));
          const count = Math.min(from.length, to.length);
          for (let i = 0; i < count; i++) {
            const fk: ForeignKeySchema = {
              column: model.columnNames.get(from[i]) ?? from[i],
              referencedTable: target.tableName,
              referencedColumn: target.columnNames.get(to[i]) ?? to[i],
            };
            if (target.schema && target.schema !== model.schema) fk.referencedSchema = target.schema;
            foreignKeys.push(fk);
          }
        }
        continue;
      }

      const name = model.columnNames.get(field.name) ?? field.name;
      const column: ColumnSchema = {
        name,
        type: mapPrismaType(field.type),
        nullable: field.optional,
      };

      const nativeType = prismaNativeType(field, enumInfo, databaseType, nativeDefaults);
      if (nativeType) column.nativeType = nativeType;
      if (enumInfo && enumInfo.values.length > 0) column.enumValues = enumInfo.values;
      if (field.doc) column.description = field.doc;
      columns.push(column);

      if (findAttribute(field.attributes, 'id')) primaryKeyColumns = [name];
    }

    const compositeId = findAttribute(model.block.attributes, 'id');
    if (compositeId) {
      const fields = fieldList(argument(compositeId, 'fields'));
      if (fields.length > 0) {
        primaryKeyColumns = fields.map((field) => model.columnNames.get(field) ?? field);
      }
    }

    const table: TableSchema = {
      name: model.tableName,
      columns,
      primaryKey: primaryKeyColumns.length > 0 ? primaryKeyColumns.join(', ') : undefined,
      foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
    };
    if (primaryKeyColumns.length > 0) table.primaryKeyColumns = primaryKeyColumns;
    if (model.block.doc) table.description = model.block.doc;
    if (model.schema) table.schema = model.schema;
    tables.push(table);
  }

  return {
    databaseType,
    tables,
    exactNames: true,
  };
}

/** Native type from `@db.*`, `Unsupported("...")`, the enum, or Prisma's default for the database. */
function prismaNativeType(
  field: PrismaField,
  enumInfo: PrismaEnum | undefined,
  databaseType: DatabaseType,
  defaults: Record<string, string>
): string | undefined {
  const dbAttribute = field.attributes.find((attribute) => attribute.name.startsWith('db.'));
  let nativeType: string | undefined;

  if (dbAttribute) {
    nativeType = formatNativeType(dbAttribute.name, dbAttribute.args);
  } else if (field.type === 'Unsupported') {
    const declared = field.typeArgs[0]?.value;
    nativeType = declared?.kind === 'string' ? declared.value : undefined;
  } else if (enumInfo) {
    if (databaseType === 'postgres') nativeType = enumInfo.dbName;
    else if (databaseType === 'mysql') {
      nativeType = `enum(${enumInfo.values.map(mysqlEnumLiteral).join(',')})`;
    } else nativeType = defaults.String;
  } else {
    nativeType = defaults[field.type];
  }

  if (nativeType && field.list && databaseType === 'postgres') nativeType += '[]';
  return nativeType;
}
