import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { sanitizeFilterInput } from './utils';
import { wrapDatabaseOperation, wrapEmbeddingOperation, validateInput } from './error-handling';
import type { SupaclawDeps, SupaclawConfig, Memory } from './types';

export class MemoryManager {
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
      }, 'generateEmbedding (memories)');
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
   * Store a long-term memory with semantic embedding
   */
  async remember(memory: {
    content: string;
    category?: string;
    importance?: number;
    userId?: string;
    sessionId?: string;
    expiresAt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Memory> {
    validateInput(
      !!memory.content && memory.content.trim().length > 0,
      'Memory content must be a non-empty string'
    );

    // Generate embedding if provider configured
    const embedding = await this.generateEmbedding(memory.content);

    return wrapDatabaseOperation(async () => {
      const { data, error } = await this.supabase
        .from('memories')
        .insert({
          agent_id: this.agentId,
          user_id: memory.userId,
          category: memory.category,
          content: memory.content,
          importance: memory.importance ?? 0.5,
          source_session_id: memory.sessionId,
          expires_at: memory.expiresAt,
          embedding,
          metadata: memory.metadata || {}
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    }, 'remember');
  }

  /**
   * Search memories using vector similarity (semantic search)
   */
  async recall(query: string, opts: {
    userId?: string;
    category?: string;
    limit?: number;
    minImportance?: number;
    minSimilarity?: number; // Cosine similarity threshold (0-1)
  } = {}): Promise<Memory[]> {
    validateInput(
      !!query && query.trim().length > 0,
      'Recall query must be a non-empty string'
    );

    // Generate query embedding for semantic search
    const queryEmbedding = await this.generateEmbedding(query);

    if (queryEmbedding) {
      // Use pgvector for semantic search
      return wrapDatabaseOperation(async () => {
        const { data, error } = await this.supabase.rpc('match_memories', {
          query_embedding: queryEmbedding,
          match_threshold: opts.minSimilarity ?? 0.7,
          match_count: opts.limit || 10,
          p_agent_id: this.agentId,
          p_user_id: opts.userId,
          p_category: opts.category,
          p_min_importance: opts.minImportance
        });

        if (error) throw error;
        return data || [];
      }, 'recall (semantic search)');
    }

    // Fallback to text search when no embeddings available
    return wrapDatabaseOperation(async () => {
      let q = this.supabase
        .from('memories')
        .select()
        .eq('agent_id', this.agentId)
        .order('importance', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(opts.limit || 10);

      if (opts.userId) {
        q = q.or(`user_id.eq.${sanitizeFilterInput(opts.userId)},user_id.is.null`);
      }
      if (opts.category) {
        q = q.eq('category', opts.category);
      }
      if (opts.minImportance) {
        q = q.gte('importance', opts.minImportance);
      }

      // Text search filter
      q = q.ilike('content', `%${sanitizeFilterInput(query)}%`);

      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    }, 'recall (text search)');
  }

  /**
   * Hybrid search: combines semantic similarity and keyword matching
   * Returns deduplicated results sorted by relevance score
   */
  async hybridRecall(query: string, opts: {
    userId?: string;
    category?: string;
    limit?: number;
    minImportance?: number;
    vectorWeight?: number; // Weight for semantic similarity (0-1), default 0.7
    keywordWeight?: number; // Weight for keyword match (0-1), default 0.3
  } = {}): Promise<Memory[]> {
    const vectorWeight = opts.vectorWeight ?? 0.7;
    const keywordWeight = opts.keywordWeight ?? 0.3;

    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);

    if (queryEmbedding) {
      // Use hybrid search RPC function
      const { data, error } = await this.supabase.rpc('hybrid_search_memories', {
        query_embedding: queryEmbedding,
        query_text: query,
        vector_weight: vectorWeight,
        keyword_weight: keywordWeight,
        match_count: opts.limit || 10,
        p_agent_id: this.agentId,
        p_user_id: opts.userId,
        p_category: opts.category,
        p_min_importance: opts.minImportance
      });

      if (error) throw error;
      return data || [];
    }

    // Fallback to regular recall if no embeddings
    return this.recall(query, opts);
  }

  /**
   * Delete a memory
   */
  async forget(memoryId: string): Promise<void> {
    return wrapDatabaseOperation(async () => {
      const { error } = await this.supabase
        .from('memories')
        .delete()
        .eq('id', memoryId);

      if (error) throw error;
    }, 'forget');
  }

  /**
   * Get all memories (paginated)
   */
  async getMemories(opts: {
    userId?: string;
    category?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Memory[]> {
    return wrapDatabaseOperation(async () => {
      let query = this.supabase
        .from('memories')
        .select()
        .eq('agent_id', this.agentId)
        .order('created_at', { ascending: false })
        .range(opts.offset || 0, (opts.offset || 0) + (opts.limit || 50) - 1);

      if (opts.userId) {
        query = query.eq('user_id', opts.userId);
      }
      if (opts.category) {
        query = query.eq('category', opts.category);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    }, 'getMemories');
  }

  /**
   * Find memories similar to an existing memory
   * Useful for context expansion and deduplication
   */
  async findSimilarMemories(memoryId: string, opts: {
    minSimilarity?: number;
    limit?: number;
  } = {}): Promise<Memory[]> {
    const { data, error } = await this.supabase.rpc('find_similar_memories', {
      memory_id: memoryId,
      match_threshold: opts.minSimilarity ?? 0.8,
      match_count: opts.limit || 5
    });

    if (error) throw error;
    return data || [];
  }

  /**
   * Apply importance decay to memories
   * Reduces importance over time to prevent old memories from dominating
   */
  async decayMemoryImportance(opts: {
    userId?: string;
    decayRate?: number; // 0-1, default 0.1 (10% decay)
    minImportance?: number; // Don't decay below this
    olderThanDays?: number; // Only decay memories older than X days
  } = {}): Promise<{ updated: number; avgDecay: number }> {
    const decayRate = opts.decayRate ?? 0.1;
    const minImportance = opts.minImportance ?? 0.1;
    const olderThanDays = opts.olderThanDays ?? 7;

    // Get memories to decay
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    let query = this.supabase
      .from('memories')
      .select()
      .eq('agent_id', this.agentId)
      .lt('updated_at', cutoffDate.toISOString())
      .gt('importance', minImportance);

    if (opts.userId) {
      query = query.eq('user_id', opts.userId);
    }

    const { data: memories, error } = await query;
    if (error) throw error;

    if (!memories || memories.length === 0) {
      return { updated: 0, avgDecay: 0 };
    }

    // Apply decay
    let totalDecay = 0;
    const updates = memories.map(mem => {
      const newImportance = Math.max(minImportance, mem.importance * (1 - decayRate));
      totalDecay += (mem.importance - newImportance);
      return {
        id: mem.id,
        importance: newImportance,
        metadata: {
          ...mem.metadata,
          last_decay: new Date().toISOString(),
          decay_count: (mem.metadata?.decay_count as number || 0) + 1
        }
      };
    });

    // Batch update
    for (const update of updates) {
      await this.supabase
        .from('memories')
        .update({
          importance: update.importance,
          metadata: update.metadata,
          updated_at: new Date().toISOString()
        })
        .eq('id', update.id);
    }

    return {
      updated: memories.length,
      avgDecay: totalDecay / memories.length
    };
  }

  /**
   * Consolidate similar memories
   * Merge duplicate/similar memories to reduce clutter
   */
  async consolidateMemories(opts: {
    userId?: string;
    similarityThreshold?: number; // 0-1, default 0.9
    category?: string;
    limit?: number; // Max pairs to check
  } = {}): Promise<{ merged: number; kept: number }> {
    const threshold = opts.similarityThreshold ?? 0.9;
    const limit = opts.limit ?? 100;

    // Get memories with embeddings
    let query = this.supabase
      .from('memories')
      .select()
      .eq('agent_id', this.agentId)
      .not('embedding', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (opts.userId) {
      query = query.eq('user_id', opts.userId);
    }
    if (opts.category) {
      query = query.eq('category', opts.category);
    }

    const { data: memories, error } = await query;
    if (error) throw error;

    if (!memories || memories.length < 2) {
      return { merged: 0, kept: memories?.length || 0 };
    }

    // Find similar pairs
    const toMerge: Array<{ keep: Memory; merge: Memory; similarity: number }> = [];

    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const similarity = this.cosineSimilarity(
          memories[i]!.embedding!,
          memories[j]!.embedding!
        );

        if (similarity >= threshold) {
          // Keep the more important/recent one
          const [keep, merge] = memories[i]!.importance >= memories[j]!.importance
            ? [memories[i]!, memories[j]!]
            : [memories[j]!, memories[i]!];

          toMerge.push({ keep, merge, similarity });
        }
      }
    }

    // Merge memories
    let mergedCount = 0;
    for (const { keep, merge, similarity } of toMerge) {
      // Combine content
      const combinedContent = `${keep.content}\n\n[Merged similar memory (similarity: ${similarity.toFixed(2)})]:\n${merge.content}`;

      // Update importance (weighted average)
      const combinedImportance = (keep.importance + merge.importance) / 2;

      // Update metadata
      const combinedMetadata = {
        ...keep.metadata,
        merged_from: [
          ...((keep.metadata?.['merged_from'] as string[]) || []),
          merge.id
        ],
        merge_count: ((keep.metadata?.['merge_count'] as number) || 0) + 1,
        last_merged: new Date().toISOString()
      };

      // Update keep
      await this.supabase
        .from('memories')
        .update({
          content: combinedContent,
          importance: combinedImportance,
          metadata: combinedMetadata,
          updated_at: new Date().toISOString()
        })
        .eq('id', keep.id);

      // Delete merge
      await this.supabase
        .from('memories')
        .delete()
        .eq('id', merge.id);

      mergedCount++;
    }

    return {
      merged: mergedCount,
      kept: memories.length - mergedCount
    };
  }

  /**
   * Version a memory (create historical snapshot)
   */
  async versionMemory(memoryId: string): Promise<{
    memory: Memory;
    versionId: string;
  }> {
    // Get current memory
    const { data: memory, error } = await this.supabase
      .from('memories')
      .select()
      .eq('id', memoryId)
      .single();

    if (error) throw error;

    // Store version in metadata
    const versions = memory.metadata?.versions as Array<{
      timestamp: string;
      content: string;
      importance: number;
    }> || [];

    versions.push({
      timestamp: new Date().toISOString(),
      content: memory.content,
      importance: memory.importance
    });

    const versionId = `v${versions.length}`;

    // Update metadata
    await this.supabase
      .from('memories')
      .update({
        metadata: {
          ...memory.metadata,
          versions,
          current_version: versionId
        }
      })
      .eq('id', memoryId);

    return { memory, versionId };
  }

  /**
   * Get memory version history
   */
  async getMemoryVersions(memoryId: string): Promise<Array<{
    version: string;
    timestamp: string;
    content: string;
    importance: number;
  }>> {
    const { data: memory, error } = await this.supabase
      .from('memories')
      .select()
      .eq('id', memoryId)
      .single();

    if (error) throw error;

    const versions = memory.metadata?.versions as Array<{
      timestamp: string;
      content: string;
      importance: number;
    }> || [];

    return versions.map((v, i) => ({
      version: `v${i + 1}`,
      ...v
    }));
  }

  /**
   * Tag memories for organization
   */
  async tagMemory(memoryId: string, tags: string[]): Promise<Memory> {
    const { data: memory, error: fetchError } = await this.supabase
      .from('memories')
      .select()
      .eq('id', memoryId)
      .single();

    if (fetchError) throw fetchError;

    const existingTags = memory.metadata?.tags as string[] || [];
    const newTags = Array.from(new Set([...existingTags, ...tags]));

    const { data, error } = await this.supabase
      .from('memories')
      .update({
        metadata: {
          ...memory.metadata,
          tags: newTags
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', memoryId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Remove tags from memory
   */
  async untagMemory(memoryId: string, tags: string[]): Promise<Memory> {
    const { data: memory, error: fetchError } = await this.supabase
      .from('memories')
      .select()
      .eq('id', memoryId)
      .single();

    if (fetchError) throw fetchError;

    const existingTags = memory.metadata?.tags as string[] || [];
    const newTags = existingTags.filter(t => !tags.includes(t));

    const { data, error } = await this.supabase
      .from('memories')
      .update({
        metadata: {
          ...memory.metadata,
          tags: newTags
        },
        updated_at: new Date().toISOString()
      })
      .eq('id', memoryId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Search memories by tags
   */
  async searchMemoriesByTags(tags: string[], opts: {
    userId?: string;
    matchAll?: boolean; // If true, must match ALL tags; if false, match ANY
    limit?: number;
  } = {}): Promise<Memory[]> {
    let query = this.supabase
      .from('memories')
      .select()
      .eq('agent_id', this.agentId);

    if (opts.userId) {
      query = query.eq('user_id', opts.userId);
    }

    const { data, error } = await query;
    if (error) throw error;

    // Filter by tags
    const filtered = (data || []).filter(mem => {
      const memTags = mem.metadata?.tags as string[] || [];
      if (opts.matchAll) {
        return tags.every(tag => memTags.includes(tag));
      } else {
        return tags.some(tag => memTags.includes(tag));
      }
    });

    return filtered.slice(0, opts.limit || 50);
  }
}
