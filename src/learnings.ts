import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { sanitizeFilterInput } from './utils';
import { wrapDatabaseOperation } from './error-handling';
import { generateEmbedding, cosineSimilarity } from './embeddings';
import type { SupaclawDeps, SupaclawConfig, Learning } from './types';

export class LearningManager {
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
   * Record a learning
   */
  async learn(learning: {
    category: 'error' | 'correction' | 'improvement' | 'capability_gap';
    trigger: string;
    lesson: string;
    action?: string;
    severity?: 'info' | 'warning' | 'critical';
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Learning> {
    return wrapDatabaseOperation(async () => {
      const { data, error } = await this.supabase
        .from('learnings')
        .insert({
          agent_id: this.agentId,
          category: learning.category,
          trigger: learning.trigger,
          lesson: learning.lesson,
          action: learning.action,
          severity: learning.severity ?? 'info',
          source_session_id: learning.sessionId,
          metadata: learning.metadata || {}
        })
        .select()
        .single();

      if (error) throw error;
      return data;
    }, 'learn');
  }

  /**
   * Get learnings
   */
  async getLearnings(opts: {
    category?: string;
    severity?: string;
    limit?: number;
  } = {}): Promise<Learning[]> {
    return wrapDatabaseOperation(async () => {
      let query = this.supabase
        .from('learnings')
        .select()
        .eq('agent_id', this.agentId)
        .order('created_at', { ascending: false })
        .limit(opts.limit || 50);

      if (opts.category) {
        query = query.eq('category', opts.category);
      }
      if (opts.severity) {
        query = query.eq('severity', opts.severity);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    }, 'getLearnings');
  }

  /**
   * Search learnings by topic for context
   */
  async searchLearnings(query: string, opts: {
    limit?: number;
  } = {}): Promise<Learning[]> {
    return wrapDatabaseOperation(async () => {
      const { data, error } = await this.supabase
        .from('learnings')
        .select()
        .eq('agent_id', this.agentId)
        .or(`trigger.ilike.%${sanitizeFilterInput(query)}%,lesson.ilike.%${sanitizeFilterInput(query)}%,action.ilike.%${sanitizeFilterInput(query)}%`)
        .order('created_at', { ascending: false })
        .limit(opts.limit || 10);

      if (error) throw error;
      return data || [];
    }, 'searchLearnings');
  }

  /**
   * Mark a learning as applied (increments applied_count)
   */
  async applyLearning(learningId: string): Promise<Learning> {
    const { data, error } = await this.supabase.rpc('increment_learning_applied', {
      learning_id: learningId
    });

    if (error) {
      // Fallback if RPC doesn't exist
      const learning = await this.supabase
        .from('learnings')
        .select()
        .eq('id', learningId)
        .single();

      if (learning.error) throw learning.error;

      const updated = await this.supabase
        .from('learnings')
        .update({ applied_count: (learning.data.applied_count || 0) + 1 })
        .eq('id', learningId)
        .select()
        .single();

      if (updated.error) throw updated.error;
      return updated.data;
    }

    return data;
  }

  /**
   * Detect patterns in learnings (common categories, triggers, lessons)
   */
  async detectLearningPatterns(): Promise<{
    commonCategories: Array<{ category: string; count: number }>;
    commonTriggers: Array<{ pattern: string; count: number }>;
    recentTrends: Array<{ week: string; count: number; severity: string }>;
    topLessons: Array<{ lesson: string; applied: number; id: string }>;
  }> {
    const learnings = await this.getLearnings({ limit: 1000 });

    // Category distribution
    const categoryMap = new Map<string, number>();
    learnings.forEach(l => {
      categoryMap.set(l.category, (categoryMap.get(l.category) || 0) + 1);
    });
    const commonCategories = Array.from(categoryMap.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    // Trigger patterns (extract common words)
    const triggerWords = new Map<string, number>();
    learnings.forEach(l => {
      const words = l.trigger.toLowerCase().split(/\s+/)
        .filter(w => w.length > 4); // Only words longer than 4 chars
      words.forEach(word => {
        triggerWords.set(word, (triggerWords.get(word) || 0) + 1);
      });
    });
    const commonTriggers = Array.from(triggerWords.entries())
      .map(([pattern, count]) => ({ pattern, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Recent trends by week
    const weekMap = new Map<string, { count: number; severities: string[] }>();
    learnings.forEach(l => {
      const date = new Date(l.created_at);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const weekKey = weekStart.toISOString().split('T')[0]!;

      const existing = weekMap.get(weekKey) || { count: 0, severities: [] };
      existing.count++;
      existing.severities.push(l.severity as string);
      weekMap.set(weekKey, existing);
    });
    const recentTrends = Array.from(weekMap.entries())
      .map(([week, data]) => ({
        week,
        count: data.count,
        severity: data.severities.filter(s => s === 'critical').length > 0
          ? 'critical'
          : data.severities.filter(s => s === 'warning').length > 0
            ? 'warning'
            : 'info'
      }))
      .sort((a, b) => b.week.localeCompare(a.week))
      .slice(0, 8);

    // Top applied lessons
    const topLessons = learnings
      .filter(l => l.applied_count > 0)
      .sort((a, b) => b.applied_count - a.applied_count)
      .slice(0, 10)
      .map(l => ({
        lesson: l.lesson,
        applied: l.applied_count,
        id: l.id
      }));

    return {
      commonCategories,
      commonTriggers,
      recentTrends,
      topLessons
    };
  }

  /**
   * Get learning recommendations based on current context
   */
  async getLearningRecommendations(context: string, limit = 5): Promise<Learning[]> {
    const learnings = await this.searchLearnings(context, { limit: limit * 2 });

    // Score and rank by relevance + application count
    const scored = learnings.map(l => ({
      learning: l,
      score: (l.applied_count || 0) * 0.3 + // Boost frequently applied learnings
              (l.severity === 'critical' ? 1.5 : l.severity === 'warning' ? 1.2 : 1.0)
    }));

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.learning);
  }

  /**
   * Find similar learnings using embeddings
   */
  async findSimilarLearnings(learningId: string, opts: {
    limit?: number;
    threshold?: number;
  } = {}): Promise<Array<Learning & { similarity: number }>> {
    const learning = await this.supabase
      .from('learnings')
      .select()
      .eq('id', learningId)
      .single();

    if (learning.error) throw learning.error;

    // Generate embedding for the learning
    const text = `${learning.data.trigger} ${learning.data.lesson} ${learning.data.action || ''}`;
    const embedding = await generateEmbedding(text, this.config, this.openai);

    if (!embedding) {
      throw new Error('Failed to generate embedding for learning');
    }

    // Store embedding in metadata for future use
    await this.supabase
      .from('learnings')
      .update({
        metadata: {
          ...learning.data.metadata,
          embedding
        }
      })
      .eq('id', learningId);

    // Search for similar learnings
    const { data, error } = await this.supabase
      .from('learnings')
      .select()
      .eq('agent_id', this.agentId)
      .neq('id', learningId);

    if (error) throw error;

    // Calculate similarities
    const similarities: Array<Learning & { similarity: number }> = [];

    for (const l of data || []) {
      // Get or generate embedding
      const lText = `${l.trigger} ${l.lesson} ${l.action || ''}`;
      let lEmbedding: number[] | null;

      if (l.metadata?.embedding && Array.isArray(l.metadata.embedding)) {
        lEmbedding = l.metadata.embedding as number[];
      } else {
        // Generate embedding on the fly
        lEmbedding = await generateEmbedding(lText, this.config, this.openai);

        if (lEmbedding) {
          // Cache it
          await this.supabase
            .from('learnings')
            .update({
              metadata: {
                ...l.metadata,
                embedding: lEmbedding
              }
            })
            .eq('id', l.id);
        }
      }

      if (lEmbedding !== null && lEmbedding.length > 0) {
        const similarity = cosineSimilarity(embedding, lEmbedding!);
        similarities.push({ ...l, similarity });
      }
    }

    return similarities
      .filter(s => s.similarity >= (opts.threshold || 0.7))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, opts.limit || 5);
  }

  /**
   * Export learnings to markdown report
   */
  async exportLearningsReport(opts: {
    category?: string;
    severity?: string;
    since?: string; // ISO date
  } = {}): Promise<string> {
    let learnings = await this.getLearnings({
      category: opts.category,
      severity: opts.severity,
      limit: 1000
    });

    if (opts.since) {
      const sinceDate = new Date(opts.since);
      learnings = learnings.filter(l => new Date(l.created_at) >= sinceDate);
    }

    const patterns = await this.detectLearningPatterns();

    let report = `# Learning Report\n\n`;
    report += `**Generated:** ${new Date().toISOString()}\n`;
    report += `**Total Learnings:** ${learnings.length}\n\n`;

    // Patterns section
    report += `## Patterns\n\n`;
    report += `### Categories\n`;
    patterns.commonCategories.forEach(c => {
      report += `- ${c.category}: ${c.count}\n`;
    });

    report += `\n### Common Triggers\n`;
    patterns.commonTriggers.forEach(t => {
      report += `- "${t.pattern}": ${t.count} occurrences\n`;
    });

    report += `\n### Top Applied Lessons\n`;
    patterns.topLessons.forEach(l => {
      report += `- "${l.lesson}" (applied ${l.applied} times)\n`;
    });

    // Individual learnings by category
    report += `\n## All Learnings\n\n`;

    const byCategory = new Map<string, Learning[]>();
    learnings.forEach(l => {
      const cat = byCategory.get(l.category) || [];
      cat.push(l);
      byCategory.set(l.category, cat);
    });

    byCategory.forEach((items, category) => {
      report += `### ${category.toUpperCase()}\n\n`;
      items.forEach(l => {
        report += `**[${l.severity.toUpperCase()}]** ${l.trigger}\n`;
        report += `- Lesson: ${l.lesson}\n`;
        if (l.action) {
          report += `- Action: ${l.action}\n`;
        }
        report += `- Applied: ${l.applied_count} times\n`;
        report += `- Created: ${new Date(l.created_at).toLocaleDateString()}\n\n`;
      });
    });

    return report;
  }

  /**
   * Export learnings to JSON
   */
  async exportLearningsJSON(opts: {
    category?: string;
    severity?: string;
    since?: string;
  } = {}): Promise<object> {
    let learnings = await this.getLearnings({
      category: opts.category,
      severity: opts.severity,
      limit: 1000
    });

    if (opts.since) {
      const sinceDate = new Date(opts.since);
      learnings = learnings.filter(l => new Date(l.created_at) >= sinceDate);
    }

    const patterns = await this.detectLearningPatterns();

    return {
      generated: new Date().toISOString(),
      total: learnings.length,
      patterns,
      learnings
    };
  }
}
