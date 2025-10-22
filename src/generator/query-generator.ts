import {
  TextToQueryConfig,
  QueryResult,
  UserContext,
  TextToQueryError,
} from '../types';
import { createLLMProvider, BaseLLMProvider } from '../providers';
import { SecurityValidator, QuerySanitizer } from '../security';
import { SchemaAnalyzer } from '../schema';

/**
 * Main query generator class
 */
export class QueryGenerator {
  private config: TextToQueryConfig;
  private llmProvider: BaseLLMProvider;
  private securityValidator: SecurityValidator;
  private sanitizer: QuerySanitizer;
  private schemaAnalyzer: SchemaAnalyzer;

  constructor(config: TextToQueryConfig) {
    this.config = config;
    this.llmProvider = createLLMProvider(config.llm);
    this.securityValidator = new SecurityValidator(config.security);
    this.sanitizer = new QuerySanitizer();
    this.schemaAnalyzer = new SchemaAnalyzer(config.database);

    this.log('QueryGenerator initialized');
  }

  /**
   * Generate a database query from natural language text
   */
  async generateQuery(
    userInput: string,
    userContext?: UserContext
  ): Promise<QueryResult> {
    try {
      this.log(`Generating query for input: "${userInput}"`);

      // Use provided user context or fall back to config
      const context = userContext || this.config.userContext;

      // Build the prompt for the LLM
      const prompt = this.buildPrompt(userInput, context);
      this.log('Built prompt for LLM');

      // Generate query using LLM
      let rawResponse = await this.llmProvider.generate(prompt);
      this.log(`Received LLM response: ${rawResponse.substring(0, 100)}...`);

      // Extract and sanitize the query
      rawResponse = this.sanitizer.extractFromMarkdown(rawResponse);
      let query = this.sanitizer.sanitize(rawResponse);

      // Validate SQL syntax
      const syntaxValidation = this.sanitizer.validateSQLSyntax(query);
      if (!syntaxValidation.valid) {
        throw new TextToQueryError(
          `Invalid SQL syntax: ${syntaxValidation.error}`,
          'INVALID_SQL_SYNTAX'
        );
      }

      // Apply row-level security if enabled
      if (this.config.security?.enableRowLevelSecurity && context) {
        query = this.securityValidator.addRowLevelSecurity(query, context);
        this.log('Applied row-level security');
      }

      // Add LIMIT clause for SELECT queries if not present
      const operation = this.detectOperation(query);
      if (operation === 'SELECT' && this.config.security?.maxRowLimit) {
        query = this.sanitizer.addLimitIfMissing(
          query,
          this.config.security.maxRowLimit
        );
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

      // Extract metadata
      const tables = this.extractTables(query);
      const complexity = this.estimateComplexity(query);

      const result: QueryResult = {
        query,
        explanation: `Generated ${operation} query for: "${userInput}"`,
        warnings: validation.warnings,
        metadata: {
          operation: operation!,
          tables,
          estimatedComplexity: complexity,
        },
      };

      this.log('Query generated successfully');
      return result;
    } catch (error: any) {
      this.log(`Error generating query: ${error.message}`);
      if (error instanceof TextToQueryError) {
        throw error;
      }
      throw new TextToQueryError(
        `Failed to generate query: ${error.message}`,
        'QUERY_GENERATION_FAILED',
        error
      );
    }
  }

  /**
   * Generate query with detailed explanation
   */
  async generateQueryWithExplanation(
    userInput: string,
    userContext?: UserContext
  ): Promise<QueryResult> {
    const result = await this.generateQuery(userInput, userContext);

    // Generate detailed explanation
    const explanationPrompt = `Explain the following SQL query in simple terms:\n\n${result.query}\n\nProvide a brief explanation of what this query does and what data it will return.`;

    const explanation = await this.llmProvider.generate(explanationPrompt);

    return {
      ...result,
      explanation: this.sanitizer.extractFromMarkdown(explanation),
    };
  }

  /**
   * Build the prompt for the LLM
   */
  private buildPrompt(userInput: string, userContext?: UserContext): string {
    let prompt = 'You are a database query generator. Generate a SQL query based on the following information:\n\n';

    // Add database schema
    prompt += '=== DATABASE SCHEMA ===\n';
    prompt += this.schemaAnalyzer.generateSchemaPrompt();
    prompt += '\n';

    // Add database-specific hints
    prompt += '=== DATABASE NOTES ===\n';
    prompt += this.schemaAnalyzer.getDatabaseHints();
    prompt += '\n\n';

    // Add security constraints
    if (this.config.security) {
      prompt += '=== SECURITY CONSTRAINTS ===\n';

      if (this.config.security.allowedOperations) {
        prompt += `Allowed operations: ${this.config.security.allowedOperations.join(', ')}\n`;
      }

      if (this.config.security.allowedTables && this.config.security.allowedTables.length > 0) {
        prompt += `Allowed tables: ${this.config.security.allowedTables.join(', ')}\n`;
      }

      if (this.config.security.restrictedColumns && this.config.security.restrictedColumns.length > 0) {
        prompt += `Restricted columns (DO NOT USE): ${this.config.security.restrictedColumns.join(', ')}\n`;
      }

      const sensitiveColumns = this.schemaAnalyzer.getSensitiveColumns();
      if (sensitiveColumns.length > 0) {
        prompt += 'Sensitive columns (DO NOT EXPOSE):\n';
        sensitiveColumns.forEach((sc) => {
          prompt += `  - ${sc.table}.${sc.column}\n`;
        });
      }

      prompt += '\n';
    }

    // Add user context
    if (userContext) {
      prompt += '=== USER CONTEXT ===\n';
      prompt += `User ID: ${userContext.userId}\n`;
      prompt += `Role: ${userContext.role}\n`;

      if (userContext.permissions && userContext.permissions.length > 0) {
        prompt += `Permissions: ${userContext.permissions.join(', ')}\n`;
      }

      prompt += '\n';
    }

    // Add user request
    prompt += '=== USER REQUEST ===\n';
    prompt += userInput;
    prompt += '\n\n';

    // Add instructions
    prompt += '=== INSTRUCTIONS ===\n';
    prompt += 'Generate ONLY the SQL query without any explanations, markdown formatting, or additional text.\n';
    prompt += 'The query must:\n';
    prompt += '1. Be valid SQL for the specified database type\n';
    prompt += '2. Follow all security constraints\n';
    prompt += '3. Only use tables and columns from the provided schema\n';
    prompt += '4. Not expose sensitive columns\n';
    prompt += '5. Be safe to execute\n';

    if (userContext && this.config.security?.enableRowLevelSecurity) {
      prompt += `6. Consider that results will be filtered for user_id = ${userContext.userId}\n`;
    }

    return prompt;
  }

  /**
   * Detect query operation type
   */
  private detectOperation(query: string): 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | null {
    const normalized = query.trim().toUpperCase();
    if (normalized.startsWith('SELECT')) return 'SELECT';
    if (normalized.startsWith('INSERT')) return 'INSERT';
    if (normalized.startsWith('UPDATE')) return 'UPDATE';
    if (normalized.startsWith('DELETE')) return 'DELETE';
    return null;
  }

  /**
   * Extract table names from query
   */
  private extractTables(query: string): string[] {
    const tables: string[] = [];
    const normalized = query.toLowerCase();

    // Match FROM clause
    const fromMatch = normalized.match(/from\s+([a-z_][a-z0-9_]*)/gi);
    if (fromMatch) {
      fromMatch.forEach((match) => {
        const tableName = match.replace(/from\s+/i, '').trim();
        tables.push(tableName);
      });
    }

    // Match JOIN clauses
    const joinMatch = normalized.match(/join\s+([a-z_][a-z0-9_]*)/gi);
    if (joinMatch) {
      joinMatch.forEach((match) => {
        const tableName = match.replace(/join\s+/i, '').trim();
        tables.push(tableName);
      });
    }

    return [...new Set(tables)];
  }

  /**
   * Estimate query complexity
   */
  private estimateComplexity(query: string): 'low' | 'medium' | 'high' {
    const normalized = query.toLowerCase();

    // Count complexity indicators
    let complexity = 0;

    if (normalized.includes('join')) complexity++;
    if (normalized.includes('subquery') || /select[\s\S]*select/i.test(query)) complexity += 2;
    if (normalized.includes('group by')) complexity++;
    if (normalized.includes('having')) complexity++;
    if (normalized.includes('union')) complexity += 2;
    if ((normalized.match(/join/g) || []).length > 2) complexity += 2;

    if (complexity === 0) return 'low';
    if (complexity <= 2) return 'medium';
    return 'high';
  }

  /**
   * Logging utility
   */
  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[TextToQueryAI] ${message}`);
    }
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
   * Get schema information
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
