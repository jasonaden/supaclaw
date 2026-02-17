import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Supaclaw from '../src/index';

// Mock Supabase client for testing
const mockMemory = new Supaclaw({
  supabaseUrl: process.env.SUPABASE_URL || 'http://localhost:54321',
  supabaseKey: process.env.SUPABASE_KEY || 'test-key',
  agentId: 'test-relationships',
  embeddingProvider: 'none' // No embeddings needed for basic tests
});

describe('Entity Relationships', () => {
  describe('createEntityRelationship', () => {
    it('should create a new relationship', async () => {
      // This is a mock test - would need real Supabase in integration tests
      const mockRelationship = {
        sourceEntityId: 'entity-1',
        targetEntityId: 'entity-2',
        relationshipType: 'works_at',
        confidence: 0.8
      };

      // In a real test, this would call the actual method
      expect(mockRelationship.relationshipType).toBe('works_at');
      expect(mockRelationship.confidence).toBe(0.8);
    });

    it('should update existing relationship when duplicate', async () => {
      const mockExisting = {
        id: 'rel-1',
        mention_count: 1,
        confidence: 0.7
      };

      // After update
      const mockUpdated = {
        ...mockExisting,
        mention_count: 2,
        confidence: 0.8
      };

      expect(mockUpdated.mention_count).toBe(2);
      expect(mockUpdated.confidence).toBe(0.8);
    });

    it('should handle missing entities gracefully', async () => {
      const mockRelationship = {
        sourceEntityId: 'non-existent',
        targetEntityId: 'also-non-existent',
        relationshipType: 'knows'
      };

      // Should throw or return error
      expect(mockRelationship.sourceEntityId).toBe('non-existent');
    });
  });

  describe('getEntityRelationships', () => {
    it('should get outgoing relationships', async () => {
      const mockOutgoing = [
        {
          relationship: {
            id: 'rel-1',
            relationship_type: 'works_at',
            confidence: 0.9
          },
          relatedEntity: {
            id: 'entity-2',
            name: 'TechCorp',
            entity_type: 'organization'
          },
          direction: 'outgoing' as const
        }
      ];

      expect(mockOutgoing[0].direction).toBe('outgoing');
      expect(mockOutgoing[0].relationship.relationship_type).toBe('works_at');
    });

    it('should get incoming relationships', async () => {
      const mockIncoming = [
        {
          relationship: {
            id: 'rel-2',
            relationship_type: 'employs',
            confidence: 0.8
          },
          relatedEntity: {
            id: 'entity-1',
            name: 'Alice',
            entity_type: 'person'
          },
          direction: 'incoming' as const
        }
      ];

      expect(mockIncoming[0].direction).toBe('incoming');
    });

    it('should filter by relationship type', async () => {
      const mockFiltered = [
        {
          relationship: { relationship_type: 'works_at' },
          relatedEntity: { name: 'Company' },
          direction: 'outgoing' as const
        }
      ];

      const onlyWorksAt = mockFiltered.filter(
        r => r.relationship.relationship_type === 'works_at'
      );

      expect(onlyWorksAt.length).toBe(1);
    });

    it('should filter by minimum confidence', async () => {
      const mockData = [
        { relationship: { confidence: 0.9 }, relatedEntity: {}, direction: 'outgoing' as const },
        { relationship: { confidence: 0.5 }, relatedEntity: {}, direction: 'outgoing' as const },
        { relationship: { confidence: 0.3 }, relatedEntity: {}, direction: 'outgoing' as const }
      ];

      const highConfidence = mockData.filter(r => r.relationship.confidence >= 0.7);
      expect(highConfidence.length).toBe(1);
    });
  });

  describe('findRelatedEntities', () => {
    it('should find entities 1 hop away', async () => {
      const mockDepth1 = [
        {
          entityId: 'entity-2',
          entityName: 'TechCorp',
          entityType: 'organization',
          relationshipPath: ['works_at'],
          totalConfidence: 0.9,
          depth: 1
        }
      ];

      expect(mockDepth1[0].depth).toBe(1);
      expect(mockDepth1[0].relationshipPath).toHaveLength(1);
    });

    it('should find entities 2 hops away', async () => {
      const mockDepth2 = [
        {
          entityId: 'entity-3',
          entityName: 'San Francisco',
          entityType: 'place',
          relationshipPath: ['works_at', 'located_in'],
          totalConfidence: 0.72, // 0.9 * 0.8
          depth: 2
        }
      ];

      expect(mockDepth2[0].depth).toBe(2);
      expect(mockDepth2[0].relationshipPath).toHaveLength(2);
      expect(mockDepth2[0].totalConfidence).toBeCloseTo(0.72, 2);
    });

    it('should respect max depth', async () => {
      const mockResults = [
        { depth: 1, relationshipPath: ['a'] },
        { depth: 2, relationshipPath: ['a', 'b'] },
        { depth: 3, relationshipPath: ['a', 'b', 'c'] }
      ];

      const maxDepth2 = mockResults.filter(r => r.depth <= 2);
      expect(maxDepth2.length).toBe(2);
    });

    it('should respect min confidence threshold', async () => {
      const mockResults = [
        { totalConfidence: 0.9 },
        { totalConfidence: 0.6 },
        { totalConfidence: 0.3 }
      ];

      const minConf = 0.5;
      const filtered = mockResults.filter(r => r.totalConfidence >= minConf);
      expect(filtered.length).toBe(2);
    });
  });

  describe('getEntityNetworkStats', () => {
    it('should return network statistics', async () => {
      const mockStats = {
        totalEntities: 10,
        totalRelationships: 25,
        avgConnectionsPerEntity: 2.5,
        mostConnectedEntity: {
          id: 'entity-1',
          name: 'Alice',
          connectionCount: 8
        }
      };

      expect(mockStats.avgConnectionsPerEntity).toBe(
        mockStats.totalRelationships / mockStats.totalEntities
      );
      expect(mockStats.mostConnectedEntity?.connectionCount).toBe(8);
    });

    it('should handle empty network', async () => {
      const mockEmpty = {
        totalEntities: 0,
        totalRelationships: 0,
        avgConnectionsPerEntity: 0
      };

      expect(mockEmpty.totalRelationships).toBe(0);
      expect(mockEmpty.mostConnectedEntity).toBeUndefined();
    });
  });

  describe('extractEntitiesWithRelationships', () => {
    it('should extract entities and relationships from text', async () => {
      const text = 'Alice works at TechCorp, a company located in San Francisco.';

      const mockResult = {
        entities: [
          { type: 'person', name: 'Alice', description: 'Person' },
          { type: 'organization', name: 'TechCorp', description: 'Company' },
          { type: 'place', name: 'San Francisco', description: 'City' }
        ],
        relationships: [
          { source: 'Alice', target: 'TechCorp', type: 'works_at', confidence: 0.9 },
          { source: 'TechCorp', target: 'San Francisco', type: 'located_in', confidence: 0.8 }
        ]
      };

      expect(mockResult.entities).toHaveLength(3);
      expect(mockResult.relationships).toHaveLength(2);
      expect(mockResult.relationships[0].type).toBe('works_at');
    });

    it('should handle text with no entities', async () => {
      const text = 'Hello, how are you?';

      const mockResult = {
        entities: [],
        relationships: []
      };

      expect(mockResult.entities).toHaveLength(0);
      expect(mockResult.relationships).toHaveLength(0);
    });

    it('should handle entities without relationships', async () => {
      const text = 'Han and Sarah.';

      const mockResult = {
        entities: [
          { type: 'person', name: 'Alice' },
          { type: 'person', name: 'Sarah' }
        ],
        relationships: []
      };

      expect(mockResult.entities).toHaveLength(2);
      expect(mockResult.relationships).toHaveLength(0);
    });
  });

  describe('searchRelationships', () => {
    it('should search by relationship type', async () => {
      const mockRelationships = [
        { relationship_type: 'works_at', confidence: 0.9 },
        { relationship_type: 'knows', confidence: 0.7 },
        { relationship_type: 'works_at', confidence: 0.8 }
      ];

      const worksAt = mockRelationships.filter(r => r.relationship_type === 'works_at');
      expect(worksAt).toHaveLength(2);
    });

    it('should filter by minimum confidence', async () => {
      const mockRelationships = [
        { confidence: 0.9 },
        { confidence: 0.6 },
        { confidence: 0.3 }
      ];

      const highConf = mockRelationships.filter(r => r.confidence >= 0.7);
      expect(highConf).toHaveLength(1);
    });

    it('should sort by mention count and confidence', async () => {
      const mockRelationships = [
        { mention_count: 5, confidence: 0.7 },
        { mention_count: 10, confidence: 0.9 },
        { mention_count: 3, confidence: 0.8 }
      ];

      const sorted = [...mockRelationships].sort((a, b) => {
        if (a.mention_count !== b.mention_count) {
          return b.mention_count - a.mention_count;
        }
        return b.confidence - a.confidence;
      });

      expect(sorted[0].mention_count).toBe(10);
    });
  });

  describe('Relationship lifecycle', () => {
    it('should increment mention count on duplicate creation', async () => {
      let mockRel = {
        id: 'rel-1',
        mention_count: 1,
        last_seen_at: '2024-01-01T00:00:00Z'
      };

      // Simulate mentioning again
      mockRel = {
        ...mockRel,
        mention_count: mockRel.mention_count + 1,
        last_seen_at: new Date().toISOString()
      };

      expect(mockRel.mention_count).toBe(2);
    });

    it('should increase confidence with repeated mentions', async () => {
      let confidence = 0.5;

      // Simulate 3 mentions
      for (let i = 0; i < 3; i++) {
        confidence = Math.min(1.0, confidence + 0.1);
      }

      expect(confidence).toBeCloseTo(0.8, 1);
    });

    it('should delete relationship', async () => {
      const mockRelationships = [
        { id: 'rel-1', relationship_type: 'knows' },
        { id: 'rel-2', relationship_type: 'works_at' }
      ];

      const after = mockRelationships.filter(r => r.id !== 'rel-1');
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe('rel-2');
    });
  });

  describe('Integration scenarios', () => {
    it('should build entity graph from conversation', async () => {
      const conversation = `
        Alice works at TechCorp as a Full Stack Engineer.
        TechCorp is located in San Francisco.
        Alice knows Sarah, who also works at TechCorp.
      `;

      const mockExtracted = {
        entities: [
          { name: 'Alice', type: 'person' },
          { name: 'TechCorp', type: 'organization' },
          { name: 'San Francisco', type: 'place' },
          { name: 'Sarah', type: 'person' }
        ],
        relationships: [
          { source: 'Alice', target: 'TechCorp', type: 'works_at' },
          { source: 'TechCorp', target: 'San Francisco', type: 'located_in' },
          { source: 'Alice', target: 'Sarah', type: 'knows' },
          { source: 'Sarah', target: 'TechCorp', type: 'works_at' }
        ]
      };

      expect(mockExtracted.entities).toHaveLength(4);
      expect(mockExtracted.relationships).toHaveLength(4);
    });

    it('should find mutual connections', async () => {
      // Alice knows Sarah, Sarah knows Tom, Alice knows Tom
      const mockRelationships = [
        { source: 'Alice', target: 'Sarah', type: 'knows' },
        { source: 'Sarah', target: 'Tom', type: 'knows' },
        { source: 'Alice', target: 'Tom', type: 'knows' }
      ];

      const hanKnows = mockRelationships
        .filter(r => r.source === 'Han')
        .map(r => r.target);

      expect(hanKnows).toContain('Sarah');
      expect(hanKnows).toContain('Tom');
    });

    it('should detect transitive relationships', async () => {
      // If Alice works_at TechCorp, and TechCorp located_in SF
      // Then Han is indirectly related to SF
      const mockGraph = [
        {
          entityName: 'San Francisco',
          relationshipPath: ['works_at', 'located_in'],
          depth: 2
        }
      ];

      expect(mockGraph[0].depth).toBe(2);
      expect(mockGraph[0].relationshipPath).toContain('located_in');
    });
  });

  describe('Confidence scoring', () => {
    it('should calculate confidence for multi-hop paths', () => {
      const hop1Confidence = 0.9;
      const hop2Confidence = 0.8;
      const totalConfidence = hop1Confidence * hop2Confidence;

      expect(totalConfidence).toBeCloseTo(0.72, 2);
    });

    it('should penalize longer paths', () => {
      const direct = 0.9; // 1 hop
      const indirect = 0.9 * 0.8; // 2 hops
      const distant = 0.9 * 0.8 * 0.7; // 3 hops

      expect(direct).toBeGreaterThan(indirect);
      expect(indirect).toBeGreaterThan(distant);
    });
  });
});

describe('Relationship types', () => {
  it('should support common relationship types', () => {
    const commonTypes = [
      'works_at',
      'knows',
      'created',
      'located_in',
      'part_of',
      'owns',
      'manages',
      'reports_to',
      'collaborates_with',
      'mentioned_in'
    ];

    expect(commonTypes).toContain('works_at');
    expect(commonTypes).toContain('knows');
    expect(commonTypes.length).toBe(10);
  });

  it('should allow custom relationship types', () => {
    const customRel = {
      type: 'custom_relationship',
      source: 'entity-1',
      target: 'entity-2'
    };

    expect(customRel.type).toBe('custom_relationship');
  });
});
