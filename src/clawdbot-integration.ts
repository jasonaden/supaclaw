/**
 * Clawdbot Integration for OpenClaw Memory
 * 
 * This module provides integration hooks for Clawdbot to:
 * 1. Auto-log all messages to sessions
 * 2. Replace memory_search with semantic recall
 * 3. Replace memory_get with database queries
 * 4. Inject relevant context into system prompts
 * 5. Handle session lifecycle
 */

import { OpenClawMemory, Memory, Learning, Task } from './index';

export interface ClawdbotConfig {
  supabaseUrl: string;
  supabaseKey: string;
  agentId: string;
  userId?: string;
  embeddingProvider?: 'openai' | 'voyage' | 'none';
  openaiApiKey?: string;
  autoLog?: boolean; // Auto-log messages (default: true)
  autoInject?: boolean; // Auto-inject context (default: true)
  sessionTimeout?: number; // Session timeout in ms (default: 30min)
}

export interface MessageContext {
  sessionId?: string;
  userId?: string;
  channel?: string;
  messageId?: string;
  timestamp?: string;
  model?: string;
}

export class ClawdbotMemoryIntegration {
  private memory: OpenClawMemory;
  private config: ClawdbotConfig;
  private activeSessions: Map<string, { sessionId: string; lastActivity: number }>;
  private sessionTimeoutMs: number;

  constructor(config: ClawdbotConfig) {
    this.config = config;
    this.memory = new OpenClawMemory({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      agentId: config.agentId,
      embeddingProvider: config.embeddingProvider || 'openai',
      openaiApiKey: config.openaiApiKey
    });
    this.activeSessions = new Map();
    this.sessionTimeoutMs = config.sessionTimeout || 30 * 60 * 1000; // 30 minutes default
  }

  /**
   * Initialize the memory system
   */
  async initialize(): Promise<void> {
    await this.memory.initialize();
  }

  /**
   * Get or create a session for a chat/user
   */
  async getOrCreateSession(chatId: string, context: MessageContext = {}): Promise<string> {
    // Check if active session exists
    const existing = this.activeSessions.get(chatId);
    const now = Date.now();

    if (existing && (now - existing.lastActivity) < this.sessionTimeoutMs) {
      // Update last activity
      existing.lastActivity = now;
      return existing.sessionId;
    }

    // End old session if it exists
    if (existing) {
      await this.endSession(chatId);
    }

    // Create new session
    const session = await this.memory.startSession({
      userId: context.userId || this.config.userId,
      channel: context.channel,
      metadata: {
        chatId,
        startedBy: 'clawdbot-integration'
      }
    });

    this.activeSessions.set(chatId, {
      sessionId: session.id,
      lastActivity: now
    });

    return session.id;
  }

  /**
   * Log a user message
   */
  async logUserMessage(chatId: string, content: string, context: MessageContext = {}): Promise<void> {
    if (!this.config.autoLog) return;

    const sessionId = await this.getOrCreateSession(chatId, context);

    await this.memory.addMessage(sessionId, {
      role: 'user',
      content,
      metadata: {
        messageId: context.messageId,
        timestamp: context.timestamp || new Date().toISOString(),
        channel: context.channel
      }
    });
  }

  /**
   * Log an assistant message
   */
  async logAssistantMessage(chatId: string, content: string, context: MessageContext = {}): Promise<void> {
    if (!this.config.autoLog) return;

    const sessionId = await this.getOrCreateSession(chatId, context);

    await this.memory.addMessage(sessionId, {
      role: 'assistant',
      content,
      metadata: {
        messageId: context.messageId,
        timestamp: context.timestamp || new Date().toISOString(),
        model: context.model,
        channel: context.channel
      }
    });
  }

  /**
   * Log a system message
   */
  async logSystemMessage(chatId: string, content: string, context: MessageContext = {}): Promise<void> {
    if (!this.config.autoLog) return;

    const sessionId = await this.getOrCreateSession(chatId, context);

    await this.memory.addMessage(sessionId, {
      role: 'system',
      content,
      metadata: {
        timestamp: context.timestamp || new Date().toISOString()
      }
    });
  }

  /**
   * Replace memory_search - semantic search for memories
   */
  async memorySearch(query: string, opts: {
    userId?: string;
    category?: string;
    limit?: number;
    minImportance?: number;
  } = {}): Promise<Array<{
    content: string;
    category?: string;
    importance: number;
    created_at: string;
  }>> {
    const results = await this.memory.recall(query, {
      userId: opts.userId || this.config.userId,
      category: opts.category,
      limit: opts.limit || 5,
      minImportance: opts.minImportance || 0.5
    });

    return results.map(r => ({
      content: r.content,
      category: r.category,
      importance: r.importance,
      created_at: r.created_at
    }));
  }

  /**
   * Replace memory_get - get memories by category
   */
  async memoryGet(opts: {
    category?: string;
    userId?: string;
    limit?: number;
  } = {}): Promise<Array<{
    content: string;
    category?: string;
    importance: number;
  }>> {
    const results = await this.memory.getMemories({
      userId: opts.userId || this.config.userId,
      category: opts.category,
      limit: opts.limit || 10
    });

    return results.map(r => ({
      content: r.content,
      category: r.category,
      importance: r.importance
    }));
  }

