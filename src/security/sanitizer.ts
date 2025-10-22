/**
 * Query sanitizer to clean and normalize SQL queries
 */
export class QuerySanitizer {
  /**
   * Sanitize a SQL query
   */
  sanitize(query: string): string {
    let sanitized = query.trim();

    // Remove comments
    sanitized = this.removeComments(sanitized);

    // Remove trailing semicolons (we'll add one back if needed)
    sanitized = sanitized.replace(/;+$/, '');

    // Normalize whitespace
    sanitized = this.normalizeWhitespace(sanitized);

    // Remove null bytes
    sanitized = sanitized.replace(/\0/g, '');

    return sanitized;
  }

  /**
   * Remove SQL comments
   */
  private removeComments(query: string): string {
    // Remove single-line comments (-- style)
    let sanitized = query.replace(/--[^\n]*/g, '');

    // Remove multi-line comments (/* */ style)
    sanitized = sanitized.replace(/\/\*[\s\S]*?\*\//g, '');

    return sanitized;
  }

  /**
   * Normalize whitespace in query
   */
  private normalizeWhitespace(query: string): string {
    return query
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ');
  }

  /**
   * Extract query from markdown code blocks if present
   */
  extractFromMarkdown(text: string): string {
    // Check for SQL code blocks
    const sqlBlockMatch = text.match(/```sql\n([\s\S]*?)```/);
    if (sqlBlockMatch) {
      return sqlBlockMatch[1].trim();
    }

    // Check for generic code blocks
    const codeBlockMatch = text.match(/```\n([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // Return as-is if no code blocks found
    return text;
  }

  /**
   * Validate that the query is a valid SQL statement
   */
  validateSQLSyntax(query: string): { valid: boolean; error?: string } {
    // Basic syntax validation
    const trimmed = query.trim().toUpperCase();

    // Check if query starts with a valid SQL keyword
    const validStarts = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH'];
    const isValidStart = validStarts.some((keyword) =>
      trimmed.startsWith(keyword)
    );

    if (!isValidStart) {
      return {
        valid: false,
        error: `Query must start with one of: ${validStarts.join(', ')}`,
      };
    }

    // Check for balanced parentheses
    let parenCount = 0;
    for (const char of query) {
      if (char === '(') parenCount++;
      if (char === ')') parenCount--;
      if (parenCount < 0) {
        return { valid: false, error: 'Unbalanced parentheses' };
      }
    }

    if (parenCount !== 0) {
      return { valid: false, error: 'Unbalanced parentheses' };
    }

    // Check for balanced quotes
    const singleQuotes = (query.match(/'/g) || []).length;
    const doubleQuotes = (query.match(/"/g) || []).length;

    if (singleQuotes % 2 !== 0) {
      return { valid: false, error: 'Unbalanced single quotes' };
    }

    if (doubleQuotes % 2 !== 0) {
      return { valid: false, error: 'Unbalanced double quotes' };
    }

    return { valid: true };
  }

  /**
   * Escape special characters in values
   */
  escapeValue(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Add LIMIT clause if not present
   */
  addLimitIfMissing(query: string, limit: number): string {
    if (!/LIMIT\s+\d+/i.test(query)) {
      return `${query} LIMIT ${limit}`;
    }
    return query;
  }
}
