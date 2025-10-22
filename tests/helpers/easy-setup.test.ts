/**
 * Tests for Easy Setup Helpers
 */

import { ChatbotHelper } from '../../src/helpers/easy-setup';
import { QueryGenerator } from '../../src/generator';
import { SequelizeAdapter } from '../../src/adapters';

// Mock the adapters
jest.mock('../../src/adapters/sequelize');
jest.mock('../../src/generator');

describe('ChatbotHelper', () => {
  let mockGenerator: jest.Mocked<QueryGenerator>;
  let mockAdapter: jest.Mocked<SequelizeAdapter>;
  let chatbot: ChatbotHelper;

  beforeEach(() => {
    mockGenerator = {
      generateQuery: jest.fn(),
      generateQueryWithExplanation: jest.fn(),
    } as any;

    mockAdapter = {
      executeQuery: jest.fn(),
    } as any;

    chatbot = new ChatbotHelper(mockGenerator, mockAdapter);
  });

  describe('ask', () => {
    it('should generate and execute query', async () => {
      const mockQueryResult = {
        query: 'SELECT * FROM users',
        metadata: { operation: 'SELECT' as const, tables: ['users'] },
      };

      const mockExecutionResult = [
        { id: 1, name: 'John' },
        { id: 2, name: 'Jane' },
      ];

      mockGenerator.generateQuery.mockResolvedValue(mockQueryResult);
      mockAdapter.executeQuery.mockResolvedValue(mockExecutionResult);

      const result = await chatbot.ask('Show all users', {
        userId: 123,
        role: 'user',
      });

      expect(mockGenerator.generateQuery).toHaveBeenCalledWith(
        'Show all users',
        { userId: 123, role: 'user' }
      );
      expect(mockAdapter.executeQuery).toHaveBeenCalledWith(
        'SELECT * FROM users',
        undefined
      );
      expect(result.question).toBe('Show all users');
      expect(result.query).toBe('SELECT * FROM users');
      expect(result.results).toEqual(mockExecutionResult);
    });

    it('should handle errors gracefully', async () => {
      mockGenerator.generateQuery.mockRejectedValue(
        new Error('Generation failed')
      );

      await expect(
        chatbot.ask('Invalid query')
      ).rejects.toThrow('Generation failed');
    });
  });

  describe('askWithExplanation', () => {
    it('should generate query with explanation', async () => {
      const mockQueryResult = {
        query: 'SELECT * FROM users',
        explanation: 'This query retrieves all users',
        metadata: { operation: 'SELECT' as const, tables: ['users'] },
      };

      const mockExecutionResult = [{ id: 1, name: 'John' }];

      mockGenerator.generateQueryWithExplanation.mockResolvedValue(
        mockQueryResult
      );
      mockAdapter.executeQuery.mockResolvedValue(mockExecutionResult);

      const result = await chatbot.askWithExplanation('Show all users');

      expect(mockGenerator.generateQueryWithExplanation).toHaveBeenCalled();
      expect(result.explanation).toBe('This query retrieves all users');
      expect(result.results).toEqual(mockExecutionResult);
    });
  });
});
