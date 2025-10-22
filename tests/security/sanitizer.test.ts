/**
 * Tests for QuerySanitizer
 */

import { QuerySanitizer } from '../../src/security/sanitizer';

describe('QuerySanitizer', () => {
  let sanitizer: QuerySanitizer;

  beforeEach(() => {
    sanitizer = new QuerySanitizer();
  });

  describe('sanitize', () => {
    it('should remove SQL comments', () => {
      const query = 'SELECT * FROM users -- comment here';
      const result = sanitizer.sanitize(query);
      expect(result).not.toContain('--');
      expect(result).toBe('SELECT * FROM users');
    });

    it('should remove multi-line comments', () => {
      const query = 'SELECT * /* comment */ FROM users';
      const result = sanitizer.sanitize(query);
      expect(result).not.toContain('/*');
      expect(result).toBe('SELECT * FROM users');
    });

    it('should remove trailing semicolons', () => {
      const query = 'SELECT * FROM users;;';
      const result = sanitizer.sanitize(query);
      expect(result).toBe('SELECT * FROM users');
    });

    it('should normalize whitespace', () => {
      const query = 'SELECT   *\n  FROM\n  users';
      const result = sanitizer.sanitize(query);
      expect(result).toBe('SELECT * FROM users');
    });

    it('should remove null bytes', () => {
      const query = 'SELECT * FROM users\0';
      const result = sanitizer.sanitize(query);
      expect(result).not.toContain('\0');
    });
  });

  describe('extractFromMarkdown', () => {
    it('should extract SQL from code blocks', () => {
      const text = '```sql\nSELECT * FROM users\n```';
      const result = sanitizer.extractFromMarkdown(text);
      expect(result).toBe('SELECT * FROM users');
    });

    it('should extract from generic code blocks', () => {
      const text = '```\nSELECT * FROM users\n```';
      const result = sanitizer.extractFromMarkdown(text);
      expect(result).toBe('SELECT * FROM users');
    });

    it('should return text as-is if no code blocks', () => {
      const text = 'SELECT * FROM users';
      const result = sanitizer.extractFromMarkdown(text);
      expect(result).toBe(text);
    });
  });

  describe('validateSQLSyntax', () => {
    it('should validate SELECT queries', () => {
      const query = 'SELECT * FROM users';
      const result = sanitizer.validateSQLSyntax(query);
      expect(result.valid).toBe(true);
    });

    it('should validate INSERT queries', () => {
      const query = 'INSERT INTO users (name) VALUES (\'John\')';
      const result = sanitizer.validateSQLSyntax(query);
      expect(result.valid).toBe(true);
    });

    it('should reject queries with invalid start', () => {
      const query = 'INVALID QUERY';
      const result = sanitizer.validateSQLSyntax(query);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must start with');
    });

    it('should detect unbalanced parentheses', () => {
      const query = 'SELECT * FROM users WHERE (id = 1';
      const result = sanitizer.validateSQLSyntax(query);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('parentheses');
    });

    it('should detect unbalanced quotes', () => {
      const query = 'SELECT * FROM users WHERE name = \'John';
      const result = sanitizer.validateSQLSyntax(query);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('quotes');
    });
  });

  describe('addLimitIfMissing', () => {
    it('should add LIMIT clause if missing', () => {
      const query = 'SELECT * FROM users';
      const result = sanitizer.addLimitIfMissing(query, 100);
      expect(result).toBe('SELECT * FROM users LIMIT 100');
    });

    it('should not add LIMIT if already present', () => {
      const query = 'SELECT * FROM users LIMIT 50';
      const result = sanitizer.addLimitIfMissing(query, 100);
      expect(result).toBe('SELECT * FROM users LIMIT 50');
    });
  });

  describe('escapeValue', () => {
    it('should escape single quotes', () => {
      const value = "O'Brien";
      const result = sanitizer.escapeValue(value);
      expect(result).toBe("O''Brien");
    });
  });
});