  /**
   * Build context for system prompt injection
   */
  async buildContext(query: string, opts: {
    includeMemories?: boolean;
    includeLearnings?: boolean;
    includeRecentMessages?: boolean;
    chatId?: string;
    maxMemories?: number;
    maxLearnings?: number;
    maxMessages?: number;
  } = {}): Promise<string> {
    const parts: string[] = [];

    // Include relevant memories
    if (opts.includeMemories !== false) {
      const memories = await this.memorySearch(query, {
        limit: opts.maxMemories || 5
      });

      if (memories.length > 0) {
        parts.push('## Relevant Context\n');
        memories.forEach(m => {
          parts.push(`- [${m.category || 'general'}] ${m.content}`);
        });
        parts.push('');
      }
    }

    // Include relevant learnings
    if (opts.includeLearnings !== false) {
      const learnings = await this.memory.getLearningRecommendations(
        query,
        opts.maxLearnings || 3
      );

      if (learnings.length > 0) {
        parts.push('## Past Learnings\n');
        learnings.forEach(l => {
          parts.push(`- [${l.category}] ${l.lesson}`);
          if (l.action) {
            parts.push(`  Action: ${l.action}`);
          }
        });
        parts.push('');
      }
    }

    // Include recent messages from session
    if (opts.includeRecentMessages && opts.chatId) {
      const session = this.activeSessions.get(opts.chatId);
      if (session) {
        const messages = await this.memory.getMessages(session.sessionId, {
          limit: opts.maxMessages || 10
        });

        if (messages.length > 0) {
          parts.push('## Recent Conversation\n');
          messages.slice(-5).forEach(m => {
            const preview = m.content.length > 100 
              ? m.content.substring(0, 100) + '...' 
              : m.content;
            parts.push(`- ${m.role}: ${preview}`);
          });
          parts.push('');
        }
      }
    }

    return parts.join('\n');
  }

  /**
   * Store a memory
   */
  async remember(content: string, opts: {
    category?: string;
    importance?: number;
    userId?: string;
    chatId?: string;
    expiresAt?: string;
  } = {}): Promise<Memory> {
    let sessionId: string | undefined;
    
    if (opts.chatId) {
      const session = this.activeSessions.get(opts.chatId);
      sessionId = session?.sessionId;
    }

    return await this.memory.remember({
      content,
      category: opts.category,
      importance: opts.importance || 0.5,
      userId: opts.userId || this.config.userId,
      sessionId,
      expiresAt: opts.expiresAt
    });
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
    chatId?: string;
  }): Promise<Learning> {
    let sessionId: string | undefined;
    
    if (learning.chatId) {
      const session = this.activeSessions.get(learning.chatId);
      sessionId = session?.sessionId;
    }

    return await this.memory.learn({
      category: learning.category,
      trigger: learning.trigger,
      lesson: learning.lesson,
      action: learning.action,
      severity: learning.severity || 'info',
      sessionId
    });
  }

  /**
   * Create a task
   */
  async createTask(task: {
    title: string;
    description?: string;
    priority?: number;
    dueAt?: string;
    userId?: string;
    parentTaskId?: string;
  }): Promise<Task> {
    return await this.memory.createTask({
      ...task,
      userId: task.userId || this.config.userId
    });
  }

  /**
   * Get upcoming tasks for reminders
   */
  async getUpcomingTasks(hoursAhead = 24): Promise<Array<Task & { timeUntilDue: number }>> {
    return await this.memory.getTasksNeedingReminders({
      userId: this.config.userId,
      hoursAhead
    });
  }

  /**
   * End a session
   */
  async endSession(chatId: string, opts: {
    summary?: string;
    autoSummarize?: boolean;
    extractMemories?: boolean;
  } = {}): Promise<void> {
    const session = this.activeSessions.get(chatId);
    if (!session) return;

    // End session with optional summary
    await this.memory.endSession(session.sessionId, {
      summary: opts.summary,
      autoSummarize: opts.autoSummarize !== false // Default true
    });

    // Extract memories if requested
    if (opts.extractMemories) {
      await this.memory.extractMemoriesFromSession(session.sessionId, {
        autoExtract: true,
        minImportance: 0.6
      });
    }

    this.activeSessions.delete(chatId);
  }

  /**
   * End all inactive sessions
   */
  async cleanupInactiveSessions(): Promise<void> {
    const now = Date.now();
    const toEnd: string[] = [];

    this.activeSessions.forEach((session, chatId) => {
      if (now - session.lastActivity >= this.sessionTimeoutMs) {
        toEnd.push(chatId);
      }
    });

    for (const chatId of toEnd) {
      await this.endSession(chatId, { autoSummarize: true });
    }
  }

  /**
   * Heartbeat check - call this periodically (e.g., every 30 min)
   */
  async heartbeat(): Promise<{
    upcomingTasks: Array<Task & { timeUntilDue: number }>;
    inactiveSessions: number;
  }> {
    // Clean up inactive sessions
    await this.cleanupInactiveSessions();

    // Get upcoming tasks
    const upcomingTasks = await this.getUpcomingTasks(2); // Next 2 hours

    return {
      upcomingTasks,
      inactiveSessions: this.activeSessions.size
    };
  }

  /**
   * Get the underlying OpenClawMemory instance for advanced operations
   */
  getMemory(): OpenClawMemory {
    return this.memory;
  }
}

/**
 * Factory function to create integration instance
 */
export function createClawdbotIntegration(config: ClawdbotConfig): ClawdbotMemoryIntegration {
  return new ClawdbotMemoryIntegration(config);
}

/**
 * Express/Koa-style middleware for auto-logging
 */
export function createLoggingMiddleware(integration: ClawdbotMemoryIntegration) {
  return async (message: {
    chatId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    context?: MessageContext;
  }): Promise<void> => {
    const { chatId, role, content, context = {} } = message;

    if (role === 'user') {
      await integration.logUserMessage(chatId, content, context);
    } else if (role === 'assistant') {
      await integration.logAssistantMessage(chatId, content, context);
    } else if (role === 'system') {
      await integration.logSystemMessage(chatId, content, context);
    }
  };
}
