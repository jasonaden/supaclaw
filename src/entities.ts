import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { sanitizeFilterInput } from './utils';
import { wrapDatabaseOperation, wrapEmbeddingOperation } from './error-handling';
import type { SupaclawDeps, SupaclawConfig, Entity, EntityRelationship } from './types';

export class EntityManager {
  private supabase: SupabaseClient;
  private agentId: string;
  private config: SupaclawConfig;
  private openai?: OpenAI;

  constructor(deps: SupaclawDeps) {
    this.supabase = deps.supabase;
    this.agentId = deps.agentId;
    this.config = deps.config;
    this.openai = deps.openai;
  }

  /**
   * Generate embedding for text using configured provider
   */
  private async generateEmbedding(text: string): Promise<number[] | null> {
    if (!this.config.embeddingProvider || this.config.embeddingProvider === 'none') {
      return null;
    }

    if (this.config.embeddingProvider === 'openai') {
      if (!this.openai) {
        throw new Error('OpenAI API key not provided');
      }

      const model = this.config.embeddingModel || 'text-embedding-3-small';
      return wrapEmbeddingOperation(async () => {
        const response = await this.openai!.embeddings.create({
          model,
          input: text,
        });

        return response.data[0]!.embedding;
      }, 'generateEmbedding (entities)');
    }

    // TODO: Add Voyage AI support
    if (this.config.embeddingProvider === 'voyage') {
      throw new Error('Voyage AI embeddings not yet implemented');
    }

    return null;
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) return 0;

