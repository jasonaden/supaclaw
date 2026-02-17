/**
 * Context Window Management
 * Implements token budgeting, smart context selection, and lost-in-middle mitigation
 */

import type { Message, Memory, Learning, Entity } from './types';

export interface ContextBudget {
  total: number;
  systemPrompt: number;
  recentMessages: number;
  memories: number;
  learnings: number;
  entities: number;
  reserve: number; // Buffer for user input + response
}

export interface ContextItem {
  type: 'message' | 'memory' | 'learning' | 'entity';
  content: string;
  importance: number; // 0-1
  timestamp: string;
  tokenCount: number;
  metadata?: Record<string, unknown>;
}

export interface ContextWindow {
  items: ContextItem[];
  totalTokens: number;
  budget: ContextBudget;
  truncated: boolean;
}

/**
 * Estimates token count using rough heuristic
 * 1 token ≈ 4 characters for English text
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimates token count more accurately using word count
 * Better approximation: 1 token ≈ 0.75 words
 */
export function estimateTokensAccurate(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.ceil(words / 0.75);
}

/**
 * Create a context budget for different model context windows
 */
export function createContextBudget(opts: {
  modelContextSize?: number; // Default: 128k (Claude 3.5)
  systemPromptSize?: number; // Default: 2k
  reserveSize?: number; // Default: 4k for input + output
  recentMessagesPct?: number; // Default: 40%
  memoriesPct?: number; // Default: 30%
  learningsPct?: number; // Default: 20%
  entitiesPct?: number; // Default: 10%
}): ContextBudget {
  const total = opts.modelContextSize || 128000;
  const systemPrompt = opts.systemPromptSize || 2000;
  const reserve = opts.reserveSize || 4000;

  const available = total - systemPrompt - reserve;

  const recentMessagesPct = opts.recentMessagesPct || 0.4;
  const memoriesPct = opts.memoriesPct || 0.3;
  const learningsPct = opts.learningsPct || 0.2;
  const entitiesPct = opts.entitiesPct || 0.1;

  return {
    total,
    systemPrompt,
    reserve,
    recentMessages: Math.floor(available * recentMessagesPct),
    memories: Math.floor(available * memoriesPct),
    learnings: Math.floor(available * learningsPct),
    entities: Math.floor(available * entitiesPct)
  };
}

/**
 * Convert messages to context items
 */
export function messagesToContextItems(messages: Message[]): ContextItem[] {
  return messages.map(msg => ({
    type: 'message',
    content: `${msg.role}: ${msg.content}`,
    importance: msg.role === 'user' ? 0.8 : 0.6, // User messages slightly more important
    timestamp: msg.created_at,
    tokenCount: msg.token_count || estimateTokens(msg.content),
    metadata: { id: msg.id, session_id: msg.session_id, ...msg.metadata }
  }));
}

/**
 * Convert memories to context items
 */
export function memoriesToContextItems(memories: Memory[]): ContextItem[] {
  return memories.map(mem => ({
    type: 'memory',
    content: `[Memory: ${mem.category || 'general'}] ${mem.content}`,
    importance: mem.importance,
    timestamp: mem.created_at,
    tokenCount: estimateTokens(mem.content),
    metadata: { id: mem.id, category: mem.category, ...mem.metadata }
  }));
}

/**
 * Convert learnings to context items
 */
export function learningsToContextItems(learnings: Learning[]): ContextItem[] {
  return learnings.map(learn => ({
    type: 'learning',
    content: `[Learning: ${learn.category}] ${learn.lesson}${learn.action ? '\nAction: ' + learn.action : ''}`,
    importance: learn.severity === 'critical' ? 0.9 : learn.severity === 'warning' ? 0.7 : 0.5,
    timestamp: learn.created_at,
    tokenCount: estimateTokens(learn.lesson + (learn.action || '')),
    metadata: { id: learn.id, severity: learn.severity, applied: learn.applied_count, ...learn.metadata }
  }));
}

/**
 * Convert entities to context items
 */
export function entitiesToContextItems(entities: Entity[]): ContextItem[] {
  return entities.map(entity => ({
    type: 'entity',
    content: `[Entity: ${entity.entity_type}] ${entity.name}${entity.description ? ': ' + entity.description : ''}`,
    importance: Math.min(entity.mention_count / 20, 1), // More mentions = more important
    timestamp: entity.last_seen_at,
    tokenCount: estimateTokens(entity.name + (entity.description || '')),
    metadata: { id: entity.id, type: entity.entity_type, mentions: entity.mention_count }
  }));
}

/**
 * Select items within budget using smart prioritization
 * Implements lost-in-middle mitigation by placing high-importance items at edges
 */
