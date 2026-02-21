import { SupabaseClient } from '@supabase/supabase-js';
import {
  ContextBudget,
  ContextWindow,
  createContextBudget,
  createAdaptiveBudget,
  buildContextWindow,
  formatContextWindow,
  getContextStats,
  getBudgetForModel
} from './context-manager';
import type { Memory, Message } from './types';
import type { SessionManager } from './sessions';
import type { MemoryManager } from './memories';
import type { EntityManager } from './entities';
import type { LearningManager } from './learnings';

export class ContextBuilder {
  private supabase: SupabaseClient;
  private sessions: SessionManager;
  private memories: MemoryManager;
  private entities: EntityManager;
  private learnings: LearningManager;

  constructor(
    supabase: SupabaseClient,
    sessions: SessionManager,
    memories: MemoryManager,
    entities: EntityManager,
    learnings: LearningManager
  ) {
    this.supabase = supabase;
    this.sessions = sessions;
    this.memories = memories;
    this.entities = entities;
    this.learnings = learnings;
  }

  /**
   * Get relevant context for a query
   * Combines memories, recent messages, and entities
   */
  async getContext(query: string, opts: {
    userId?: string;
    sessionId?: string;
    maxMemories?: number;
    maxMessages?: number;
  } = {}): Promise<{
    memories: Memory[];
    recentMessages: Message[];
    summary: string;
  }> {
    // Get relevant memories
    const memoriesResult = await this.memories.recall(query, {
      userId: opts.userId,
      limit: opts.maxMemories || 5
    });

    // Get recent messages from current session
    let recentMessages: Message[] = [];
    if (opts.sessionId) {
      recentMessages = await this.sessions.getMessages(opts.sessionId, {
        limit: opts.maxMessages || 20
      });
    }

    // Build context summary
    const memoryText = memoriesResult
      .map(m => `- ${m.content}`)
      .join('\n');

    const summary = memoriesResult.length > 0
      ? `Relevant memories:\n${memoryText}`
      : 'No relevant memories found.';

    return { memories: memoriesResult, recentMessages, summary };
  }

  /**
   * Build an optimized context window with token budgeting
   * Implements smart context selection and lost-in-middle mitigation
   */
  async buildOptimizedContext(opts: {
    query: string;
    sessionId?: string;
    userId?: string;
    modelContextSize?: number;
    model?: string;
    useLostInMiddleFix?: boolean;
    recencyWeight?: number;
    importanceWeight?: number;
    customBudget?: ContextBudget;
  }): Promise<{
    window: ContextWindow;
    formatted: string;
    stats: ReturnType<typeof getContextStats>;
  }> {
    const {
      query,
      sessionId,
      userId,
      modelContextSize,
      model,
      useLostInMiddleFix = true,
      recencyWeight,
      importanceWeight,
      customBudget
    } = opts;

    // Fetch relevant data
    const [messages, memoriesResult, learningsResult, entitiesResult] = await Promise.all([
      sessionId ? this.sessions.getMessages(sessionId) : Promise.resolve([]),
      this.memories.recall(query, { userId, limit: 50 }),
      this.learnings.searchLearnings(query, { limit: 20 }),
      this.entities.searchEntities({ query, limit: 15 })
    ]);

    // Determine budget
    let budget: ContextBudget;
    if (customBudget) {
      budget = customBudget;
    } else if (model) {
      budget = getBudgetForModel(model);
    } else if (modelContextSize) {
      budget = createContextBudget({ modelContextSize });
    } else {
      // Adaptive budget based on available content
      budget = createAdaptiveBudget({
        messageCount: messages.length,
        memoryCount: memoriesResult.length,
        learningCount: learningsResult.length,
        entityCount: entitiesResult.length
      });
    }

    // Build context window
    const window = buildContextWindow({
      messages,
      memories: memoriesResult,
      learnings: learningsResult,
      entities: entitiesResult,
      budget,
      useLostInMiddleFix,
      recencyWeight,
      importanceWeight
    });

    // Format for prompt
    const formatted = formatContextWindow(window, {
      groupByType: true,
      includeMetadata: false
    });

    // Get stats
    const stats = getContextStats(window);

    return { window, formatted, stats };
  }

  /**
   * Get smart context with automatic budget management
   * Simplified version of buildOptimizedContext for common use cases
   */
  async getSmartContext(query: string, opts: {
    sessionId?: string;
    userId?: string;
    model?: string;
  } = {}): Promise<string> {
    const result = await this.buildOptimizedContext({
      query,
      sessionId: opts.sessionId,
      userId: opts.userId,
      model: opts.model || 'default'
    });

    return result.formatted;
  }

  /**
   * Estimate token usage for a session
   */
  async estimateSessionTokenUsage(sessionId: string): Promise<{
    messages: number;
    memories: number;
    total: number;
    contextSize: string;
  }> {
    const stats = await this.sessions.countSessionTokens(sessionId);

    // Get memories from this session
    const { data, error } = await this.supabase
      .from('memories')
      .select()
      .eq('source_session_id', sessionId);

    if (error) throw error;

    const memoryTokens = (data || []).reduce((sum: number, mem: { content: string }) => {
      return sum + (mem.content.length / 4); // Rough estimate
    }, 0);

    const total = stats.totalTokens + memoryTokens;

    // Determine context size needed
    let contextSize = '4k';
    if (total > 4000) contextSize = '8k';
    if (total > 8000) contextSize = '16k';
    if (total > 16000) contextSize = '32k';
    if (total > 32000) contextSize = '64k';
    if (total > 64000) contextSize = '128k';
    if (total > 128000) contextSize = '200k';

    return {
      messages: stats.totalTokens,
      memories: Math.round(memoryTokens),
      total: Math.round(total),
      contextSize
    };
  }

  /**
   * Test context window with different budgets
   * Useful for optimization and debugging
   */
  async testContextBudgets(query: string, opts: {
    sessionId?: string;
    userId?: string;
    models?: string[];
  } = {}): Promise<Array<{
    model: string;
    budget: ContextBudget;
    stats: ReturnType<typeof getContextStats>;
  }>> {
    const models = opts.models || ['gpt-3.5-turbo', 'gpt-4-turbo', 'claude-3.5-sonnet'];
    const results = [];

    for (const model of models) {
      const { window, stats } = await this.buildOptimizedContext({
        query,
        sessionId: opts.sessionId,
        userId: opts.userId,
        model
      });

      results.push({
        model,
        budget: window.budget,
        stats
      });
    }

    return results;
  }
}
