/**
 * Tests for EntityManager
 * Uses mock Supabase client with DI pattern (no real DB required)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EntityManager } from '../src/entities';
import type { SupaclawDeps } from '../src/types';

// Configurable mock results
let mockSingleResult: { data: unknown; error: unknown } = { data: null, error: null };
let mockListResult: { data: unknown[]; error: unknown } = { data: [], error: null };
let mockRpcResult: { data: unknown; error: unknown } = { data: null, error: null };

// Queue for sequential single() calls (e.g. updateEntity fetches then updates)
let singleResultQueue: Array<{ data: unknown; error: unknown }> = [];

const mockSupabase = {
  from: (_table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: () => chain,
      update: () => chain,
      delete: () => chain,
      eq: () => chain,
      neq: () => chain,
      lt: () => chain,
      gt: () => chain,
      gte: () => chain,
      lte: () => chain,
      is: () => chain,
      not: () => chain,
      in: () => chain,
      or: () => chain,
      ilike: () => chain,
      order: () => chain,
      limit: () => chain,
      range: () => chain,
      single: () => {
        if (singleResultQueue.length > 0) return Promise.resolve(singleResultQueue.shift()!);
        return Promise.resolve(mockSingleResult);
      },
      then: (fn: (val: typeof mockListResult) => void) => fn(mockListResult)
    };
    return chain;
  },
  rpc: (_fn: string, _args: unknown) => Promise.resolve(mockRpcResult)
};

const makeDeps = (): SupaclawDeps => ({
  supabase: mockSupabase as any,
  agentId: 'test-agent',
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseKey: 'test-key',
    agentId: 'test-agent',
    embeddingProvider: 'none'
  }
});

const mockEntity = (overrides: Record<string, unknown> = {}) => ({
  id: 'entity-1',
  agent_id: 'test-agent',
  entity_type: 'person',
  name: 'Alice',
  aliases: [] as string[],
  description: 'A test person',
  properties: {},
  first_seen_at: '2024-01-01T00:00:00Z',
  last_seen_at: '2024-01-01T00:00:00Z',
  mention_count: 1,
  ...overrides
});

const mockRelationship = (overrides: Record<string, unknown> = {}) => ({
  id: 'rel-1',
  agent_id: 'test-agent',
  source_entity_id: 'entity-1',
  target_entity_id: 'entity-2',
  relationship_type: 'works_at',
  properties: {},
  first_seen_at: '2024-01-01T00:00:00Z',
  last_seen_at: '2024-01-01T00:00:00Z',
  mention_count: 1,
  confidence: 0.8,
  metadata: {},
  ...overrides
});

describe('EntityManager', () => {
  let em: EntityManager;

  beforeEach(() => {
    mockSingleResult = { data: null, error: null };
    mockListResult = { data: [], error: null };
    mockRpcResult = { data: null, error: null };
    singleResultQueue = [];
    em = new EntityManager(makeDeps());
  });

  // ============ createEntity ============

  describe('createEntity', () => {
    it('should create an entity', async () => {
      mockSingleResult = { data: mockEntity(), error: null };

      const entity = await em.createEntity({ entityType: 'person', name: 'Alice' });

      expect(entity).toHaveProperty('id');
      expect(entity).toHaveProperty('name', 'Alice');
      expect(entity).toHaveProperty('entity_type', 'person');
    });

    it('should create an entity with aliases', async () => {
      mockSingleResult = {
        data: mockEntity({ aliases: ['Al', 'Ally'] }),
        error: null
      };

      const entity = await em.createEntity({
        entityType: 'person',
        name: 'Alice',
        aliases: ['Al', 'Ally']
      });

      expect(entity).toHaveProperty('aliases');
      expect((entity as any).aliases).toContain('Al');
    });

    it('should propagate DB errors as DatabaseError', async () => {
      mockSingleResult = {
        data: null,
        error: { message: 'unique constraint violation', code: '23505' }
      };

      await expect(
        em.createEntity({ entityType: 'person', name: 'Alice' })
      ).rejects.toMatchObject({ name: 'DatabaseError' });
    });
  });

  // ============ updateEntity ============

  describe('updateEntity', () => {
    it('should update an entity and increment mention count', async () => {
      // updateEntity fetches the entity first (for mention_count), then updates
      singleResultQueue = [
        { data: mockEntity({ mention_count: 1 }), error: null },
        { data: mockEntity({ description: 'Updated', mention_count: 2 }), error: null }
      ];

      const entity = await em.updateEntity('entity-1', { description: 'Updated' });

      expect(entity).toHaveProperty('id');
      expect((entity as any).description).toBe('Updated');
    });

    it('should propagate DB errors as DatabaseError', async () => {
      singleResultQueue = [
        { data: null, error: { message: 'unique constraint', code: '23505' } }
      ];

      await expect(
        em.updateEntity('entity-1', { description: 'Updated' })
      ).rejects.toMatchObject({ name: 'DatabaseError' });
    });
  });

  // ============ findEntity ============

  describe('findEntity', () => {
    it('should find entity by name', async () => {
      mockSingleResult = { data: mockEntity(), error: null };

      const entity = await em.findEntity('Alice');

      expect(entity).toBeTruthy();
      expect((entity as any).name).toBe('Alice');
    });

    it('should return null when entity not found (PGRST116)', async () => {
      mockSingleResult = { data: null, error: { code: 'PGRST116', message: 'not found' } };

      const entity = await em.findEntity('Unknown');

      expect(entity).toBeNull();
    });

    it('should throw on unexpected DB errors', async () => {
      mockSingleResult = { data: null, error: { code: '500', message: 'connection failed' } };

      await expect(em.findEntity('Alice')).rejects.toBeTruthy();
    });
  });

  // ============ searchEntities ============

  describe('searchEntities', () => {
    it('should return all entities with no filters', async () => {
      mockListResult = {
        data: [mockEntity(), mockEntity({ id: 'entity-2', name: 'Bob' })],
        error: null
      };

      const entities = await em.searchEntities();

      expect(Array.isArray(entities)).toBe(true);
      expect(entities.length).toBe(2);
    });

    it('should filter entities by query string', async () => {
      mockListResult = {
        data: [mockEntity()],
        error: null
      };

      const entities = await em.searchEntities({ query: 'Alice' });

      expect(entities).toHaveLength(1);
      expect((entities[0] as any).name).toBe('Alice');
    });

    it('should filter entities by type', async () => {
      mockListResult = {
        data: [mockEntity({ entity_type: 'organization', name: 'TechCorp' })],
        error: null
      };

      const entities = await em.searchEntities({ entityType: 'organization' });

      expect(entities).toHaveLength(1);
      expect((entities[0] as any).entity_type).toBe('organization');
    });

    it('should return empty array when no matches', async () => {
      mockListResult = { data: [], error: null };

      const entities = await em.searchEntities({ query: 'nonexistent' });

      expect(entities).toHaveLength(0);
    });
  });

  // ============ createEntityRelationship ============

  describe('createEntityRelationship', () => {
    it('should create a new relationship when none exists', async () => {
      // First single(): check existing → not found
      singleResultQueue = [{ data: null, error: { code: 'PGRST116', message: 'not found' } }];
      // Second single(): insert result
      mockSingleResult = { data: mockRelationship(), error: null };

      const rel = await em.createEntityRelationship({
        sourceEntityId: 'entity-1',
        targetEntityId: 'entity-2',
        relationshipType: 'works_at',
        confidence: 0.8
      });

      expect(rel).toHaveProperty('id');
      expect((rel as any).relationship_type).toBe('works_at');
    });

    it('should update existing relationship via RPC', async () => {
      // Check existing → found
      mockSingleResult = { data: mockRelationship({ mention_count: 1 }), error: null };
      // RPC returns updated relationship
      mockRpcResult = { data: mockRelationship({ mention_count: 2 }), error: null };

      const rel = await em.createEntityRelationship({
        sourceEntityId: 'entity-1',
        targetEntityId: 'entity-2',
        relationshipType: 'works_at'
      });

      expect((rel as any).mention_count).toBe(2);
    });

    it('should fall back to direct update when RPC fails', async () => {
      // Check existing → found
      singleResultQueue = [{ data: mockRelationship({ mention_count: 1 }), error: null }];
      // RPC fails
      mockRpcResult = { data: null, error: { message: 'function not found' } };
      // Fallback update single()
      mockSingleResult = { data: mockRelationship({ mention_count: 2 }), error: null };

      const rel = await em.createEntityRelationship({
        sourceEntityId: 'entity-1',
        targetEntityId: 'entity-2',
        relationshipType: 'works_at'
      });

      expect(rel).toHaveProperty('id');
    });
  });

  // ============ getEntityRelationships ============

  describe('getEntityRelationships', () => {
    it('should get outgoing relationships', async () => {
      mockListResult = {
        data: [{
          id: 'rel-1',
          relationship_type: 'works_at',
          confidence: 0.9,
          mention_count: 1,
          target: { id: 'entity-2', name: 'TechCorp', entity_type: 'organization' }
        }],
        error: null
      };

      const rels = await em.getEntityRelationships('entity-1', { direction: 'outgoing' });

      expect(rels).toHaveLength(1);
      expect(rels[0]).toHaveProperty('direction', 'outgoing');
      expect((rels[0]!.relatedEntity as any).name).toBe('TechCorp');
    });

    it('should get incoming relationships', async () => {
      mockListResult = {
        data: [{
          id: 'rel-2',
          relationship_type: 'employs',
          confidence: 0.8,
          mention_count: 1,
          source: { id: 'entity-3', name: 'MegaCorp', entity_type: 'organization' }
        }],
        error: null
      };

      const rels = await em.getEntityRelationships('entity-1', { direction: 'incoming' });

      expect(rels).toHaveLength(1);
      expect(rels[0]).toHaveProperty('direction', 'incoming');
      expect((rels[0]!.relatedEntity as any).name).toBe('MegaCorp');
    });

    it('should return combined results for direction=both', async () => {
      // Both outgoing and incoming queries use the same mockListResult
      mockListResult = {
        data: [{
          id: 'rel-1',
          relationship_type: 'knows',
          confidence: 0.7,
          mention_count: 1,
          target: { id: 'entity-2', name: 'Bob', entity_type: 'person' },
          source: { id: 'entity-2', name: 'Bob', entity_type: 'person' }
        }],
        error: null
      };

      const rels = await em.getEntityRelationships('entity-1', { direction: 'both' });

      // 1 outgoing + 1 incoming = 2 total
      expect(rels.length).toBe(2);
      const directions = rels.map(r => r.direction);
      expect(directions).toContain('outgoing');
      expect(directions).toContain('incoming');
    });

    it('should return empty array when no relationships', async () => {
      mockListResult = { data: [], error: null };

      const rels = await em.getEntityRelationships('entity-1');

      expect(rels).toHaveLength(0);
    });
  });

  // ============ findRelatedEntities ============

  describe('findRelatedEntities', () => {
    it('should find related entities via RPC graph traversal', async () => {
      mockRpcResult = {
        data: [
          {
            entityId: 'entity-2',
            entityName: 'TechCorp',
            entityType: 'organization',
            relationshipPath: ['works_at'],
            totalConfidence: 0.8,
            depth: 1
          }
        ],
        error: null
      };

      const related = await em.findRelatedEntities('entity-1', { maxDepth: 2 });

      expect(Array.isArray(related)).toBe(true);
      expect(related).toHaveLength(1);
      expect(related[0]).toHaveProperty('depth', 1);
      expect(related[0]).toHaveProperty('entityName', 'TechCorp');
    });

    it('should return empty array when no related entities found', async () => {
      mockRpcResult = { data: [], error: null };

      const related = await em.findRelatedEntities('entity-1');

      expect(related).toHaveLength(0);
    });

    it('should propagate RPC errors', async () => {
      mockRpcResult = { data: null, error: { message: 'RPC function not found' } };

      await expect(em.findRelatedEntities('entity-1')).rejects.toBeTruthy();
    });
  });

  // ============ getEntityNetworkStats ============

  describe('getEntityNetworkStats', () => {
    it('should return network statistics', async () => {
      mockRpcResult = {
        data: [{
          total_entities: 10,
          total_relationships: 25,
          avg_connections_per_entity: 2.5,
          most_connected_entity_id: 'entity-1',
          most_connected_entity_name: 'Alice',
          connection_count: 8
        }],
        error: null
      };

      const stats = await em.getEntityNetworkStats();

      expect(stats).toHaveProperty('totalEntities', 10);
      expect(stats).toHaveProperty('totalRelationships', 25);
      expect(stats).toHaveProperty('avgConnectionsPerEntity', 2.5);
      expect(stats.mostConnectedEntity).toEqual({
        id: 'entity-1',
        name: 'Alice',
        connectionCount: 8
      });
    });

    it('should handle empty network with zero stats', async () => {
      mockRpcResult = { data: [], error: null };

      const stats = await em.getEntityNetworkStats();

      expect(stats.totalEntities).toBe(0);
      expect(stats.totalRelationships).toBe(0);
      expect(stats.mostConnectedEntity).toBeUndefined();
    });

    it('should propagate RPC errors', async () => {
      mockRpcResult = { data: null, error: { message: 'stats function failed' } };

      await expect(em.getEntityNetworkStats()).rejects.toBeTruthy();
    });
  });
});