export function selectContextItems(
  items: ContextItem[],
  budget: number,
  opts: {
    recencyWeight?: number; // 0-1, default 0.3
    importanceWeight?: number; // 0-1, default 0.7
  } = {}
): ContextItem[] {
  const recencyWeight = opts.recencyWeight ?? 0.3;
  const importanceWeight = opts.importanceWeight ?? 0.7;

  // Calculate composite score for each item
  const now = Date.now();
  const itemsWithScores = items.map(item => {
    const age = now - new Date(item.timestamp).getTime();
    const daysSinceCreated = age / (1000 * 60 * 60 * 24);
    
    // Recency score: exponential decay over 30 days
    const recencyScore = Math.exp(-daysSinceCreated / 30);
    
    // Composite score
    const score = (importanceWeight * item.importance) + (recencyWeight * recencyScore);
    
    return { item, score };
  });

  // Sort by score descending
  itemsWithScores.sort((a, b) => b.score - a.score);

  // Select items within budget
  let totalTokens = 0;
  const selected: ContextItem[] = [];

  for (const { item } of itemsWithScores) {
    if (totalTokens + item.tokenCount <= budget) {
      selected.push(item);
      totalTokens += item.tokenCount;
    }
  }

  return selected;
}

/**
 * Arrange items to mitigate "lost in the middle" effect
 * Places highest-importance items at the beginning and end
 * Medium-importance items go in the middle
 * 
 * Research shows LLMs pay more attention to the beginning and end of context
 */
export function arrangeForLostInMiddle(items: ContextItem[]): ContextItem[] {
  if (items.length <= 3) {
    return items; // Too few items to rearrange
  }

  // Sort by importance
  const sorted = [...items].sort((a, b) => b.importance - a.importance);

  const arranged: ContextItem[] = [];
  const half = Math.ceil(sorted.length / 2);

  // High-importance items at beginning
  for (let i = 0; i < half; i++) {
    if (i % 2 === 0) {
      arranged.push(sorted[i]!);
    }
  }

  // Medium-importance items in middle
  const middle = sorted.slice(half);
  arranged.push(...middle);

  // Remaining high-importance items at end
  for (let i = 0; i < half; i++) {
    if (i % 2 === 1) {
      arranged.push(sorted[i]!);
    }
  }

  return arranged;
}

/**
 * Build a complete context window with budget management
 */
