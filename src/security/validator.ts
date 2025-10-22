import {
  SecurityConfig,
  UserContext,
  QueryOperation,
} from '../types';

/**
 * Security validator for database queries
 */
export class SecurityValidator {
  private config: SecurityConfig;

  constructor(config: SecurityConfig = {}) {
    this.config = {
      allowedOperations: ['SELECT'],
      allowedTables: [],
      restrictedColumns: [],
      maxRowLimit: 1000,
      requireUserContext: true,
      enableRowLevelSecurity: true,
      ...config,
    };
  }

  /**
   * Validate a query against security rules
   */
  async validate(
    query: string,
    userContext?: UserContext
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check if user context is required
    if (this.config.requireUserContext && !userContext) {
      errors.push('User context is required but not provided');
      return { valid: false, errors, warnings };
    }

    // Detect query operation
    const operation = this.detectOperation(query);
    if (!operation) {
      errors.push('Could not determine query operation');
      return { valid: false, errors, warnings };
    }

    // Check if operation is allowed
    if (
      this.config.allowedOperations &&
      !this.config.allowedOperations.includes(operation)
    ) {
      errors.push(
        `Operation ${operation} is not allowed. Allowed operations: ${this.config.allowedOperations.join(', ')}`
      );
    }

    // Check for dangerous patterns
    const dangerousPatterns = this.detectDangerousPatterns(query);
    if (dangerousPatterns.length > 0) {
      errors.push(
        `Query contains dangerous patterns: ${dangerousPatterns.join(', ')}`
      );
    }

    // Check for restricted columns
    if (this.config.restrictedColumns) {
      const foundRestrictedColumns = this.findRestrictedColumns(query);
      if (foundRestrictedColumns.length > 0) {
        errors.push(
          `Query accesses restricted columns: ${foundRestrictedColumns.join(', ')}`
        );
      }
    }

    // Check for table restrictions
    if (this.config.allowedTables && this.config.allowedTables.length > 0) {
      const tables = this.extractTableNames(query);
      const unauthorizedTables = tables.filter(
        (table) => !this.config.allowedTables!.includes(table)
      );
      if (unauthorizedTables.length > 0) {
        errors.push(
          `Query accesses unauthorized tables: ${unauthorizedTables.join(', ')}`
        );
      }
    }

    // Check for row limit in SELECT queries
    if (operation === 'SELECT') {
      const hasLimit = /LIMIT\s+\d+/i.test(query);
      if (!hasLimit) {
        warnings.push(
          `Query does not have a LIMIT clause. Maximum ${this.config.maxRowLimit} rows will be enforced.`
        );
      } else {
        const limitMatch = query.match(/LIMIT\s+(\d+)/i);
        if (limitMatch) {
          const limit = parseInt(limitMatch[1], 10);
          if (limit > this.config.maxRowLimit!) {
            errors.push(
              `LIMIT ${limit} exceeds maximum allowed limit of ${this.config.maxRowLimit}`
            );
          }
        }
      }
    }

    // Run custom validator if provided
    if (this.config.customValidator) {
      try {
        const customValid = await this.config.customValidator(
          query,
          userContext
        );
        if (!customValid) {
          errors.push('Custom validation failed');
        }
      } catch (error: any) {
        errors.push(`Custom validation error: ${error.message}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Detect the query operation type
   */
  private detectOperation(query: string): QueryOperation | null {
    const normalizedQuery = query.trim().toUpperCase();

    if (normalizedQuery.startsWith('SELECT')) return 'SELECT';
    if (normalizedQuery.startsWith('INSERT')) return 'INSERT';
    if (normalizedQuery.startsWith('UPDATE')) return 'UPDATE';
    if (normalizedQuery.startsWith('DELETE')) return 'DELETE';

    return null;
  }

  /**
   * Detect dangerous SQL patterns
   */
  private detectDangerousPatterns(query: string): string[] {
    const dangerous: string[] = [];
    const normalizedQuery = query.toUpperCase();

    // Check for multiple statements (SQL injection)
    if (query.includes(';') && !query.trim().endsWith(';')) {
      dangerous.push('Multiple statements detected');
    }

    // Check for command execution attempts
    const commandPatterns = [
      'EXEC',
      'EXECUTE',
      'xp_cmdshell',
      'sp_executesql',
      'UNION.*SELECT',
      '--',
      '\\/\\*',  // Properly escaped for regex
      'DROP',
      'TRUNCATE',
      'ALTER',
      'CREATE',
      'GRANT',
      'REVOKE',
    ];

    for (const pattern of commandPatterns) {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(normalizedQuery)) {
        // Push the original pattern name, not the escaped version
        dangerous.push(pattern === '\\/\\*' ? '/*' : pattern);
      }
    }

    return dangerous;
  }

  /**
   * Find restricted columns in the query
   */
  private findRestrictedColumns(query: string): string[] {
    if (!this.config.restrictedColumns) return [];

    const found: string[] = [];
    const normalizedQuery = query.toLowerCase();

    for (const column of this.config.restrictedColumns) {
      const columnLower = column.toLowerCase();
      // Check for column in SELECT, WHERE, or other clauses
      if (normalizedQuery.includes(columnLower)) {
        found.push(column);
      }
    }

    return found;
  }

  /**
   * Extract table names from the query
   */
  private extractTableNames(query: string): string[] {
    const tables: string[] = [];
    const normalizedQuery = query.toLowerCase();

    // Match FROM clause
    const fromMatch = normalizedQuery.match(/from\s+([a-z_][a-z0-9_]*)/gi);
    if (fromMatch) {
      fromMatch.forEach((match) => {
        const tableName = match.replace(/from\s+/i, '').trim();
        tables.push(tableName);
      });
    }

    // Match JOIN clauses
    const joinMatch = normalizedQuery.match(
      /join\s+([a-z_][a-z0-9_]*)/gi
    );
    if (joinMatch) {
      joinMatch.forEach((match) => {
        const tableName = match.replace(/join\s+/i, '').trim();
        tables.push(tableName);
      });
    }

    // Match INTO clause (for INSERT)
    const intoMatch = normalizedQuery.match(/into\s+([a-z_][a-z0-9_]*)/i);
    if (intoMatch) {
      tables.push(intoMatch[1].trim());
    }

    // Match UPDATE clause
    const updateMatch = normalizedQuery.match(/update\s+([a-z_][a-z0-9_]*)/i);
    if (updateMatch) {
      tables.push(updateMatch[1].trim());
    }

    return [...new Set(tables)]; // Remove duplicates
  }

  /**
   * Add row-level security filter to query
   */
  addRowLevelSecurity(query: string, userContext: UserContext): string {
    if (!this.config.enableRowLevelSecurity || !userContext) {
      return query;
    }

    const operation = this.detectOperation(query);

    // Only apply to SELECT, UPDATE, DELETE
    if (
      operation !== 'SELECT' &&
      operation !== 'UPDATE' &&
      operation !== 'DELETE'
    ) {
      return query;
    }

    // Add user_id filter if the query doesn't already have WHERE clause with user_id
    if (!/WHERE.*user_id/i.test(query)) {
      const hasWhere = /WHERE/i.test(query);
      const connector = hasWhere ? ' AND' : ' WHERE';
      const userIdFilter = `${connector} user_id = ${typeof userContext.userId === 'string' ? `'${userContext.userId}'` : userContext.userId}`;

      // Insert before ORDER BY, LIMIT, or at the end
      if (/ORDER BY/i.test(query)) {
        return query.replace(/ORDER BY/i, `${userIdFilter} ORDER BY`);
      } else if (/LIMIT/i.test(query)) {
        return query.replace(/LIMIT/i, `${userIdFilter} LIMIT`);
      } else {
        return query + userIdFilter;
      }
    }

    return query;
  }
}
