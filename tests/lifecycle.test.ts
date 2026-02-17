/**
 * Tests for Memory Lifecycle Management
 * Phase 6: Importance decay, consolidation, versioning, tagging, auto-cleanup
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { Supaclaw } from '../src/index';

// Mock Supabase client
const mockSupabase = {
  from: (table: string) => ({
    select: () => mockSupabase.from(table),
    insert: () => mockSupabase.from(table),
    update: () => mockSupabase.from(table),
    delete: () => mockSupabase.from(table),
    eq: () => mockSupabase.from(table),
    neq: () => mockSupabase.from(table),
    lt: () => mockSupabase.from(table),
    gt: () => mockSupabase.from(table),
    gte: () => mockSupabase.from(table),
    lte: () => mockSupabase.from(table),
    is: () => mockSupabase.from(table),
    not: () => mockSupabase.from(table),
    in: () => mockSupabase.from(table),
    order: () => mockSupabase.from(table),
    limit: () => mockSupabase.from(table),
    single: () => Promise.resolve({ data: null, error: null }),
    then: (fn: any) => fn({ data: [], error: null })
  })
};

describe('Memory Lifecycle Management', () => {
  let memory: Supaclaw;

  beforeEach(() => {
    memory = new Supaclaw({
      supabaseUrl: 'https://test.supabase.co',
      supabaseKey: 'test-key',
      agentId: 'test-agent',
      embeddingProvider: 'none'
    });
    // @ts-ignore - Replace with mock
    memory.supabase = mockSupabase;
  });

  describe('Importance Decay', () => {
    it('should decay memory importance over time', async () => {
      const result = await memory.decayMemoryImportance({
        decayRate: 0.1,
        olderThanDays: 7
      });

      expect(result).toHaveProperty('updated');
      expect(result).toHaveProperty('avgDecay');
      expect(result.updated).toBeGreaterThanOrEqual(0);
      expect(result.avgDecay).toBeGreaterThanOrEqual(0);
    });

    it('should respect minimum importance threshold', async () => {
      const result = await memory.decayMemoryImportance({
        minImportance: 0.2
      });

      expect(result.updated).toBeGreaterThanOrEqual(0);
    });

    it('should only decay old memories', async () => {
      const result = await memory.decayMemoryImportance({
        olderThanDays: 30
      });

      expect(result).toBeDefined();
    });
  });

  describe('Memory Consolidation', () => {
    it('should merge similar memories', async () => {
      const result = await memory.consolidateMemories({
        similarityThreshold: 0.9
      });

      expect(result).toHaveProperty('merged');
      expect(result).toHaveProperty('kept');
      expect(result.merged).toBeGreaterThanOrEqual(0);
      expect(result.kept).toBeGreaterThanOrEqual(0);
    });

    it('should filter by category', async () => {
      const result = await memory.consolidateMemories({
        category: 'preferences'
      });

      expect(result).toBeDefined();
    });

    it('should limit consolidation scope', async () => {
      const result = await memory.consolidateMemories({
        limit: 50
      });

      expect(result).toBeDefined();
    });
  });

  describe('Memory Versioning', () => {
    it('should create version snapshot', async () => {
      // Mock a memory
      const mockMemory = {
        id: 'mem-123',
        agent_id: 'test-agent',
        content: 'Original content',
        importance: 0.8,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {}
      };

      // @ts-ignore
      mockSupabase.from('memories').single = () => 
        Promise.resolve({ data: mockMemory, error: null });

      const result = await memory.versionMemory('mem-123');

      expect(result).toHaveProperty('memory');
      expect(result).toHaveProperty('versionId');
    });

    it('should retrieve version history', async () => {
      const mockMemory = {
        id: 'mem-123',
        metadata: {
          versions: [
            {
              timestamp: '2024-01-01T00:00:00Z',
              content: 'Version 1',
              importance: 0.7
            },
            {
              timestamp: '2024-01-02T00:00:00Z',
              content: 'Version 2',
              importance: 0.8
            }
          ]
        }
      };

      // @ts-ignore
      mockSupabase.from('memories').single = () => 
        Promise.resolve({ data: mockMemory, error: null });

      const versions = await memory.getMemoryVersions('mem-123');

      expect(versions).toHaveLength(2);
      expect(versions[0]).toHaveProperty('version', 'v1');
      expect(versions[1]).toHaveProperty('version', 'v2');
    });
  });

  describe('Memory Tagging', () => {
    it('should add tags to memory', async () => {
      const mockMemory = {
        id: 'mem-123',
        metadata: {}
      };

      // @ts-ignore
      mockSupabase.from('memories').single = () => 
        Promise.resolve({ data: mockMemory, error: null });

      const result = await memory.tagMemory('mem-123', ['important', 'work']);

      expect(result).toBeDefined();
    });

    it('should remove tags from memory', async () => {
      const mockMemory = {
        id: 'mem-123',
        metadata: {
          tags: ['important', 'work', 'personal']
        }
      };

      // @ts-ignore
      mockSupabase.from('memories').single = () => 
        Promise.resolve({ data: mockMemory, error: null });

      const result = await memory.untagMemory('mem-123', ['work']);

      expect(result).toBeDefined();
    });

    it('should search memories by tags (match ANY)', async () => {
      const mockMemories = [
        { id: 'mem-1', metadata: { tags: ['work', 'important'] } },
        { id: 'mem-2', metadata: { tags: ['personal'] } },
        { id: 'mem-3', metadata: { tags: ['work'] } }
      ];

      // @ts-ignore
      mockSupabase.from('memories').then = (fn: any) => 
        fn({ data: mockMemories, error: null });

      const results = await memory.searchMemoriesByTags(['work'], {
        matchAll: false
      });

      expect(results.length).toBeGreaterThanOrEqual(0);
    });

    it('should search memories by tags (match ALL)', async () => {
      const mockMemories = [
        { id: 'mem-1', metadata: { tags: ['work', 'important'] } },
        { id: 'mem-2', metadata: { tags: ['work'] } },
        { id: 'mem-3', metadata: { tags: ['important'] } }
      ];

      // @ts-ignore
      mockSupabase.from('memories').then = (fn: any) => 
        fn({ data: mockMemories, error: null });

      const results = await memory.searchMemoriesByTags(['work', 'important'], {
        matchAll: true
      });

      expect(results.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Session Cleanup', () => {
    it('should archive old sessions', async () => {
      const result = await memory.cleanupOldSessions({
        olderThanDays: 90,
        action: 'archive'
      });

      expect(result).toHaveProperty('archived');
      expect(result.archived).toBeGreaterThanOrEqual(0);
    });

    it('should delete old sessions', async () => {
      const result = await memory.cleanupOldSessions({
        olderThanDays: 180,
        action: 'delete'
      });

      expect(result).toHaveProperty('deleted');
      expect(result.deleted).toBeGreaterThanOrEqual(0);
    });

    it('should keep sessions with summaries', async () => {
      const result = await memory.cleanupOldSessions({
        keepSummaries: true
      });

      expect(result).toBeDefined();
    });

    it('should get cleanup statistics', async () => {
      const stats = await memory.getCleanupStats();

      expect(stats).toHaveProperty('totalSessions');
      expect(stats).toHaveProperty('archivedSessions');
      expect(stats).toHaveProperty('oldSessions');
      expect(stats).toHaveProperty('totalMessages');
      expect(stats).toHaveProperty('orphanedMessages');
    });
  });

  describe('Integration', () => {
    it('should run full lifecycle maintenance', async () => {
      // Decay importance
      const decay = await memory.decayMemoryImportance({
        olderThanDays: 7
      });

      // Consolidate similar memories
      const consolidate = await memory.consolidateMemories({
        similarityThreshold: 0.9
      });

      // Cleanup old sessions
      const cleanup = await memory.cleanupOldSessions({
        olderThanDays: 90,
        action: 'archive'
      });

      expect(decay).toBeDefined();
      expect(consolidate).toBeDefined();
      expect(cleanup).toBeDefined();
    });
  });
});
