/**
 * Tests for SchemaAnalyzer
 */

import { SchemaAnalyzer } from '../../src/schema/analyzer';
import { DatabaseSchema } from '../../src/types';

describe('SchemaAnalyzer', () => {
  const mockSchema: DatabaseSchema = {
    databaseType: 'postgres',
    tables: [
      {
        name: 'users',
        description: 'User accounts',
        columns: [
          { name: 'id', type: 'integer', description: 'User ID' },
          { name: 'email', type: 'varchar', nullable: false },
          { name: 'name', type: 'varchar', nullable: true },
          { name: 'password', type: 'varchar', sensitive: true },
        ],
        primaryKey: 'id',
      },
      {
        name: 'orders',
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'user_id', type: 'integer' },
          { name: 'total', type: 'decimal' },
        ],
        primaryKey: 'id',
        foreignKeys: [
          {
            column: 'user_id',
            referencedTable: 'users',
            referencedColumn: 'id',
          },
        ],
      },
    ],
  };

  let analyzer: SchemaAnalyzer;

  beforeEach(() => {
    analyzer = new SchemaAnalyzer(mockSchema);
  });

  describe('generateSchemaPrompt', () => {
    it('should generate schema description', () => {
      const prompt = analyzer.generateSchemaPrompt();

      expect(prompt).toContain('Database Type: POSTGRES');
      expect(prompt).toContain('Table: users');
      expect(prompt).toContain('Table: orders');
      expect(prompt).toContain('email: varchar (required)');
      expect(prompt).toContain('name: varchar (nullable)');
    });

    it('should mark sensitive columns', () => {
      const prompt = analyzer.generateSchemaPrompt();

      expect(prompt).toContain('[SENSITIVE - DO NOT EXPOSE]');
      expect(prompt).toContain('password');
    });

    it('should include descriptions', () => {
      const prompt = analyzer.generateSchemaPrompt();

      expect(prompt).toContain('User accounts');
      expect(prompt).toContain('User ID');
    });

    it('should include primary keys', () => {
      const prompt = analyzer.generateSchemaPrompt();

      expect(prompt).toContain('Primary Key: id');
    });

    it('should include foreign keys', () => {
      const prompt = analyzer.generateSchemaPrompt();

      expect(prompt).toContain('Foreign Keys:');
      expect(prompt).toContain('user_id -> users.id');
    });
  });

  describe('findTable', () => {
    it('should find table by name', () => {
      const table = analyzer.findTable('users');

      expect(table).toBeDefined();
      expect(table?.name).toBe('users');
    });

    it('should be case-insensitive', () => {
      const table = analyzer.findTable('USERS');

      expect(table).toBeDefined();
      expect(table?.name).toBe('users');
    });

    it('should return undefined for non-existent table', () => {
      const table = analyzer.findTable('nonexistent');

      expect(table).toBeUndefined();
    });
  });

  describe('getTableNames', () => {
    it('should return all table names', () => {
      const names = analyzer.getTableNames();

      expect(names).toEqual(['users', 'orders']);
    });
  });

  describe('getSensitiveColumns', () => {
    it('should return all sensitive columns', () => {
      const sensitive = analyzer.getSensitiveColumns();

      expect(sensitive).toHaveLength(1);
      expect(sensitive[0]).toEqual({
        table: 'users',
        column: 'password',
      });
    });
  });

  describe('validateTables', () => {
    it('should validate existing tables', () => {
      const result = analyzer.validateTables(['users', 'orders']);

      expect(result.valid).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('should detect missing tables', () => {
      const result = analyzer.validateTables(['users', 'nonexistent']);

      expect(result.valid).toBe(false);
      expect(result.missing).toEqual(['nonexistent']);
    });

    it('should be case-insensitive', () => {
      const result = analyzer.validateTables(['USERS', 'ORDERS']);

      expect(result.valid).toBe(true);
    });
  });

  describe('getDatabaseType', () => {
    it('should return database type', () => {
      const dbType = analyzer.getDatabaseType();

      expect(dbType).toBe('postgres');
    });
  });

  describe('getDatabaseHints', () => {
    it('should provide PostgreSQL hints', () => {
      const hints = analyzer.getDatabaseHints();

      expect(hints).toContain('PostgreSQL');
      expect(hints).toContain('RETURNING');
    });

    it('should provide MySQL hints', () => {
      const mysqlSchema: DatabaseSchema = {
        databaseType: 'mysql',
        tables: [],
      };
      const mysqlAnalyzer = new SchemaAnalyzer(mysqlSchema);
      const hints = mysqlAnalyzer.getDatabaseHints();

      expect(hints).toContain('MySQL');
      expect(hints).toContain('Backticks');
    });
  });

  describe('generateExampleQueries', () => {
    it('should generate example queries', () => {
      const examples = analyzer.generateExampleQueries();

      expect(examples.length).toBeGreaterThan(0);
      expect(examples[0]).toContain('SELECT');
      expect(examples[0]).toContain('FROM users');
    });

    it('should not include sensitive columns', () => {
      const examples = analyzer.generateExampleQueries();

      examples.forEach((query) => {
        expect(query).not.toContain('password');
      });
    });

    it('should generate JOIN examples for related tables', () => {
      const examples = analyzer.generateExampleQueries();

      const joinExample = examples.find((q) => q.includes('JOIN'));
      expect(joinExample).toBeDefined();
      expect(joinExample).toContain('users');
    });
  });
});