export function buildContextWindow(opts: {
  messages: Message[];
  memories: Memory[];
  learnings: Learning[];
  entities: Entity[];
  budget: ContextBudget;
  useLostInMiddleFix?: boolean;
  recencyWeight?: number;
  importanceWeight?: number;
}): ContextWindow {
  const {
    messages,
    memories,
    learnings,
    entities,
    budget,
    useLostInMiddleFix = true,
    recencyWeight,
    importanceWeight
  } = opts;

  // Convert to context items
  const messageItems = messagesToContextItems(messages);
  const memoryItems = memoriesToContextItems(memories);
  const learningItems = learningsToContextItems(learnings);
  const entityItems = entitiesToContextItems(entities);

  // Select within budget for each category
  const selectedMessages = selectContextItems(messageItems, budget.recentMessages, {
    recencyWeight,
    importanceWeight
  });

  const selectedMemories = selectContextItems(memoryItems, budget.memories, {
    recencyWeight,
    importanceWeight
  });

  const selectedLearnings = selectContextItems(learningItems, budget.learnings, {
    recencyWeight,
    importanceWeight
  });

  const selectedEntities = selectContextItems(entityItems, budget.entities, {
    recencyWeight,
    importanceWeight
  });

  // Combine all items
  let allItems = [
    ...selectedMessages,
    ...selectedMemories,
    ...selectedLearnings,
    ...selectedEntities
  ];

  // Apply lost-in-middle mitigation
  if (useLostInMiddleFix) {
    allItems = arrangeForLostInMiddle(allItems);
  } else {
    // Default: chronological order
    allItems.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  const totalTokens = allItems.reduce((sum, item) => sum + item.tokenCount, 0);
  const truncated = 
    messageItems.length > selectedMessages.length ||
    memoryItems.length > selectedMemories.length ||
    learningItems.length > selectedLearnings.length ||
    entityItems.length > selectedEntities.length;

  return {
    items: allItems,
    totalTokens,
    budget,
    truncated
  };
}

/**
 * Format context window as string for injection into prompt
 */
export function formatContextWindow(window: ContextWindow, opts: {
  includeMetadata?: boolean;
  groupByType?: boolean;
} = {}): string {
  const { items } = window;
  const lines: string[] = [];

  if (opts.groupByType) {
    // Group by type
    const messages = items.filter(i => i.type === 'message');
    const memories = items.filter(i => i.type === 'memory');
    const learnings = items.filter(i => i.type === 'learning');
    const entities = items.filter(i => i.type === 'entity');

    if (memories.length > 0) {
      lines.push('# Relevant Memories');
      lines.push('');
      memories.forEach(m => lines.push(m.content));
      lines.push('');
    }

    if (learnings.length > 0) {
      lines.push('# Relevant Learnings');
      lines.push('');
      learnings.forEach(l => lines.push(l.content));
      lines.push('');
    }

    if (entities.length > 0) {
      lines.push('# Known Entities');
      lines.push('');
      entities.forEach(e => lines.push(e.content));
      lines.push('');
    }

    if (messages.length > 0) {
      lines.push('# Recent Conversation');
      lines.push('');
      messages.forEach(m => {
        const content = m.content;
        if (opts.includeMetadata && m.metadata) {
          lines.push(`${content} (importance: ${m.importance.toFixed(2)})`);
        } else {
          lines.push(content);
        }
      });
    }
  } else {
    // Chronological order
    items.forEach(item => {
      if (opts.includeMetadata) {
        lines.push(`${item.content} [${item.type}, importance: ${item.importance.toFixed(2)}]`);
      } else {
        lines.push(item.content);
      }
    });
  }

  return lines.join('\n');
}

/**
 * Get context window stats
 */
export function getContextStats(window: ContextWindow): {
  totalItems: number;
  totalTokens: number;
  budgetUsed: number;
  budgetRemaining: number;
  itemsByType: Record<string, number>;
  truncated: boolean;
} {
  const itemsByType: Record<string, number> = {};
  
  window.items.forEach(item => {
    itemsByType[item.type] = (itemsByType[item.type] || 0) + 1;
  });

  const totalBudget = 
    window.budget.recentMessages +
    window.budget.memories +
    window.budget.learnings +
    window.budget.entities;

  return {
    totalItems: window.items.length,
    totalTokens: window.totalTokens,
    budgetUsed: window.totalTokens / totalBudget,
    budgetRemaining: totalBudget - window.totalTokens,
    itemsByType,
    truncated: window.truncated
  };
}

/**
 * Adaptive context budgeting
 * Adjusts budget allocation based on available content
 */
export function createAdaptiveBudget(opts: {
  modelContextSize?: number;
  messageCount: number;
  memoryCount: number;
  learningCount: number;
  entityCount: number;
}): ContextBudget {
  const total = opts.modelContextSize || 128000;
  const systemPrompt = 2000;
  const reserve = 4000;
  const available = total - systemPrompt - reserve;

  // Calculate weights based on content availability
  const totalItems = opts.messageCount + opts.memoryCount + opts.learningCount + opts.entityCount;
  
  if (totalItems === 0) {
    return createContextBudget({ modelContextSize: total });
  }

  const messagePct = opts.messageCount / totalItems;
  const memoryPct = opts.memoryCount / totalItems;
  const learningPct = opts.learningCount / totalItems;
  const entityPct = opts.entityCount / totalItems;

  // Normalize (ensure sum = 1)
  const sum = messagePct + memoryPct + learningPct + entityPct;

  return {
    total,
    systemPrompt,
    reserve,
    recentMessages: Math.floor(available * (messagePct / sum)),
    memories: Math.floor(available * (memoryPct / sum)),
    learnings: Math.floor(available * (learningPct / sum)),
    entities: Math.floor(available * (entityPct / sum))
  };
}

/**
 * Model-specific context budgets
 */
export const MODEL_BUDGETS = {
  // Claude models
  'claude-3-opus': createContextBudget({ modelContextSize: 200000 }),
  'claude-3-sonnet': createContextBudget({ modelContextSize: 200000 }),
  'claude-3-haiku': createContextBudget({ modelContextSize: 200000 }),
  'claude-3.5-sonnet': createContextBudget({ modelContextSize: 200000 }),
  
  // GPT models
  'gpt-4-turbo': createContextBudget({ modelContextSize: 128000 }),
  'gpt-4': createContextBudget({ modelContextSize: 8192 }),
  'gpt-3.5-turbo': createContextBudget({ modelContextSize: 16384 }),
  
  // Other models
  'gemini-pro': createContextBudget({ modelContextSize: 32000 }),
  'llama-3-70b': createContextBudget({ modelContextSize: 8192 }),
  
  // Default
  'default': createContextBudget({ modelContextSize: 128000 })
};

/**
 * Get budget for a specific model
 */
export function getBudgetForModel(model: string): ContextBudget {
  return MODEL_BUDGETS[model as keyof typeof MODEL_BUDGETS] || MODEL_BUDGETS.default;
}
