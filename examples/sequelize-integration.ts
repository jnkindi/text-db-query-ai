/**
 * Sequelize Integration Example
 *
 * This example shows how to use text-db-query-ai with Sequelize ORM
 */

import { Sequelize, DataTypes, Model } from 'sequelize';
import { createChatbotFromSequelize } from '../src';

// Initialize Sequelize
const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: ':memory:',
  logging: false,
});

// Define User model
class User extends Model {}
User.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Password hash',
    },
    role: {
      type: DataTypes.STRING,
      defaultValue: 'user',
    },
  },
  {
    sequelize,
    modelName: 'User',
    tableName: 'users',
  }
);

// Define Order model
class Order extends Model {}
Order.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'users',
        key: 'id',
      },
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'pending',
    },
  },
  {
    sequelize,
    modelName: 'Order',
    tableName: 'orders',
  }
);

// Define relationships
User.hasMany(Order, { foreignKey: 'userId' });
Order.belongsTo(User, { foreignKey: 'userId' });

async function main() {
  console.log('Sequelize Integration Example\n');
  console.log('='.repeat(60));

  // Sync database
  await sequelize.sync();
  console.log('✓ Database synced');

  // Create sample data
  const user1 = await User.create({
    email: 'john@example.com',
    name: 'John Doe',
    password: 'hashed_password',
    role: 'user',
  });

  const user2 = await User.create({
    email: 'jane@example.com',
    name: 'Jane Smith',
    password: 'hashed_password',
    role: 'admin',
  });

  await Order.create({ userId: user1.id, total: 99.99, status: 'completed' });
  await Order.create({ userId: user1.id, total: 149.99, status: 'pending' });
  await Order.create({ userId: user2.id, total: 299.99, status: 'completed' });

  console.log('✓ Sample data created\n');

  // Create chatbot from Sequelize
  const chatbot = await createChatbotFromSequelize(
    sequelize,
    {
      llmProvider: 'openai',
      apiKey: process.env.OPENAI_API_KEY || 'your-api-key',
      security: {
        allowedOperations: ['SELECT'],
        maxRowLimit: 100,
        enableRowLevelSecurity: true,
        markSensitiveColumns: ['password'],
      },
      debug: true,
    },
    {
      // Schema extraction options
      markSensitiveColumns: ['password', 'hash', 'secret'],
    }
  );

  console.log('✓ Chatbot created from Sequelize models\n');

  // Example 1: Simple query
  console.log('\n' + '='.repeat(60));
  console.log('Example 1: Simple Query');
  console.log('='.repeat(60));

  try {
    const result1 = await chatbot.ask('Show all users', {
      userId: 1,
      role: 'admin',
    });

    console.log('\nQuestion:', result1.question);
    console.log('Query:', result1.query);
    console.log('Results:', result1.results);
  } catch (error: any) {
    console.log('Note: Add your API key to test this example');
    console.log('Error:', error.message);
  }

  // Example 2: Query with joins
  console.log('\n' + '='.repeat(60));
  console.log('Example 2: Query with Joins');
  console.log('='.repeat(60));

  try {
    const result2 = await chatbot.ask('Show all orders with user information', {
      userId: 1,
      role: 'admin',
    });

    console.log('\nQuestion:', result2.question);
    console.log('Query:', result2.query);
    console.log('Results:', result2.results);
  } catch (error: any) {
    console.log('Error:', error.message);
  }

  // Example 3: Aggregation query
  console.log('\n' + '='.repeat(60));
  console.log('Example 3: Aggregation Query');
  console.log('='.repeat(60));

  try {
    const result3 = await chatbot.ask('What is the total revenue by user?', {
      userId: 1,
      role: 'admin',
    });

    console.log('\nQuestion:', result3.question);
    console.log('Query:', result3.query);
    console.log('Results:', result3.results);
  } catch (error: any) {
    console.log('Error:', error.message);
  }

  // Example 4: User-specific query with row-level security
  console.log('\n' + '='.repeat(60));
  console.log('Example 4: Row-Level Security');
  console.log('='.repeat(60));

  try {
    const result4 = await chatbot.ask('Show my orders', {
      userId: 1,
      role: 'user',
    });

    console.log('\nQuestion:', result4.question);
    console.log('Query:', result4.query);
    console.log('Note: Automatically filtered for userId = 1');
    console.log('Results:', result4.results);
  } catch (error: any) {
    console.log('Error:', error.message);
  }

  // Example 5: Query with explanation
  console.log('\n' + '='.repeat(60));
  console.log('Example 5: Query with Explanation');
  console.log('='.repeat(60));

  try {
    const result5 = await chatbot.askWithExplanation(
      'Find users who have spent more than $100',
      {
        userId: 1,
        role: 'admin',
      }
    );

    console.log('\nQuestion:', result5.question);
    console.log('Query:', result5.query);
    console.log('Explanation:', result5.explanation);
    console.log('Results:', result5.results);
  } catch (error: any) {
    console.log('Error:', error.message);
  }

  console.log('\n' + '='.repeat(60));
  console.log('\nSequelize integration complete!');
  console.log('The chatbot automatically:');
  console.log('  ✓ Extracted schema from Sequelize models');
  console.log('  ✓ Detected relationships (foreign keys)');
  console.log('  ✓ Marked sensitive columns');
  console.log('  ✓ Applied security rules');
  console.log('  ✓ Executed queries using Sequelize');

  await sequelize.close();
}

// Run if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { main };
