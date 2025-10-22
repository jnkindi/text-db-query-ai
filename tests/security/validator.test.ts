/**
 * Tests for SecurityValidator
 */

import { SecurityValidator } from '../../src/security/validator';
import { SecurityConfig, UserContext } from '../../src/types';

describe('SecurityValidator', () => {
  describe('SQL Injection Prevention', () => {
    let validator: SecurityValidator;

    beforeEach(() => {
      validator = new SecurityValidator({
        allowedOperations: ['SELECT'],
        requireUserContext: false,
      });
    });

    it('should detect multiple statements', async () => {
      const query = 'SELECT * FROM users; DROP TABLE users';
      const result = await validator.validate(query);

      expect(result.valid).toBe(false);
      expect(result.errors.some(err => err.includes('Multiple statements'))).toBe(true);
    });

    it('should detect UNION attacks', async () => {
      const query = 'SELECT * FROM users UNION SELECT * FROM passwords';
      const result = await validator.validate(query);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should detect DROP statements', async () => {
      const query = 'DROP TABLE users';
      const result = await validator.validate(query);

      expect(result.valid).toBe(false);
      // DROP is caught early as unrecognized operation
      expect(result.errors.some(err => err.includes('Could not determine query operation'))).toBe(true);
    });

    it('should detect EXEC/EXECUTE commands', async () => {
      const query = 'EXEC sp_executesql @sql';
      const result = await validator.validate(query);

      expect(result.valid).toBe(false);
    });

    it('should detect xp_cmdshell attempts', async () => {
      const query = 'EXEC xp_cmdshell \'dir\'';
      const result = await validator.validate(query);

      expect(result.valid).toBe(false);
    });

    it('should allow safe SELECT queries', async () => {
      const query = 'SELECT * FROM users WHERE id = 1';
      const result = await validator.validate(query);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Operation Restrictions', () => {
    it('should allow only specified operations', async () => {
      const validator = new SecurityValidator({
        allowedOperations: ['SELECT'],
        requireUserContext: false,
      });

      const selectQuery = 'SELECT * FROM users';
      const insertQuery = 'INSERT INTO users VALUES (1)';

      const selectResult = await validator.validate(selectQuery);
      const insertResult = await validator.validate(insertQuery);

      expect(selectResult.valid).toBe(true);
      expect(insertResult.valid).toBe(false);
      expect(insertResult.errors.some(err => err.includes('not allowed'))).toBe(true);
    });

    it('should allow multiple operations', async () => {
      const validator = new SecurityValidator({
        allowedOperations: ['SELECT', 'INSERT'],
        requireUserContext: false,
      });

      const selectQuery = 'SELECT * FROM users';
      const insertQuery = 'INSERT INTO users VALUES (1)';

      const selectResult = await validator.validate(selectQuery);
      const insertResult = await validator.validate(insertQuery);

      expect(selectResult.valid).toBe(true);
      expect(insertResult.valid).toBe(true);
    });
  });

  describe('Table Access Control', () => {
    it('should restrict access to specified tables', async () => {
      const validator = new SecurityValidator({
        allowedOperations: ['SELECT'],
        allowedTables: ['users', 'orders'],
        requireUserContext: false,
      });

      const allowedQuery = 'SELECT * FROM users';
      const deniedQuery = 'SELECT * FROM admin_secrets';

      const allowedResult = await validator.validate(allowedQuery);
      const deniedResult = await validator.validate(deniedQuery);

      expect(allowedResult.valid).toBe(true);
      expect(deniedResult.valid).toBe(false);
      expect(deniedResult.errors.some(err => err.includes('unauthorized tables'))).toBe(true);
    });
  });

  describe('Column Restrictions', () => {
    it('should block access to restricted columns', async () => {
      const validator = new SecurityValidator({
        allowedOperations: ['SELECT'],
        restrictedColumns: ['password', 'ssn'],
        requireUserContext: false,
      });

      const safeQuery = 'SELECT id, name FROM users';
      const unsafeQuery = 'SELECT password FROM users';

      const safeResult = await validator.validate(safeQuery);
      const unsafeResult = await validator.validate(unsafeQuery);

      expect(safeResult.valid).toBe(true);
      expect(unsafeResult.valid).toBe(false);
      expect(unsafeResult.errors.some(err => err.includes('restricted columns'))).toBe(true);
    });
  });

  describe('Row Limits', () => {
    it('should enforce row limits', async () => {
      const validator = new SecurityValidator({
        allowedOperations: ['SELECT'],
        maxRowLimit: 100,
        requireUserContext: false,
      });

      const validQuery = 'SELECT * FROM users LIMIT 50';
      const invalidQuery = 'SELECT * FROM users LIMIT 500';

      const validResult = await validator.validate(validQuery);
      const invalidResult = await validator.validate(invalidQuery);

      expect(validResult.valid).toBe(true);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.some(err => err.includes('exceeds maximum'))).toBe(true);
    });

    it('should warn about missing LIMIT clause', async () => {
      const validator = new SecurityValidator({
        allowedOperations: ['SELECT'],
        maxRowLimit: 100,
        requireUserContext: false,
      });

      const query = 'SELECT * FROM users';
      const result = await validator.validate(query);

      expect(result.warnings.some(warn => warn.includes('does not have a LIMIT'))).toBe(true);
    });
  });

  describe('User Context Requirements', () => {
    it('should require user context when configured', async () => {
      const validator = new SecurityValidator({
        requireUserContext: true,
        allowedOperations: ['SELECT'],
      });

      const query = 'SELECT * FROM users';

      const withoutContext = await validator.validate(query);
      expect(withoutContext.valid).toBe(false);
      expect(withoutContext.errors.some(err => err.includes('User context is required'))).toBe(true);

      const withContext = await validator.validate(query, {
        userId: 123,
        role: 'user',
      });
      expect(withContext.valid).toBe(true);
    });
  });

  describe('Row-Level Security', () => {
    it('should add user_id filter to queries', () => {
      const validator = new SecurityValidator({
        enableRowLevelSecurity: true,
      });

      const userContext: UserContext = {
        userId: 123,
        role: 'user',
      };

      const query = 'SELECT * FROM orders';
      const result = validator.addRowLevelSecurity(query, userContext);

      expect(result).toContain('user_id = 123');
    });

    it('should not duplicate user_id filter', () => {
      const validator = new SecurityValidator({
        enableRowLevelSecurity: true,
      });

      const userContext: UserContext = {
        userId: 123,
        role: 'user',
      };

      const query = 'SELECT * FROM orders WHERE user_id = 123';
      const result = validator.addRowLevelSecurity(query, userContext);

      expect(result).toBe(query);
    });

    it('should handle string user IDs', () => {
      const validator = new SecurityValidator({
        enableRowLevelSecurity: true,
      });

      const userContext: UserContext = {
        userId: 'abc-123',
        role: 'user',
      };

      const query = 'SELECT * FROM orders';
      const result = validator.addRowLevelSecurity(query, userContext);

      expect(result).toContain("user_id = 'abc-123'");
    });
  });

  describe('Custom Validation', () => {
    it('should run custom validator', async () => {
      const customValidator = jest.fn().mockResolvedValue(true);

      const validator = new SecurityValidator({
        allowedOperations: ['SELECT'],
        customValidator,
      });

      const query = 'SELECT * FROM users';
      const userContext: UserContext = {
        userId: 123,
        role: 'user',
      };

      await validator.validate(query, userContext);

      expect(customValidator).toHaveBeenCalledWith(query, userContext);
    });

    it('should fail validation when custom validator returns false', async () => {
      const validator = new SecurityValidator({
        allowedOperations: ['SELECT'],
        requireUserContext: false,
        customValidator: async () => false,
      });

      const query = 'SELECT * FROM users';
      const result = await validator.validate(query);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Custom validation failed');
    });
  });
});
