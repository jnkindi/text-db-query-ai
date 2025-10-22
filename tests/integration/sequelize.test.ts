/**
 * Integration tests for Sequelize adapter
 */

import { Sequelize, DataTypes, Model } from 'sequelize';
import { SequelizeAdapter } from '../../src/adapters/sequelize';

describe('SequelizeAdapter Integration', () => {
  let sequelize: Sequelize;
  let adapter: SequelizeAdapter;

  beforeAll(async () => {
    // Use in-memory SQLite for testing
    sequelize = new Sequelize('sqlite::memory:', {
      logging: false,
    });

    // Define test models
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
        },
        name: {
          type: DataTypes.STRING,
        },
        password: {
          type: DataTypes.STRING,
          allowNull: false,
        },
      },
      {
        sequelize,
        modelName: 'User',
        tableName: 'users',
      }
    );

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
        },
      },
      {
        sequelize,
        modelName: 'Order',
        tableName: 'orders',
      }
    );

    await sequelize.sync();

    adapter = new SequelizeAdapter(sequelize, {
      markSensitiveColumns: ['password'],
    });
  });

  afterAll(async () => {
    await sequelize.close();
  });

  describe('extractSchema', () => {
    it('should extract schema from Sequelize models', async () => {
      const schema = await adapter.extractSchema();

      expect(schema.databaseType).toBe('sqlite');
      expect(schema.tables).toHaveLength(2);

      const userTable = schema.tables.find((t) => t.name === 'users');
      expect(userTable).toBeDefined();
      expect(userTable?.columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'id', type: 'integer' }),
          expect.objectContaining({ name: 'email', type: 'varchar' }),
          expect.objectContaining({ name: 'name', type: 'varchar' }),
          expect.objectContaining({
            name: 'password',
            type: 'varchar',
            sensitive: true,
          }),
        ])
      );
    });

    it('should detect foreign keys', async () => {
      const schema = await adapter.extractSchema();

      const orderTable = schema.tables.find((t) => t.name === 'orders');
      expect(orderTable?.foreignKeys).toEqual([
        {
          column: 'userId',
          referencedTable: 'users',
          referencedColumn: 'id',
        },
      ]);
    });

    it('should identify primary keys', async () => {
      const schema = await adapter.extractSchema();

      const userTable = schema.tables.find((t) => t.name === 'users');
      expect(userTable?.primaryKey).toBe('id');
    });
  });

  describe('executeQuery', () => {
    beforeEach(async () => {
      // Clear and seed data
      await sequelize.models.User.destroy({ where: {} });
      await sequelize.models.Order.destroy({ where: {} });

      await sequelize.models.User.create({
        email: 'test@example.com',
        name: 'Test User',
        password: 'hashed',
      });
    });

    it('should execute SELECT queries', async () => {
      const results = await adapter.executeQuery('SELECT * FROM users');

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        email: 'test@example.com',
        name: 'Test User',
      });
    });

    it('should handle parameterized queries', async () => {
      const results = await adapter.executeQuery(
        'SELECT * FROM users WHERE email = ?',
        ['test@example.com']
      );

      expect(results).toHaveLength(1);
    });
  });

  describe('schema extraction options', () => {
    it('should include only specified tables', async () => {
      const adapter = new SequelizeAdapter(sequelize, {
        includeTables: ['users'],
      });

      const schema = await adapter.extractSchema();

      expect(schema.tables).toHaveLength(1);
      expect(schema.tables[0].name).toBe('users');
    });

    it('should exclude specified tables', async () => {
      const adapter = new SequelizeAdapter(sequelize, {
        excludeTables: ['orders'],
      });

      const schema = await adapter.extractSchema();

      expect(schema.tables.every((t) => t.name !== 'orders')).toBe(true);
    });
  });
});
