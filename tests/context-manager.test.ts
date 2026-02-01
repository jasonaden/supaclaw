/**
 * Context Manager Tests
 * Tests for token budgeting, smart context selection, and lost-in-middle mitigation
 */

import {
  estimateTokens,
  estimateTokensAccurate,
  createContextBudget,
  createAdaptiveBudget,
  selectContextItems,
  arrangeForLostInMiddle,
  buildContextWindow,
  formatContextWindow,
  getContextStats,
  getBudgetForModel,
  messagesToContextItems,
  memoriesToContextItems,
  ContextItem
} from '../src/context-manager';

import type { Message, Memory, Learning, Entity } from '../src/index';

describe('Token Estimation', () => {
  test('estimateTokens should roughly estimate tokens', () => {
    const text = 'Hello world';
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  test('estimateTokensAccurate should use word count', () => {
    const text = 'The quick brown fox jumps over the lazy dog';
    const tokens = estimateTokensAccurate(text);
    expect(tokens).toBeGreaterThan(8);
    expect(tokens).toBeLessThan(15);
  });
});

describe('Context Budget', () => {
  test('createContextBudget should create valid budget', () => {
    const budget = createContextBudget({
      modelContextSize: 128000
    });

    expect(budget.total).toBe(128000);
    expect(budget.systemPrompt).toBe(2000);
    expect(budget.reserve).toBe(4000);
    expect(budget.recentMessages).toBeGreaterThan(0);
    expect(budget.memories).toBeGreaterThan(0);
    expect(budget.learnings).toBeGreaterThan(0);
    expect(budget.entities).toBeGreaterThan(0);

    // Check total allocation doesn't exceed model size
    const allocated = 
      budget.systemPrompt +
      budget.reserve +
      budget.recentMessages +
      budget.memories +
      budget.learnings +
      budget.entities;

    expect(allocated).toBeLessThanOrEqual(budget.total);
  });

  test('createContextBudget should allow custom percentages', () => {
    const budget = createContextBudget({
      modelContextSize: 100000,
      recentMessagesPct: 0.5,
      memoriesPct: 0.3,
      learningsPct: 0.15,
      entitiesPct: 0.05
    });

    const available = 100000 - 2000 - 4000; // total - system - reserve
    
    expect(budget.recentMessages).toBeCloseTo(available * 0.5, -2);
    expect(budget.memories).toBeCloseTo(available * 0.3, -2);
    expect(budget.learnings).toBeCloseTo(available * 0.15, -2);
    expect(budget.entities).toBeCloseTo(available * 0.05, -2);
  });

  test('createAdaptiveBudget should adjust based on content', () => {
    const budget = createAdaptiveBudget({
      messageCount: 100,
      memoryCount: 50,
      learningCount: 25,
      entityCount: 25
    });

    // Messages should get the most (100/200 = 50%)
    // Memories should get 25%
    // Learnings and entities each get 12.5%
    expect(budget.recentMessages).toBeGreaterThan(budget.memories);
    expect(budget.memories).toBeGreaterThan(budget.learnings);
    expect(budget.learnings).toBeGreaterThanOrEqual(budget.entities);
  });

  test('getBudgetForModel should return model-specific budgets', () => {
    const claude = getBudgetForModel('claude-3.5-sonnet');
    expect(claude.total).toBe(200000);

    const gpt4turbo = getBudgetForModel('gpt-4-turbo');
    expect(gpt4turbo.total).toBe(128000);

    const gpt35 = getBudgetForModel('gpt-3.5-turbo');
    expect(gpt35.total).toBe(16384);

    const unknown = getBudgetForModel('unknown-model');
    expect(unknown.total).toBe(128000); // Falls back to default
  });
});

describe('Context Item Conversion', () => {
  test('messagesToContextItems should convert messages', () => {
    const messages: Message[] = [
      {
        id: '1',
        session_id: 's1',
        role: 'user',
        content: 'Hello',
        created_at: new Date().toISOString(),
        metadata: {}
      },
      {
        id: '2',
        session_id: 's1',
        role: 'assistant',
        content: 'Hi there!',
        created_at: new Date().toISOString(),
        metadata: {}
      }
    ];

    const items = messagesToContextItems(messages);
    expect(items).toHaveLength(2);
    expect(items[0].type).toBe('message');
    expect(items[0].content).toContain('user: Hello');
    expect(items[0].importance).toBe(0.8); // User messages more important
    expect(items[1].importance).toBe(0.6); // Assistant messages
  });

  test('memoriesToContextItems should convert memories', () => {
    const memories: Memory[] = [
      {
        id: '1',
        agent_id: 'agent1',
        content: 'User prefers dark mode',
        category: 'preference',
        importance: 0.9,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {}
      }
    ];

    const items = memoriesToContextItems(memories);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('memory');
    expect(items[0].content).toContain('[Memory: preference]');
    expect(items[0].importance).toBe(0.9);
  });
});

describe('Context Selection', () => {
  test('selectContextItems should select items within budget', () => {
    const items: ContextItem[] = [
      {
        type: 'message',
        content: 'x'.repeat(100),
        importance: 0.9,
        timestamp: new Date().toISOString(),
        tokenCount: 25
      },
      {
        type: 'message',
        content: 'x'.repeat(100),
        importance: 0.8,
        timestamp: new Date(Date.now() - 1000).toISOString(),
        tokenCount: 25
      },
      {
        type: 'message',
        content: 'x'.repeat(100),
        importance: 0.7,
        timestamp: new Date(Date.now() - 2000).toISOString(),
        tokenCount: 25
      },
      {
        type: 'message',
        content: 'x'.repeat(100),
        importance: 0.5,
        timestamp: new Date(Date.now() - 3000).toISOString(),
        tokenCount: 25
      }
    ];

    // Budget for 2 items
    const selected = selectContextItems(items, 50);
    expect(selected.length).toBeLessThanOrEqual(2);
    
    // Should select highest importance + recency
    const totalTokens = selected.reduce((sum, item) => sum + item.tokenCount, 0);
    expect(totalTokens).toBeLessThanOrEqual(50);
  });

  test('selectContextItems should prioritize importance over recency', () => {
    const items: ContextItem[] = [
      {
        type: 'memory',
        content: 'Old but important',
        importance: 0.95,
        timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
        tokenCount: 10
      },
      {
        type: 'memory',
        content: 'Recent but less important',
        importance: 0.3,
        timestamp: new Date().toISOString(),
        tokenCount: 10
      }
    ];

    const selected = selectContextItems(items, 15, {
      importanceWeight: 0.9,
      recencyWeight: 0.1
    });

    expect(selected).toHaveLength(1);
    expect(selected[0].importance).toBe(0.95);
  });

  test('selectContextItems should prioritize recency when weighted', () => {
    const items: ContextItem[] = [
      {
        type: 'message',
        content: 'Old message',
        importance: 0.6,
        timestamp: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        tokenCount: 10
      },
      {
        type: 'message',
        content: 'New message',
        importance: 0.5,
        timestamp: new Date().toISOString(),
        tokenCount: 10
      }
    ];

    const selected = selectContextItems(items, 15, {
      importanceWeight: 0.3,
      recencyWeight: 0.7
    });

    expect(selected).toHaveLength(1);
    // Recent message should win with high recency weight
    expect(selected[0].content).toBe('New message');
  });
});

describe('Lost in the Middle Mitigation', () => {
  test('arrangeForLostInMiddle should place high-importance items at edges', () => {
    const items: ContextItem[] = [
      { type: 'message', content: 'Low 1', importance: 0.3, timestamp: '', tokenCount: 5 },
      { type: 'message', content: 'High 1', importance: 0.9, timestamp: '', tokenCount: 5 },
      { type: 'message', content: 'Medium 1', importance: 0.6, timestamp: '', tokenCount: 5 },
      { type: 'message', content: 'High 2', importance: 0.85, timestamp: '', tokenCount: 5 },
      { type: 'message', content: 'Medium 2', importance: 0.5, timestamp: '', tokenCount: 5 },
      { type: 'message', content: 'Low 2', importance: 0.2, timestamp: '', tokenCount: 5 }
    ];

    const arranged = arrangeForLostInMiddle(items);

    // First and last items should be high importance
    expect(arranged[0].importance).toBeGreaterThan(0.7);
    expect(arranged[arranged.length - 1].importance).toBeGreaterThan(0.7);

    // Middle items should be lower importance
    const middleItems = arranged.slice(1, -1);
    const avgMiddleImportance = middleItems.reduce((sum, i) => sum + i.importance, 0) / middleItems.length;
    expect(avgMiddleImportance).toBeLessThan(arranged[0].importance);
  });

  test('arrangeForLostInMiddle should handle small arrays', () => {
    const items: ContextItem[] = [
      { type: 'message', content: 'Item 1', importance: 0.5, timestamp: '', tokenCount: 5 },
      { type: 'message', content: 'Item 2', importance: 0.8, timestamp: '', tokenCount: 5 }
    ];

    const arranged = arrangeForLostInMiddle(items);
    expect(arranged).toEqual(items); // Too few to rearrange
  });
});

describe('Context Window Building', () => {
  test('buildContextWindow should combine all content types', () => {
    const messages: Message[] = [
      {
        id: '1',
        session_id: 's1',
        role: 'user',
        content: 'Test message',
        created_at: new Date().toISOString(),
        metadata: {}
      }
    ];

    const memories: Memory[] = [
      {
        id: '1',
        agent_id: 'a1',
        content: 'Test memory',
        importance: 0.8,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {}
      }
    ];

    const learnings: Learning[] = [
      {
        id: '1',
        agent_id: 'a1',
        category: 'improvement',
        trigger: 'test',
        lesson: 'Test lesson',
        severity: 'info',
        applied_count: 0,
        created_at: new Date().toISOString(),
        metadata: {}
      }
    ];

    const entities: Entity[] = [
      {
        id: '1',
        agent_id: 'a1',
        entity_type: 'person',
        name: 'Alice',
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        mention_count: 5,
        properties: {}
      }
    ];

    const budget = createContextBudget({ modelContextSize: 128000 });

    const window = buildContextWindow({
      messages,
      memories,
      learnings,
      entities,
      budget,
      useLostInMiddleFix: false
    });

    expect(window.items.length).toBeGreaterThan(0);
    expect(window.totalTokens).toBeGreaterThan(0);
    expect(window.budget).toEqual(budget);

    // Check all types are present
    const types = new Set(window.items.map(i => i.type));
    expect(types.has('message')).toBe(true);
    expect(types.has('memory')).toBe(true);
    expect(types.has('learning')).toBe(true);
    expect(types.has('entity')).toBe(true);
  });

  test('buildContextWindow should apply lost-in-middle fix', () => {
    const messages: Message[] = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      session_id: 's1',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}`,
      created_at: new Date(Date.now() - i * 1000).toISOString(),
      metadata: {}
    }));

    const budget = createContextBudget({ modelContextSize: 128000 });

    const withFix = buildContextWindow({
      messages,
      memories: [],
      learnings: [],
      entities: [],
      budget,
      useLostInMiddleFix: true
    });

    const withoutFix = buildContextWindow({
      messages,
      memories: [],
      learnings: [],
      entities: [],
      budget,
      useLostInMiddleFix: false
    });

    // With fix: high importance at edges
    expect(withFix.items[0].importance).toBeGreaterThanOrEqual(withFix.items[Math.floor(withFix.items.length / 2)].importance);

    // Without fix: chronological order
    const timestamps = withoutFix.items.map(i => new Date(i.timestamp).getTime());
    const sorted = [...timestamps].sort((a, b) => a - b);
    expect(timestamps).toEqual(sorted);
  });

  test('buildContextWindow should mark truncation', () => {
    const messages: Message[] = Array.from({ length: 1000 }, (_, i) => ({
      id: String(i),
      session_id: 's1',
      role: 'user',
      content: 'x'.repeat(100),
      created_at: new Date().toISOString(),
      metadata: {}
    }));

    const budget = createContextBudget({ modelContextSize: 8000 });

    const window = buildContextWindow({
      messages,
      memories: [],
      learnings: [],
      entities: [],
      budget
    });

    expect(window.truncated).toBe(true);
    expect(window.items.length).toBeLessThan(messages.length);
  });
});

describe('Context Formatting', () => {
  test('formatContextWindow should format as text', () => {
    const items: ContextItem[] = [
      {
        type: 'memory',
        content: '[Memory: preference] Dark mode preferred',
        importance: 0.8,
        timestamp: new Date().toISOString(),
        tokenCount: 5
      },
      {
        type: 'message',
        content: 'user: Hello',
        importance: 0.7,
        timestamp: new Date().toISOString(),
        tokenCount: 2
      }
    ];

    const window = {
      items,
      totalTokens: 7,
      budget: createContextBudget({}),
      truncated: false
    };

    const formatted = formatContextWindow(window);
    expect(formatted).toContain('[Memory: preference]');
    expect(formatted).toContain('user: Hello');
  });

  test('formatContextWindow should group by type', () => {
    const items: ContextItem[] = [
      {
        type: 'message',
        content: 'user: Test',
        importance: 0.7,
        timestamp: new Date().toISOString(),
        tokenCount: 2
      },
      {
        type: 'memory',
        content: '[Memory] Test memory',
        importance: 0.8,
        timestamp: new Date().toISOString(),
        tokenCount: 3
      }
    ];

    const window = {
      items,
      totalTokens: 5,
      budget: createContextBudget({}),
      truncated: false
    };

    const formatted = formatContextWindow(window, { groupByType: true });
    
    expect(formatted).toContain('# Relevant Memories');
    expect(formatted).toContain('# Recent Conversation');
    
    // Memories should come before messages
    const memoryIndex = formatted.indexOf('# Relevant Memories');
    const messageIndex = formatted.indexOf('# Recent Conversation');
    expect(memoryIndex).toBeLessThan(messageIndex);
  });
});

describe('Context Stats', () => {
  test('getContextStats should calculate stats', () => {
    const items: ContextItem[] = [
      { type: 'message', content: 'test', importance: 0.5, timestamp: '', tokenCount: 10 },
      { type: 'message', content: 'test', importance: 0.5, timestamp: '', tokenCount: 10 },
      { type: 'memory', content: 'test', importance: 0.8, timestamp: '', tokenCount: 15 },
      { type: 'learning', content: 'test', importance: 0.7, timestamp: '', tokenCount: 5 }
    ];

    const budget = createContextBudget({ modelContextSize: 128000 });
    const window = {
      items,
      totalTokens: 40,
      budget,
      truncated: false
    };

    const stats = getContextStats(window);

    expect(stats.totalItems).toBe(4);
    expect(stats.totalTokens).toBe(40);
    expect(stats.itemsByType.message).toBe(2);
    expect(stats.itemsByType.memory).toBe(1);
    expect(stats.itemsByType.learning).toBe(1);
    expect(stats.budgetUsed).toBeGreaterThan(0);
    expect(stats.budgetRemaining).toBeGreaterThan(0);
    expect(stats.truncated).toBe(false);
  });
});
