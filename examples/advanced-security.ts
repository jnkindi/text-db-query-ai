/**
 * Advanced Security Example
 *
 * Demonstrates advanced security features including custom validation,
 * role-based access control, and sensitive data protection
 */

import { createQueryGenerator } from '../src';

async function main() {
  // Advanced security configuration
  const generator = createQueryGenerator({
    llm: {
      provider: 'claude',
      apiKey: process.env.ANTHROPIC_API_KEY || 'your-api-key',
    },

    database: {
      databaseType: 'postgres',
      tables: [
        {
          name: 'users',
          columns: [
            { name: 'id', type: 'integer' },
            { name: 'email', type: 'varchar' },
            { name: 'name', type: 'varchar' },
            {
              name: 'password_hash',
              type: 'varchar',
              sensitive: true, // Marked as sensitive
              description: 'Password hash - should never be exposed',
            },
            {
              name: 'ssn',
              type: 'varchar',
              sensitive: true, // Sensitive personal data
              description: 'Social Security Number',
            },
            { name: 'salary', type: 'decimal', description: 'Annual salary' },
            { name: 'role', type: 'varchar' },
            { name: 'department', type: 'varchar' },
          ],
        },
        {
          name: 'audit_logs',
          columns: [
            { name: 'id', type: 'integer' },
            { name: 'user_id', type: 'integer' },
            { name: 'action', type: 'varchar' },
            { name: 'timestamp', type: 'timestamp' },
          ],
        },
      ],
    },

    security: {
      // Only allow SELECT queries
      allowedOperations: ['SELECT'],

      // Only allow specific tables
      allowedTables: ['users', 'orders', 'products'],

      // Block sensitive columns
      restrictedColumns: ['password_hash', 'ssn', 'credit_card'],

      // Maximum rows to return
      maxRowLimit: 50,

      // Require user context
      requireUserContext: true,

      // Enable automatic row-level security
      enableRowLevelSecurity: true,

      // Custom validation function
      customValidator: async (query, userContext) => {
        // Admin users can access everything
        if (userContext?.role === 'admin') {
          return true;
        }

        // Manager role checks
        if (userContext?.role === 'manager') {
          // Managers can't access audit logs
          if (query.toLowerCase().includes('audit_logs')) {
            return false;
          }
          // Managers can't access salary information
          if (query.toLowerCase().includes('salary')) {
            return false;
          }
          return true;
        }

        // Regular users have the most restrictions
        if (userContext?.role === 'user') {
          // Users can only access their own data (handled by row-level security)
          // Users can't access salary information
          if (query.toLowerCase().includes('salary')) {
            return false;
          }
          return true;
        }

        // Unknown role - deny by default
        return false;
      },
    },

    debug: true,
  });

  console.log('Advanced Security Example\n');
  console.log('='.repeat(60));

  // Test Case 1: Regular user trying to access their data
  console.log('\n1. Regular user accessing their own data:');
  try {
    const result = await generator.generateQuery('Show me my profile', {
      userId: 123,
      role: 'user',
      permissions: ['read:own'],
    });
    console.log('✓ Query allowed:');
    console.log(result.query);
  } catch (error: any) {
    console.log('✗ Query blocked:', error.message);
  }

  // Test Case 2: Regular user trying to access salary (should fail)
  console.log('\n2. Regular user trying to access salary:');
  try {
    const result = await generator.generateQuery('Show me all user salaries', {
      userId: 123,
      role: 'user',
    });
    console.log('✓ Query allowed:');
    console.log(result.query);
  } catch (error: any) {
    console.log('✗ Query blocked:', error.message);
  }

  // Test Case 3: Regular user trying to access sensitive data
  console.log('\n3. Regular user trying to access sensitive data:');
  try {
    const result = await generator.generateQuery(
      'Show me user passwords and SSN',
      {
        userId: 123,
        role: 'user',
      }
    );
    console.log('✓ Query allowed:');
    console.log(result.query);
  } catch (error: any) {
    console.log('✗ Query blocked:', error.message);
  }

  // Test Case 4: Manager accessing non-salary data
  console.log('\n4. Manager accessing user profiles:');
  try {
    const result = await generator.generateQuery('Show all users in IT department', {
      userId: 456,
      role: 'manager',
      permissions: ['read:department'],
    });
    console.log('✓ Query allowed:');
    console.log(result.query);
  } catch (error: any) {
    console.log('✗ Query blocked:', error.message);
  }

  // Test Case 5: Manager trying to access audit logs (should fail)
  console.log('\n5. Manager trying to access audit logs:');
  try {
    const result = await generator.generateQuery('Show me recent audit logs', {
      userId: 456,
      role: 'manager',
    });
    console.log('✓ Query allowed:');
    console.log(result.query);
  } catch (error: any) {
    console.log('✗ Query blocked:', error.message);
  }

  // Test Case 6: Admin user accessing everything
  console.log('\n6. Admin accessing sensitive data:');
  try {
    const result = await generator.generateQuery('Show all users with their salaries', {
      userId: 1,
      role: 'admin',
      permissions: ['read:all', 'write:all'],
    });
    console.log('✓ Query allowed:');
    console.log(result.query);
  } catch (error: any) {
    console.log('✗ Query blocked:', error.message);
  }

  // Test Case 7: Attempt SQL injection
  console.log('\n7. Attempting SQL injection:');
  try {
    const result = await generator.generateQuery(
      "Show users; DROP TABLE users; --",
      {
        userId: 999,
        role: 'user',
      }
    );
    console.log('✓ Query allowed:');
    console.log(result.query);
  } catch (error: any) {
    console.log('✗ Query blocked:', error.message);
  }

  // Test Case 8: Row-level security in action
  console.log('\n8. Row-level security filtering:');
  try {
    const result = await generator.generateQuery('Show me all orders', {
      userId: 123,
      role: 'user',
    });
    console.log('✓ Query generated with automatic user filtering:');
    console.log(result.query);
    console.log('Note: Automatically added WHERE user_id = 123');
  } catch (error: any) {
    console.log('✗ Query blocked:', error.message);
  }

  console.log('\n' + '='.repeat(60));
  console.log('\nSecurity Summary:');
  console.log('- Sensitive columns are automatically protected');
  console.log('- Role-based access control is enforced');
  console.log('- Row-level security filters results by user_id');
  console.log('- SQL injection attempts are blocked');
  console.log('- Custom validation adds business-specific rules');
}

main().catch(console.error);
