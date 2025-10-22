/**
 * JavaScript Usage Example
 *
 * This example shows how to use text-db-query-ai in plain JavaScript (CommonJS)
 */

const { Sequelize, DataTypes } = require('sequelize');
const { createChatbotFromSequelize } = require('text-db-query-ai');

async function main() {
  console.log('JavaScript (CommonJS) Usage Example\n');
  console.log('='.repeat(60));

  // Initialize Sequelize (in-memory SQLite for demo)
  const sequelize = new Sequelize('sqlite::memory:', {
    logging: false,
  });

  // Define models using JavaScript
  const User = sequelize.define('User', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
    },
    role: {
      type: DataTypes.STRING,
      defaultValue: 'user',
    },
  });

  const Order = sequelize.define('Order', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    total: {
      type: DataTypes.DECIMAL(10, 2),
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'pending',
    },
  });

  // Define relationships
  User.hasMany(Order, { foreignKey: 'userId' });
  Order.belongsTo(User, { foreignKey: 'userId' });

  // Sync database
  await sequelize.sync();
  console.log('✓ Database synced');

  // Create sample data
  const user = await User.create({
    email: 'john@example.com',
    name: 'John Doe',
    role: 'user',
  });

  await Order.create({
    userId: user.id,
    total: 99.99,
    status: 'completed',
  });

  await Order.create({
    userId: user.id,
    total: 149.99,
    status: 'pending',
  });

  console.log('✓ Sample data created\n');

  // Create chatbot - WORKS IN JAVASCRIPT!
  const chatbot = await createChatbotFromSequelize(sequelize, {
    llmProvider: 'openai',
    apiKey: process.env.OPENAI_API_KEY || 'your-api-key',
    security: {
      allowedOperations: ['SELECT'],
      maxRowLimit: 100,
    },
    debug: false,
  });

  console.log('✓ Chatbot created from Sequelize models\n');

  console.log('Example 1: Simple Query');
  console.log('-'.repeat(60));
  console.log('Question: Show all users');
  console.log('Note: Add OPENAI_API_KEY to test actual queries\n');

  console.log('Example 2: User-Specific Query');
  console.log('-'.repeat(60));
  console.log('Question: Show my orders');
  console.log('User ID: 1');
  console.log('Note: Automatically filtered by user_id\n');

  console.log('='.repeat(60));
  console.log('\nJavaScript Usage Complete!');
  console.log('\nKey Points:');
  console.log('  ✓ Works with CommonJS (require)');
  console.log('  ✓ No TypeScript needed');
  console.log('  ✓ Same API as TypeScript');
  console.log('  ✓ Full feature support');

  await sequelize.close();
}

// Run the example
main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
