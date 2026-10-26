import {
  TextToQueryConfig,
  QueryResult,
  UserContext,
  TextToQueryError,
  QueryOperation,
  IdentifierCheckMode,
} from '../types';
import { createLLMProvider, BaseLLMProvider } from '../providers';
import { SecurityValidator, QuerySanitizer } from '../security';
import { SchemaAnalyzer } from '../schema';
import { analyzeSql, SqlAnalysis, SqlDialect, SqlLexError, toSqlDialect, Token } from '../sql';
import { IdentifierChecker, IdentifierInspection, IdentifierIssue } from './identifier-check';
import {
  buildExecutionFeedback,
  buildExplanationPrompt,
  buildIdentifierFeedback,
  buildSyntaxFeedback,
  buildSystemPrompt,
  buildUserMessage,
  EXPLANATION_SYSTEM_PROMPT,
  parseCannotAnswer,
  TableColumns,
} from './prompt';

/** The validator's row limit when security.maxRowLimit is not set. */
const DEFAULT_MAX_ROW_LIMIT = 1000;
/** Longest database error text sent back to the model by repairQuery(). */
const MAX_ERROR_LENGTH = 500;
/** Longest model output written to the debug log. */
const LOG_PREVIEW_LENGTH = 100;

const SET_OPERATIONS: ReadonlySet<string> = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS']);
const JOIN_WORDS: ReadonlySet<string> = new Set(['JOIN', 'APPLY', 'STRAIGHT_JOIN']);
const OPERATION_PREFIXES: QueryOperation[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/** A syntactically valid answer and its identifier check. */
interface Candidate {
  query: string;
  inspection: IdentifierInspection;
}

/**
 * Main query generator class
 */
export class QueryGenerator {
  private config: TextToQueryConfig;
  private llmProvider: BaseLLMProvider;
  private securityValidator: SecurityValidator;
  private sanitizer: QuerySanitizer;
  private schemaAnalyzer: SchemaAnalyzer;
  private dialect: SqlDialect;
  /** Rendered on first use and reused for every request (see getSystemPrompt). */
  private systemPrompt?: string;
  private identifierChecker?: IdentifierChecker;

  constructor(config: TextToQueryConfig) {
    this.config = config;
    this.llmProvider = config.llmProvider ?? createLLMProvider(config.llm);
    const databaseType = config.database?.databaseType;
    this.dialect = toSqlDialect(databaseType);
    this.securityValidator = new SecurityValidator(config.security, {
      databaseType,
      schema: config.database,
    });
    this.sanitizer = new QuerySanitizer(databaseType);
    this.schemaAnalyzer = new SchemaAnalyzer(config.database);

    this.log('QueryGenerator initialized');
  }

  /**
   * Generate a database query from natural language text.
   *
   * The model gets the schema and rules in a cached system prompt and the
   * question (and user context) in the user message. Its answer is cleaned,
   * checked for syntax and checked against the schema; on a problem the model
   * is asked to correct the query (`maxCorrectionAttempts`, default 1). Then
   * row-level security and the row limit are applied and the query is
   * validated. A security validation failure is never retried.
   *
   * @param userInput - The question
   * @param userContext - The user asking (default: `config.userContext`)
   * @throws TextToQueryError `INVALID_SQL_SYNTAX` when the answer is not a valid
   *   query (with `details.cannotAnswer` when the model said the schema cannot
   *   answer the question), `SECURITY_VALIDATION_FAILED`, `UNKNOWN_IDENTIFIERS`
   *   (only with `identifierCheck: 'strict'`) or `QUERY_GENERATION_FAILED`
   */
  async generateQuery(
    userInput: string,
    userContext?: UserContext
  ): Promise<QueryResult> {
    return this.run(userInput, userContext);
  }

  /**
   * Generate a corrected query after `failedQuery` failed to execute, sending
   * the database error (truncated to 500 characters) to the model. The result
   * goes through the same checks as generateQuery(). Used by ChatbotHelper
   * when `repairAttempts` is set.
   *
   * @param userInput - The original question
   * @param failedQuery - The query that failed
   * @param errorMessage - The database error message
   * @param userContext - The user asking (default: `config.userContext`)
   */
  async repairQuery(
    userInput: string,
    failedQuery: string,
    errorMessage: string,
    userContext?: UserContext
  ): Promise<QueryResult> {
    const message = String(errorMessage ?? '');
    const truncated = message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message;
    this.log('Repairing a query that failed to execute');
    return this.run(userInput, userContext, buildExecutionFeedback(failedQuery, truncated));
  }

  /**
   * Generate query with detailed explanation
   */
  async generateQueryWithExplanation(
    userInput: string,
    userContext?: UserContext
  ): Promise<QueryResult> {
    const result = await this.generateQuery(userInput, userContext);

    return {
      ...result,
      explanation: await this.explainQuery(result.query),
    };
  }

  /**
   * Ask the model to explain a query in plain language. Makes one model call
   * with a short system prompt of its own.
   *
   * @param query - SQL to explain
   */
  async explainQuery(query: string): Promise<string> {
    const explanation = await this.llmProvider.generateWithSystem(
      EXPLANATION_SYSTEM_PROMPT,
      buildExplanationPrompt(query)
    );
    return this.sanitizer.extractFromMarkdown(explanation);
  }

  /**
   * The pipeline shared by generateQuery() and repairQuery(). `initialFeedback`
   * is appended to the first request (the execution error for a repair).
   *
   * Corrections never make a request fail that would have succeeded without
   * them: when a correction call fails, abstains, returns invalid SQL, or
   * returns a query that fails validation, the earlier answer is returned
   * with warnings (except in `strict` mode, which throws).
   */
  private async run(
    userInput: string,
    userContext: UserContext | undefined,
    initialFeedback?: string
  ): Promise<QueryResult> {
    try {
      this.log(`Generating query for input: "${userInput}"`);

      // Use provided user context or fall back to config
      const context = userContext || this.config.userContext;
      const security = this.config.security;
      const applyRowLevelSecurity = !!(security?.enableRowLevelSecurity && context);

      const system = this.getSystemPrompt();
      const message = buildUserMessage(userInput, context, {
        rowLevelSecurityColumn: applyRowLevelSecurity ? security?.rowLevelSecurityColumn || 'user_id' : undefined,
      });

      const mode: IdentifierCheckMode = this.config.identifierCheck ?? 'retry';
      const maxCorrections = correctionLimit(this.config.maxCorrectionAttempts);
      /** Syntactically valid answers, in order; all but the last have identifier issues. */
      const candidates: Candidate[] = [];
      const notes: string[] = [];
      let feedback = initialFeedback;
      let syntaxError: TextToQueryError | undefined;
      let attempts = 0;

      for (;;) {
        attempts++;
        let raw: string;
        try {
          raw = await this.llmProvider.generateWithSystem(system, feedback ? `${message}\n\n${feedback}` : message);
          if (typeof raw !== 'string') throw new Error('The LLM provider returned no text');
        } catch (error: any) {
          if (attempts === 1) throw error;
          // A failed correction call leaves the earlier outcome in place.
          this.log(`Correction call failed: ${error?.message}`);
          if (candidates.length === 0) throw syntaxError ?? error;
          notes.push(`The query could not be corrected: ${error?.message}`);
          break;
        }
        this.log(`Received LLM response (attempt ${attempts}): ${raw.substring(0, LOG_PREVIEW_LENGTH)}...`);

        const extracted = this.sanitizer.extractFromMarkdown(raw);
        const reason = parseCannotAnswer(extracted) ?? parseCannotAnswer(raw);
        if (reason !== null) {
          if (candidates.length === 0) {
            throw new TextToQueryError(
              `The question cannot be answered from the schema${reason ? `: ${reason}` : ''}`,
              'INVALID_SQL_SYNTAX',
              { cannotAnswer: true, reason }
            );
          }
          notes.push(`The model could not correct the query${reason ? `: ${reason}` : ''}`);
          break;
        }

        const query = this.sanitizer.sanitize(extracted);
        const canCorrect = attempts <= maxCorrections;

        // Validate SQL syntax
        const syntaxValidation = this.sanitizer.validateSQLSyntax(query);
        if (!syntaxValidation.valid) {
          syntaxError = new TextToQueryError(
            `Invalid SQL syntax: ${syntaxValidation.error}`,
            'INVALID_SQL_SYNTAX'
          );
          if (canCorrect) {
            this.log(`Invalid SQL syntax (${syntaxValidation.error}), asking for a correction`);
            feedback = buildSyntaxFeedback(query, syntaxValidation.error);
            continue;
          }
          if (candidates.length === 0) throw syntaxError;
          break;
        }
        syntaxError = undefined;

        const inspection = this.inspect(query, mode);
        candidates.push({ query, inspection });
        if (inspection.issues.length > 0 && (mode === 'retry' || mode === 'strict') && canCorrect) {
          this.log(`Query references ${inspection.issues.length} unknown identifier(s), asking for a correction`);
          feedback = this.identifierFeedback(query, inspection);
          continue;
        }
        break;
      }

      const final = candidates[candidates.length - 1];
      if (mode === 'strict' && final.inspection.issues.length > 0) {
        const issues = final.inspection.issues;
        throw new TextToQueryError(
          `Query references identifiers that are not in the schema: ${issues.map((i) => i.message).join('; ')}`,
          'UNKNOWN_IDENTIFIERS',
          { issues, query: final.query, attempts }
        );
      }

      try {
        return await this.finish(final, userInput, context, applyRowLevelSecurity, mode, attempts, notes);
      } catch (error: any) {
        // A corrected query that fails validation: return the answer it corrected,
        // as it would have been returned without the correction.
        if (!(error instanceof TextToQueryError) || error.code !== 'SECURITY_VALIDATION_FAILED' || mode !== 'retry') {
          throw error;
        }
        for (let i = candidates.length - 2; i >= 0; i--) {
          try {
            const fallbackNotes = [...notes, 'The corrected query failed security validation, so the original answer is returned'];
            return await this.finish(candidates[i], userInput, context, applyRowLevelSecurity, mode, attempts, fallbackNotes);
          } catch {
            // try the one before
          }
        }
        throw error;
      }
    } catch (error: any) {
      this.log(`Error generating query: ${error?.message}`);
      if (error instanceof TextToQueryError) {
        throw error;
      }
      throw new TextToQueryError(
        `Failed to generate query: ${error?.message}`,
        'QUERY_GENERATION_FAILED',
        error
      );
    }
  }

  /**
   * Row-level security, the row limit, validation and metadata for a
   * checked answer.
   */
  private async finish(
    candidate: Candidate,
    userInput: string,
    context: UserContext | undefined,
    applyRowLevelSecurity: boolean,
    mode: IdentifierCheckMode,
    attempts: number,
    notes: string[]
  ): Promise<QueryResult> {
    const { analysis, issues } = candidate.inspection;
    let query = candidate.query;
    const operation = analysis ? analysis.operation : detectOperationByPrefix(query);

    // Apply row-level security if enabled
    if (applyRowLevelSecurity) {
      query = this.securityValidator.addRowLevelSecurity(query, context!);
      this.log('Applied row-level security');
    }

    // Limit the rows a SELECT returns
    if (operation === 'SELECT') {
      query = this.applyRowLimit(query, analysis);
    }

    // Validate against security rules
    const validation = await this.securityValidator.validate(query, context);

    if (!validation.valid) {
      throw new TextToQueryError(
        `Security validation failed: ${validation.errors.join(', ')}`,
        'SECURITY_VALIDATION_FAILED',
        { errors: validation.errors, warnings: validation.warnings }
      );
    }

    // Extract metadata (RLS and the row limit add no tables, joins or subqueries)
    const metadata: NonNullable<QueryResult['metadata']> = {
      operation: operation!,
      tables: analysis ? extractTables(analysis) : [],
      estimatedComplexity: analysis ? estimateComplexity(analysis) : 'low',
      attempts,
    };
    if (mode !== 'off') {
      metadata.unknownIdentifiers = issues.map(identifierLabel);
    }

    const extra = issues.length > 0 || notes.length > 0 ? [...issues.map((i) => i.message), ...notes] : [];
    const result: QueryResult = {
      query,
      explanation: `Generated ${operation} query for: "${userInput}"`,
      warnings: extra.length > 0 ? [...(validation.warnings || []), ...extra] : validation.warnings,
      metadata,
    };

    this.log('Query generated successfully');
    return result;
  }

  /**
   * The system prompt: rules, dialect rules, schema (renderForModel()),
   * security constraints, examples and instructions. Rendered once per
   * generator and reused, so providers can cache it; a schema changed after
   * the first request is not picked up. getSchema() is unaffected and returns
   * the 0.0.1 text.
   */
  private getSystemPrompt(): string {
    if (this.systemPrompt === undefined) {
      this.systemPrompt = buildSystemPrompt({
        analyzer: this.schemaAnalyzer,
        dialect: this.dialect,
        security: this.config.security,
        examples: this.config.examples,
        instructions: this.config.instructions,
      });
      if (this.config.debug) this.logExampleIssues();
    }
    return this.systemPrompt;
  }

  /** Debug aid: examples that do not match the schema teach the model invented names. */
  private logExampleIssues(): void {
    for (const example of this.config.examples || []) {
      if (!example || typeof example.sql !== 'string') continue;
      const issues = this.checker().check(example.sql);
      if (issues.length > 0) {
        this.log(`Example "${example.question}" does not match the schema: ${issues.map((i) => i.message).join('; ')}`);
      }
    }
  }

  private checker(): IdentifierChecker {
    if (!this.identifierChecker) this.identifierChecker = new IdentifierChecker(this.config.database, this.dialect);
    return this.identifierChecker;
  }

  /** Analyze the query once: identifier issues (unless the check is off) and the analysis for metadata. */
  private inspect(query: string, mode: IdentifierCheckMode): IdentifierInspection {
    if (mode !== 'off') return this.checker().inspect(query);
    try {
      return { analysis: analyzeSql(query, this.dialect), issues: [], referencedTables: [] };
    } catch (error) {
      if (error instanceof SqlLexError) return { issues: [], referencedTables: [] };
      throw error;
    }
  }

  /** Correction feedback with the real columns of the tables the problems concern. */
  private identifierFeedback(query: string, inspection: IdentifierInspection): string {
    const checker = this.checker();
    const names = new Set<string>();
    for (const issue of inspection.issues) {
      if (issue.kind === 'unknown_column' && issue.table === undefined) {
        // A bare column: show every table the query uses.
        for (const t of inspection.referencedTables) names.add(t.name);
      } else if (issue.table !== undefined) {
        names.add(issue.table);
      }
    }
    const tables: TableColumns[] = [];
    for (const table of inspection.referencedTables) {
      if (!names.has(table.name)) continue;
      tables.push({
        table: checker.display(table.name),
        columns: (table.columns || []).map((c) => checker.display(c.name)),
      });
    }
    return buildIdentifierFeedback(query, inspection.issues.map((i) => i.message), tables);
  }

  /**
   * With `security.maxRowLimit`, make sure a SELECT returns at most that many
   * rows (add a limit or lower a larger one). Without it, add nothing, as in
   * 0.0.1, but lower an existing limit above the validator's default (1000)
   * so the query does not fail validation.
   */
  private applyRowLimit(query: string, analysis: SqlAnalysis | undefined): string {
    const maxRowLimit = this.config.security?.maxRowLimit;
    if (maxRowLimit) {
      return this.sanitizer.enforceLimit(query, maxRowLimit);
    }
    const existing = analysis && analysis.statements.length > 0 ? largestRowLimit(analysis.statements[0]) : undefined;
    if (existing !== undefined && existing > DEFAULT_MAX_ROW_LIMIT) {
      return this.sanitizer.enforceLimit(query, DEFAULT_MAX_ROW_LIMIT);
    }
    return query;
  }

  /**
   * Logging utility: `config.logger` or console.log, only with `debug`. API
   * keys are never logged.
   */
  private log(message: string): void {
    if (!this.config.debug) return;
    let text = `[TextToQueryAI] ${message}`;
    const apiKey = this.config.llm?.apiKey;
    if (apiKey && apiKey.length >= 8 && text.includes(apiKey)) {
      text = text.split(apiKey).join('[redacted]');
    }
    if (this.config.logger) this.config.logger(text);
    else console.log(text);
  }

  /**
   * Validate API key
   */
  async validateApiKey(): Promise<boolean> {
    try {
      return await this.llmProvider.validateApiKey();
    } catch (error) {
      return false;
    }
  }

  /**
   * Get schema information (the 0.0.1 schema text; the model sees
   * SchemaAnalyzer.renderForModel() instead)
   */
  getSchema(): string {
    return this.schemaAnalyzer.generateSchemaPrompt();
  }

  /**
   * Get example queries
   */
  getExampleQueries(): string[] {
    return this.schemaAnalyzer.generateExampleQueries();
  }
}

/** maxCorrectionAttempts as a non-negative integer (default 1). */
function correctionLimit(value: number | undefined): number {
  if (value === undefined || value === null || !Number.isFinite(value)) return 1;
  return Math.max(0, Math.floor(value));
}

/** The 0.0.1 operation detection, for queries the lexer cannot read. */
function detectOperationByPrefix(query: string): QueryOperation | null {
  const normalized = query.trim().toUpperCase();
  for (const op of OPERATION_PREFIXES) if (normalized.startsWith(op)) return op;
  return null;
}

/** An issue as it appears in metadata.unknownIdentifiers. */
function identifierLabel(issue: IdentifierIssue): string {
  return issue.kind === 'unknown_column' && issue.table !== undefined ? `${issue.table}.${issue.name}` : issue.name;
}

/**
 * Table names (lowercased, deduplicated) in the order 0.0.1 reported them:
 * tables after FROM, then tables after JOIN, then the rest (comma lists,
 * UPDATE, INSERT INTO, USING, ...).
 */
function extractTables(analysis: SqlAnalysis): string[] {
  const tokens = analysis.tokens;
  const groups: string[][] = [[], [], []];
  let i = 0;
  for (const ref of analysis.tables) {
    // Tables are sorted by position, so the token scan only moves forward.
    while (i < tokens.length && tokens[i].start < ref.start) i++;
    let k = i - 1;
    while (k >= 0 && (tokens[k].type === 'whitespace' || tokens[k].type === 'comment')) k--;
    const before = k >= 0 && tokens[k].type === 'word' ? tokens[k].value : '';
    const group = before === 'FROM' ? 0 : before === 'JOIN' || before === 'STRAIGHT_JOIN' ? 1 : 2;
    groups[group].push(ref.name.toLowerCase());
  }
  return [...new Set(groups[0].concat(groups[1], groups[2]))];
}

/**
 * Complexity from tokens, with the 0.0.1 weights: a join +1 (more than two
 * +2 more), a subquery +2, GROUP BY +1, HAVING +1, a set operation +2.
 * 0 is low, up to 2 medium, more high. Names and strings never count.
 */
function estimateComplexity(analysis: SqlAnalysis): 'low' | 'medium' | 'high' {
  let joins = 0;
  let selects = 0;
  let groupBy = false;
  let having = false;
  let setOperation = false;
  for (const statement of analysis.statements) {
    for (let i = 0; i < statement.length; i++) {
      const tok: Token = statement[i];
      if (tok.type !== 'word') continue;
      const prev = statement[i - 1];
      if (prev && prev.type === 'punct' && prev.value === '.') continue;
      const v = tok.value;
      if (JOIN_WORDS.has(v)) joins++;
      else if (v === 'SELECT') selects++;
      else if (v === 'GROUP' && statement[i + 1]?.type === 'word' && statement[i + 1].value === 'BY') groupBy = true;
      else if (v === 'HAVING') having = true;
      else if (SET_OPERATIONS.has(v)) setOperation = true;
    }
  }

  let complexity = 0;
  if (joins > 0) complexity++;
  if (selects > 1) complexity += 2;
  if (groupBy) complexity++;
  if (having) complexity++;
  if (setOperation) complexity += 2;
  if (joins > 2) complexity += 2;

  if (complexity === 0) return 'low';
  if (complexity <= 2) return 'medium';
  return 'high';
}

/**
 * The largest row limit at the top level of a statement: `LIMIT n`, MySQL
 * `LIMIT o, n`, `TOP n` / `TOP (n)` and `FETCH FIRST|NEXT n ROWS`. Undefined
 * when there is none (or `LIMIT ALL`).
 */
function largestRowLimit(statement: Token[]): number | undefined {
  let depth = 0;
  let largest: number | undefined;
  const consider = (tok: Token | undefined) => {
    if (!tok || tok.type !== 'number') return;
    const n = Number(tok.value);
    if (Number.isFinite(n) && (largest === undefined || n > largest)) largest = n;
  };
  for (let i = 0; i < statement.length; i++) {
    const tok = statement[i];
    if (tok.type === 'punct') {
      if (tok.value === '(') depth++;
      else if (tok.value === ')') depth--;
      continue;
    }
    if (depth !== 0 || tok.type !== 'word') continue;
    const next = statement[i + 1];
    switch (tok.value) {
      case 'LIMIT':
        if (statement[i + 2]?.type === 'punct' && statement[i + 2].value === ',') consider(statement[i + 3]);
        else consider(next);
        break;
      case 'TOP':
        if (next?.type === 'punct' && next.value === '(') consider(statement[i + 2]);
        else consider(next);
        break;
      case 'FETCH':
        if (next?.type === 'word' && (next.value === 'FIRST' || next.value === 'NEXT')) consider(statement[i + 2]);
        break;
    }
  }
  return largest;
}
