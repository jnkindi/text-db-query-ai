/**
 * JavaScript ESM Usage Example
 *
 * This example shows how to use text-db-query-ai with ES Modules
 */

import { Sequelize, DataTypes } from 'sequelize';
import { createChatbotFromSequelize } from 'text-db-query-ai';

async function main() {
  console.log('JavaScript (ESM) Usage Example\n');
  console.log('='.repeat(60));

  // Initialize Sequelize
  const sequelize = new Sequelize('sqlite::memory:', {
    logging: false,
  });

  // Define models
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
  });

  await sequelize.sync();
  console.log('✓ Database synced');

  // Create sample data
  await User.create({
    email: 'jane@example.com',
    name: 'Jane Smith',
  });

  console.log('✓ Sample data created\n');

  // Create chatbot - ESM syntax!
  const chatbot = await createChatbotFromSequelize(sequelize, {
    llmProvider: 'openai',
    apiKey: process.env.OPENAI_API_KEY || 'your-api-key',
    security: {
      allowedOperations: ['SELECT'],
      maxRowLimit: 50,
    },
  });

  console.log('✓ Chatbot created (ESM style)\n');

  console.log('='.repeat(60));
  console.log('\nESM Usage Complete!');
  console.log('\nKey Points:');
  console.log('  ✓ Works with ES Modules (import)');
  console.log('  ✓ Modern JavaScript syntax');
  console.log('  ✓ Node.js 16+ required');
  console.log('  ✓ Same API as CommonJS');

  await sequelize.close();
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