    return dotProduct / magnitude;
  }

  /**
   * Extract entities from text using AI
   */
  async extractEntities(text: string, _opts: {
    sessionId?: string;
  } = {}): Promise<Entity[]> {
    if (!this.openai) {
      throw new Error('OpenAI client required for entity extraction');
    }

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract named entities from the text. Return JSON array of entities.
Each entity should have: type (person|place|organization|product|concept), name, description.
Focus on important entities that should be remembered.
Format: {"entities": [{"type": "...", "name": "...", "description": "..."}]}`
        },
        {
          role: 'user',
          content: text
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{"entities":[]}');
    const extractedEntities = result.entities || [];

    const entities: Entity[] = [];
    for (const e of extractedEntities) {
      // Check if entity already exists (by name, case-insensitive)
      const existing = await this.findEntity(e.name);

      if (existing) {
        // Update existing entity
        const updated = await this.updateEntity(existing.id, {
          description: e.description,
          lastSeenAt: new Date().toISOString()
        });
        entities.push(updated);
      } else {
        // Create new entity
        const entity = await this.createEntity({
          entityType: e.type,
          name: e.name,
          description: e.description
        });
        entities.push(entity);
      }
    }

    return entities;
  }

  /**
   * Create an entity
   */
  async createEntity(entity: {
    entityType: string;
    name: string;
    aliases?: string[];
    description?: string;
    properties?: Record<string, unknown>;
  }): Promise<Entity> {
    return wrapDatabaseOperation(async () => {
      const { data, error } = await this.supabase
        .from('entities')
        .insert({
          agent_id: this.agentId,
          entity_type: entity.entityType,
          name: entity.name,
          aliases: entity.aliases || [],
          description: entity.description,
          properties: entity.properties || {},
          first_seen_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          mention_count: 1
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    }, 'createEntity');
  }

  /**
   * Update an entity
   */
  async updateEntity(entityId: string, updates: Partial<{
    name: string;
    aliases: string[];
    description: string;
    properties: Record<string, unknown>;
    lastSeenAt: string;
  }>): Promise<Entity> {
    return wrapDatabaseOperation(async () => {
      const updateData: Record<string, unknown> = {};

      if (updates.name !== undefined) updateData['name'] = updates.name;
      if (updates.aliases !== undefined) updateData['aliases'] = updates.aliases;
      if (updates.description !== undefined) updateData['description'] = updates.description;
      if (updates.properties !== undefined) updateData['properties'] = updates.properties;
      if (updates.lastSeenAt !== undefined) updateData['last_seen_at'] = updates.lastSeenAt;

      // Increment mention count
      const entity = await this.supabase
        .from('entities')
        .select()
        .eq('id', entityId)
        .single();

      if (entity.error) throw entity.error;

      updateData['mention_count'] = (entity.data.mention_count || 0) + 1;

      const { data, error } = await this.supabase
        .from('entities')
        .update(updateData)
        .eq('id', entityId)
        .select()
        .single();

      if (error) throw error;
      return data;
    }, 'updateEntity');
  }

  /**
   * Find an entity by name or alias
   */
  async findEntity(nameOrAlias: string): Promise<Entity | null> {
    const { data, error } = await this.supabase
      .from('entities')
      .select()
      .eq('agent_id', this.agentId)
      .or(`name.ilike.${sanitizeFilterInput(nameOrAlias)},aliases.cs.{${sanitizeFilterInput(nameOrAlias)}}`)
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  /**
   * Search entities
   */
  async searchEntities(opts: {
    query?: string;
    entityType?: string;
    limit?: number;
  } = {}): Promise<Entity[]> {
    return wrapDatabaseOperation(async () => {
      let query = this.supabase
        .from('entities')
        .select()
        .eq('agent_id', this.agentId)
        .order('mention_count', { ascending: false })
        .order('last_seen_at', { ascending: false })
        .limit(opts.limit || 20);

      if (opts.entityType) {
        query = query.eq('entity_type', opts.entityType);
      }

      if (opts.query) {
        query = query.or(`name.ilike.%${sanitizeFilterInput(opts.query)}%,description.ilike.%${sanitizeFilterInput(opts.query)}%`);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    }, 'searchEntities');
  }

  /**
   * Merge two entities (deduplication)
   */
  async mergeEntities(primaryId: string, duplicateId: string): Promise<Entity> {
    // Get both entities
    const [primary, duplicate] = await Promise.all([
      this.supabase.from('entities').select().eq('id', primaryId).single(),
      this.supabase.from('entities').select().eq('id', duplicateId).single()
    ]);

    if (primary.error) throw primary.error;
    if (duplicate.error) throw duplicate.error;

    // Merge aliases
    const mergedAliases = [
      ...(primary.data.aliases || []),
      duplicate.data.name,
      ...(duplicate.data.aliases || [])
    ].filter((v: string, i: number, a: string[]) => a.indexOf(v) === i); // Deduplicate

    // Merge properties
    const mergedProperties = {
      ...duplicate.data.properties,
      ...primary.data.properties
    };

    // Update primary entity
    const { data, error } = await this.supabase
      .from('entities')
      .update({
        aliases: mergedAliases,
        properties: mergedProperties,
        mention_count: primary.data.mention_count + duplicate.data.mention_count,
        first_seen_at: new Date(
          Math.min(
            new Date(primary.data.first_seen_at).getTime(),
            new Date(duplicate.data.first_seen_at).getTime()
          )
        ).toISOString(),
        last_seen_at: new Date(
          Math.max(
            new Date(primary.data.last_seen_at).getTime(),
            new Date(duplicate.data.last_seen_at).getTime()
          )
        ).toISOString()
      })
      .eq('id', primaryId)
      .select()
      .single();

    if (error) throw error;

    // Delete duplicate
    await this.supabase.from('entities').delete().eq('id', duplicateId);

    return data;
  }

  /**
   * Create or update a relationship between entities
   */
  async createEntityRelationship(rel: {
    sourceEntityId: string;
    targetEntityId: string;
    relationshipType: string;
    properties?: Record<string, unknown>;
    confidence?: number;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<EntityRelationship> {
    // Check if relationship already exists
    const { data: existing, error: checkError } = await this.supabase
      .from('entity_relationships')
      .select()
      .eq('agent_id', this.agentId)
      .eq('source_entity_id', rel.sourceEntityId)
      .eq('target_entity_id', rel.targetEntityId)
      .eq('relationship_type', rel.relationshipType)
      .single();

    if (existing && !checkError) {
      // Update existing relationship
      const { data, error } = await this.supabase.rpc('increment_relationship_mentions', {
        rel_id: existing.id
      });

      if (error) {
        // Fallback if RPC doesn't exist
        const updated = await this.supabase
          .from('entity_relationships')
          .update({
            mention_count: existing.mention_count + 1,
            last_seen_at: new Date().toISOString(),
            confidence: Math.min(1.0, existing.confidence + 0.1), // Increase confidence with mentions
            properties: { ...existing.properties, ...rel.properties }
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (updated.error) throw updated.error;
        return updated.data;
      }

      return data;
    }

    // Create new relationship
    const { data, error } = await this.supabase
      .from('entity_relationships')
      .insert({
        agent_id: this.agentId,
        source_entity_id: rel.sourceEntityId,
        target_entity_id: rel.targetEntityId,
        relationship_type: rel.relationshipType,
        properties: rel.properties || {},
        confidence: rel.confidence ?? 0.5,
        source_session_id: rel.sessionId,
        metadata: rel.metadata || {}
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Get relationships for an entity
   */
  async getEntityRelationships(entityId: string, opts: {
    direction?: 'outgoing' | 'incoming' | 'both';
    relationshipType?: string;
    minConfidence?: number;
    limit?: number;
  } = {}): Promise<Array<{
    relationship: EntityRelationship;
    relatedEntity: Entity;
    direction: 'outgoing' | 'incoming';
  }>> {
    const direction = opts.direction || 'both';
    const minConfidence = opts.minConfidence ?? 0.3;
    const limit = opts.limit || 50;

    const results: Array<{
      relationship: EntityRelationship;
      relatedEntity: Entity;
      direction: 'outgoing' | 'incoming';
    }> = [];

    // Get outgoing relationships
    if (direction === 'outgoing' || direction === 'both') {
      let query = this.supabase
        .from('entity_relationships')
        .select('*, target:entities!target_entity_id(*)')
        .eq('source_entity_id', entityId)
        .gte('confidence', minConfidence)
        .order('mention_count', { ascending: false })
        .limit(limit);

      if (opts.relationshipType) {
        query = query.eq('relationship_type', opts.relationshipType);
      }

      const { data, error } = await query;
      if (error) throw error;

      if (data) {
        for (const row of data) {
          const { target, ...relationship } = row;
          results.push({
            relationship: relationship as EntityRelationship,
            relatedEntity: target as Entity,
            direction: 'outgoing'
          });
        }
      }
    }

    // Get incoming relationships
    if (direction === 'incoming' || direction === 'both') {
      let query = this.supabase
        .from('entity_relationships')
        .select('*, source:entities!source_entity_id(*)')
        .eq('target_entity_id', entityId)
        .gte('confidence', minConfidence)
        .order('mention_count', { ascending: false })
        .limit(limit);

      if (opts.relationshipType) {
        query = query.eq('relationship_type', opts.relationshipType);
      }

      const { data, error } = await query;
      if (error) throw error;

      if (data) {
        for (const row of data) {
          const { source, ...relationship } = row;
          results.push({
            relationship: relationship as EntityRelationship,
            relatedEntity: source as Entity,
            direction: 'incoming'
          });
        }
      }
    }

    return results;
  }

  /**
   * Find related entities through graph traversal
   */
  async findRelatedEntities(entityId: string, opts: {
    maxDepth?: number;
    minConfidence?: number;
  } = {}): Promise<Array<{
    entityId: string;
    entityName: string;
    entityType: string;
    relationshipPath: string[];
    totalConfidence: number;
    depth: number;
  }>> {
    const { data, error } = await this.supabase.rpc('find_related_entities', {
      entity_id: entityId,
      max_depth: opts.maxDepth || 2,
      min_confidence: opts.minConfidence ?? 0.5
    });

    if (error) throw error;
    return data || [];
  }

  /**
   * Get entity network statistics
   */
  async getEntityNetworkStats(): Promise<{
    totalEntities: number;
    totalRelationships: number;
    avgConnectionsPerEntity: number;
    mostConnectedEntity?: {
      id: string;
      name: string;
      connectionCount: number;
    };
  }> {
    const { data, error } = await this.supabase.rpc('get_entity_network_stats', {
      agent: this.agentId
    });

    if (error) throw error;

    const stats = data?.[0];
    if (!stats) {
      return {
        totalEntities: 0,
        totalRelationships: 0,
        avgConnectionsPerEntity: 0
      };
    }

    return {
      totalEntities: Number(stats.total_entities),
      totalRelationships: Number(stats.total_relationships),
      avgConnectionsPerEntity: Number(stats.avg_connections_per_entity) || 0,
      mostConnectedEntity: stats.most_connected_entity_id ? {
        id: stats.most_connected_entity_id,
        name: stats.most_connected_entity_name,
        connectionCount: Number(stats.connection_count)
      } : undefined
    };
  }

  /**
   * Extract entities and relationships from text using AI
   */
  async extractEntitiesWithRelationships(text: string, opts: {
    sessionId?: string;
  } = {}): Promise<{
    entities: Entity[];
    relationships: EntityRelationship[];
  }> {
    if (!this.openai) {
      throw new Error('OpenAI client required for entity extraction');
    }

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Extract named entities and their relationships from the text.

Return JSON with this structure:
{
  "entities": [
    {"type": "person|place|organization|product|concept", "name": "...", "description": "..."}
  ],
  "relationships": [
    {"source": "entity name", "target": "entity name", "type": "works_at|knows|created|located_in|etc", "confidence": 0.0-1.0}
  ]
}

Focus on important entities and clear relationships. Use standard relationship types when possible.`
        },
        {
          role: 'user',
          content: text
        }
      ],
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0]?.message?.content || '{"entities":[],"relationships":[]}');
    const extractedEntities = result.entities || [];
    const extractedRelationships = result.relationships || [];

    // First, create/update all entities
    const entityMap = new Map<string, Entity>();
    for (const e of extractedEntities) {
      const existing = await this.findEntity(e.name);
      let entity: Entity;

      if (existing) {
        entity = await this.updateEntity(existing.id, {
          description: e.description,
          lastSeenAt: new Date().toISOString()
        });
      } else {
        entity = await this.createEntity({
          entityType: e.type,
          name: e.name,
          description: e.description
        });
      }

      entityMap.set(e.name.toLowerCase(), entity);
    }

    // Then, create relationships
    const relationships: EntityRelationship[] = [];
    for (const r of extractedRelationships) {
      const sourceEntity = entityMap.get(r.source.toLowerCase());
      const targetEntity = entityMap.get(r.target.toLowerCase());

      if (sourceEntity && targetEntity) {
        const relationship = await this.createEntityRelationship({
          sourceEntityId: sourceEntity.id,
          targetEntityId: targetEntity.id,
          relationshipType: r.type,
          confidence: r.confidence || 0.7,
          sessionId: opts.sessionId
        });
        relationships.push(relationship);
      }
    }

    return {
      entities: Array.from(entityMap.values()),
      relationships
    };
  }

  /**
   * Delete a relationship
   */
  async deleteEntityRelationship(relationshipId: string): Promise<void> {
    const { error } = await this.supabase
      .from('entity_relationships')
      .delete()
      .eq('id', relationshipId);

    if (error) throw error;
  }

  /**
   * Search relationships
   */
  async searchRelationships(opts: {
    relationshipType?: string;
    minConfidence?: number;
    limit?: number;
  } = {}): Promise<EntityRelationship[]> {
    let query = this.supabase
      .from('entity_relationships')
      .select()
      .eq('agent_id', this.agentId)
      .order('mention_count', { ascending: false })
      .order('confidence', { ascending: false })
      .limit(opts.limit || 50);

    if (opts.relationshipType) {
      query = query.eq('relationship_type', opts.relationshipType);
    }
    if (opts.minConfidence) {
      query = query.gte('confidence', opts.minConfidence);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }
}
