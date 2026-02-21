import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
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

export interface SupaclawConfig {
  supabaseUrl: string;
  supabaseKey: string;
  agentId: string;
  embeddingProvider?: 'openai' | 'voyage' | 'none';
  openaiApiKey?: string;
  embeddingModel?: string; // Default: text-embedding-3-small
}

export interface Session {
  id: string;
  agent_id: string;
  user_id?: string;
  channel?: string;
  started_at: string;
  ended_at?: string;
  summary?: string;
  metadata: Record<string, unknown>;
}

export interface Message {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
  token_count?: number;
  metadata: Record<string, unknown>;
}

export interface Memory {
  id: string;
  agent_id: string;
  user_id?: string;
  category?: string;
  content: string;
  importance: number;
  source_session_id?: string;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
}

export interface Entity {
  id: string;
  agent_id: string;
  entity_type: string;
  name: string;
  aliases?: string[];
  description?: string;
  properties: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  mention_count: number;
}

export interface Task {
  id: string;
  agent_id: string;
  user_id?: string;
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'done';
  priority: number;
  due_at?: string;
  completed_at?: string;
  parent_task_id?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Learning {
  id: string;
  agent_id: string;
  category: 'error' | 'correction' | 'improvement' | 'capability_gap';
  trigger: string;
  lesson: string;
  action?: string;
  severity: 'info' | 'warning' | 'critical';
  source_session_id?: string;
  applied_count: number;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface EntityRelationship {
  id: string;
  agent_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  properties: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  mention_count: number;
  confidence: number;
  source_session_id?: string;
  metadata: Record<string, unknown>;
}

export class Supaclaw {
  private supabase: SupabaseClient;
  private agentId: string;
  private config: SupaclawConfig;
  private openai?: OpenAI;

  constructor(config: SupaclawConfig) {
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
    this.agentId = config.agentId;
    this.config = config;
    
    // Initialize OpenAI if API key provided
    if (config.openaiApiKey) {
      this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    }
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
      const response = await this.openai.embeddings.create({
        model,
        input: text,
      });

      return response.data[0].embedding;
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
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) return 0;

    return dotProduct / magnitude;
  }

  /**
   * Initialize database tables (run once)
   */
  async initialize(): Promise<void> {
    // Tables are created via migration SQL files
    // This checks if tables exist
    const { error } = await this.supabase
      .from('sessions')
      .select('id')
      .limit(1);
    
    if (error && error.code === '42P01') {
      throw new Error(
        'Tables not found. Run migrations first: npx supaclaw migrate'
      );
    }
  }

  // ============ SESSIONS ============

  /**
   * Start a new conversation session
   */
  async startSession(opts: {
    userId?: string;
    channel?: string;
    metadata?: Record<string, unknown>;
  } = {}): Promise<Session> {
    const { data, error } = await this.supabase
      .from('sessions')
      .insert({
        agent_id: this.agentId,
        user_id: opts.userId,
        channel: opts.channel,
        metadata: opts.metadata || {}
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Find an active session by external key, or create a new one.
   * Used by hook integrations that track sessions by an external identifier.
   */
  async getOrCreateSession(externalKey: string, opts: {
    channel?: string;
    userId?: string;
    metadata?: Record<string, unknown>;
  } = {}): Promise<{ id: string; isNew: boolean }> {
    // Look up active session by external key
    const { data: existing, error: lookupError } = await this.supabase
      .from('sessions')
      .select()
      .eq('external_key', externalKey)
      .eq('agent_id', this.agentId)
      .is('ended_at', null)
      .maybeSingle();

    if (lookupError) throw lookupError;

    if (existing) {
      return { id: existing.id, isNew: false };
    }

    // Create new session with external key
    const { data: created, error: createError } = await this.supabase
      .from('sessions')
      .insert({
        agent_id: this.agentId,
        external_key: externalKey,
        user_id: opts.userId,
        channel: opts.channel,
        metadata: opts.metadata || {},
      })
      .select()
      .single();

    if (createError) throw createError;
    return { id: created.id, isNew: true };
  }

  /**
   * End a session with optional summary
   */
  async endSession(sessionId: string, opts: {
    summary?: string;
    autoSummarize?: boolean;
    summarizeModel?: string;
  } = {}): Promise<Session> {
    let summary = opts.summary;

    // Auto-generate summary if requested
    if (opts.autoSummarize && !summary && this.openai) {
      summary = await this.generateSessionSummary(sessionId, opts.summarizeModel);
    }

    const { data, error } = await this.supabase
      .from('sessions')
      .update({
        ended_at: new Date().toISOString(),
        summary
      })
      .eq('id', sessionId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Generate an AI summary of a session
   */
  async generateSessionSummary(sessionId: string, model?: string): Promise<string> {
    if (!this.openai) {
      throw new Error('OpenAI client required for auto-summarization');
    }

    const messages = await this.getMessages(sessionId);
    if (messages.length === 0) {
      return 'Empty session';
    }

    const conversation = messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const response = await this.openai.chat.completions.create({
      model: model || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'Summarize this conversation in 2-3 sentences. Focus on key topics, decisions, and outcomes.'
        },
        {
          role: 'user',
          content: conversation
        }
      ],
      max_tokens: 200
    });

    return response.choices[0]?.message?.content || 'Summary generation failed';
  }

  /**
   * Resume a session (useful for continuing interrupted conversations)
   */
  async resumeSession(sessionId: string): Promise<{
    session: Session;
    messages: Message[];
    context: string;
  }> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const messages = await this.getMessages(sessionId);

    // Build context summary
    const contextParts = [];
    if (session.summary) {
      contextParts.push(`Previous summary: ${session.summary}`);
    }
    contextParts.push(`Message count: ${messages.length}`);
    
    const lastMessages = messages.slice(-5);
    if (lastMessages.length > 0) {
      contextParts.push('Recent messages:');
      lastMessages.forEach(m => {
        contextParts.push(`  ${m.role}: ${m.content.substring(0, 100)}...`);
      });
    }

    return {
      session,
      messages,
      context: contextParts.join('\n')
    };
  }

  /**
   * Search sessions by date range
   */
  async searchSessions(opts: {
    userId?: string;
    startDate?: string; // ISO date string
    endDate?: string;
    channel?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<Session[]> {
    let query = this.supabase
      .from('sessions')
      .select()
      .eq('agent_id', this.agentId)
      .order('started_at', { ascending: false });

    if (opts.userId) {
      query = query.eq('user_id', opts.userId);
    }
    if (opts.channel) {
      query = query.eq('channel', opts.channel);
    }
    if (opts.startDate) {
      query = query.gte('started_at', opts.startDate);
    }
    if (opts.endDate) {
      query = query.lte('started_at', opts.endDate);
    }

    query = query.range(
      opts.offset || 0,
      (opts.offset || 0) + (opts.limit || 50) - 1
    );

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  /**
   * Export a session to markdown
   */
  async exportSessionToMarkdown(sessionId: string): Promise<string> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const messages = await this.getMessages(sessionId);

    const lines = [
      `# Session ${session.id}`,
      '',
      `**Started:** ${new Date(session.started_at).toLocaleString()}`,
      session.ended_at ? `**Ended:** ${new Date(session.ended_at).toLocaleString()}` : '**Status:** Active',
      session.user_id ? `**User:** ${session.user_id}` : '',
      session.channel ? `**Channel:** ${session.channel}` : '',
      ''
    ];

    if (session.summary) {
      lines.push(`## Summary`, '', session.summary, '');
    }

    lines.push(`## Messages (${messages.length})`, '');

    messages.forEach(msg => {
      const time = new Date(msg.created_at).toLocaleTimeString();
      lines.push(`### ${msg.role} (${time})`);
      lines.push('');
      lines.push(msg.content);
      lines.push('');
    });

    return lines.filter(Boolean).join('\n');
  }

  /**
   * Import a session from markdown
   */
  async importSessionFromMarkdown(markdown: string, opts: {
    userId?: string;
    channel?: string;
  } = {}): Promise<Session> {
    // Simple parser - expects format from exportSessionToMarkdown
    const lines = markdown.split('\n');
    
    // Start new session
    const session = await this.startSession({
      userId: opts.userId,
      channel: opts.channel
    });

    // Parse messages (simple state machine)
    let currentRole: 'user' | 'assistant' | 'system' | 'tool' = 'user';
    let currentContent: string[] = [];

    for (const line of lines) {
      const roleMatch = line.match(/^### (user|assistant|system|tool)/i);
      
      if (roleMatch) {
        // Save previous message if exists
        if (currentContent.length > 0) {
          await this.addMessage(session.id, {
            role: currentRole,
            content: currentContent.join('\n').trim()
          });
          currentContent = [];
        }
        currentRole = roleMatch[1].toLowerCase() as typeof currentRole;
      } else if (line.startsWith('##') || line.startsWith('**')) {
        // Skip headers and metadata
        continue;
      } else {
        currentContent.push(line);
      }
    }

    // Save last message
    if (currentContent.length > 0) {
      await this.addMessage(session.id, {
        role: currentRole,
        content: currentContent.join('\n').trim()
      });
    }

    return session;
  }

  /**
   * Extract memories from a session
   */
  async extractMemoriesFromSession(sessionId: string, opts: {
    minImportance?: number;
    autoExtract?: boolean;
  } = {}): Promise<Memory[]> {
    const messages = await this.getMessages(sessionId);
    const memories: Memory[] = [];

    if (opts.autoExtract && this.openai) {
      // Use AI to extract key learnings
      const conversation = messages
        .map(m => `${m.role}: ${m.content}`)
        .join('\n');

      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Extract key facts, decisions, and learnings from this conversation.
Return as JSON array: [{"content": "...", "category": "fact|decision|preference|learning", "importance": 0-1}]`
          },
          {
            role: 'user',
            content: conversation
          }
        ],
        response_format: { type: 'json_object' }
      });

      const result = JSON.parse(response.choices[0]?.message?.content || '{"items":[]}');
      const items = result.items || result.memories || [];

      for (const item of items) {
        if (item.importance >= (opts.minImportance || 0.5)) {
          const memory = await this.remember({
            content: item.content,
            category: item.category,
            importance: item.importance,
            sessionId
          });
          memories.push(memory);
        }
      }
    }

    return memories;
  }

  /**
   * Count tokens in a session
   */
  async countSessionTokens(sessionId: string): Promise<{
    totalTokens: number;
    messageCount: number;
    averageTokensPerMessage: number;
  }> {
    const messages = await this.getMessages(sessionId);
    
    let totalTokens = 0;
    for (const msg of messages) {
      if (msg.token_count) {
        totalTokens += msg.token_count;
      } else {
        // Rough estimation: 1 token ≈ 4 characters
        totalTokens += Math.ceil(msg.content.length / 4);
      }
    }

    return {
      totalTokens,
      messageCount: messages.length,
      averageTokensPerMessage: messages.length > 0 
        ? Math.round(totalTokens / messages.length) 
        : 0
    };
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const { data, error } = await this.supabase
      .from('sessions')
      .select()
      .eq('id', sessionId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  /**
   * Get recent sessions
   */
  async getRecentSessions(opts: {
    userId?: string;
    limit?: number;
  } = {}): Promise<Session[]> {
    let query = this.supabase
      .from('sessions')
      .select()
      .eq('agent_id', this.agentId)
      .order('started_at', { ascending: false })
      .limit(opts.limit || 10);

    if (opts.userId) {
      query = query.eq('user_id', opts.userId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  // ============ MESSAGES ============

  /**
   * Add a message to a session
   */
  async addMessage(sessionId: string, message: {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    tokenCount?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Message> {
    const { data, error } = await this.supabase
      .from('messages')
      .insert({
        session_id: sessionId,
        role: message.role,
        content: message.content,
        token_count: message.tokenCount,
        metadata: message.metadata || {}
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Get messages from a session
   */
  async getMessages(sessionId: string, opts: {
    limit?: number;
    offset?: number;
  } = {}): Promise<Message[]> {
    const { data, error } = await this.supabase
      .from('messages')
      .select()
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .range(opts.offset || 0, (opts.offset || 0) + (opts.limit || 100) - 1);

    if (error) throw error;
    return data || [];
  }

  // ============ MEMORIES ============

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
    // Generate embedding if provider configured
    const embedding = await this.generateEmbedding(memory.content);

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
    // Generate query embedding for semantic search
    const queryEmbedding = await this.generateEmbedding(query);

    if (queryEmbedding) {
      // Use pgvector for semantic search
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
    }

    // Fallback to text search when no embeddings available
    let q = this.supabase
      .from('memories')
      .select()
      .eq('agent_id', this.agentId)
      .order('importance', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(opts.limit || 10);

    if (opts.userId) {
      q = q.or(`user_id.eq.${opts.userId},user_id.is.null`);
    }
    if (opts.category) {
      q = q.eq('category', opts.category);
    }
    if (opts.minImportance) {
      q = q.gte('importance', opts.minImportance);
    }

    // Text search filter
    q = q.ilike('content', `%${query}%`);

    const { data, error } = await q;
    if (error) throw error;
    return data || [];
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
    const { error } = await this.supabase
      .from('memories')
      .delete()
      .eq('id', memoryId);

    if (error) throw error;
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

  // ============ TASKS ============

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
    metadata?: Record<string, unknown>;
  }): Promise<Task> {
    const { data, error } = await this.supabase
      .from('tasks')
      .insert({
        agent_id: this.agentId,
        user_id: task.userId,
        title: task.title,
        description: task.description,
        priority: task.priority ?? 0,
        due_at: task.dueAt,
        parent_task_id: task.parentTaskId,
        metadata: task.metadata || {}
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Update a task
   */
  async updateTask(taskId: string, updates: Partial<{
    title: string;
    description: string;
    status: 'pending' | 'in_progress' | 'blocked' | 'done';
    priority: number;
    dueAt: string;
    metadata: Record<string, unknown>;
  }>): Promise<Task> {
    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    };

    if (updates.title) updateData.title = updates.title;
    if (updates.description) updateData.description = updates.description;
    if (updates.status) {
      updateData.status = updates.status;
      if (updates.status === 'done') {
        updateData.completed_at = new Date().toISOString();
      }
    }
    if (updates.priority !== undefined) updateData.priority = updates.priority;
    if (updates.dueAt) updateData.due_at = updates.dueAt;
    if (updates.metadata) updateData.metadata = updates.metadata;

    const { data, error } = await this.supabase
      .from('tasks')
      .update(updateData)
      .eq('id', taskId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Get tasks
   */
  async getTasks(opts: {
    status?: string;
    userId?: string;
    limit?: number;
  } = {}): Promise<Task[]> {
    let query = this.supabase
      .from('tasks')
      .select()
      .eq('agent_id', this.agentId)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(opts.limit || 50);

    if (opts.status) {
      query = query.eq('status', opts.status);
    }
    if (opts.userId) {
      query = query.eq('user_id', opts.userId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<void> {
    const { error } = await this.supabase
      .from('tasks')
      .delete()
      .eq('id', taskId);

    if (error) throw error;
  }

  /**
   * Get subtasks of a parent task
   */
  async getSubtasks(parentTaskId: string): Promise<Task[]> {
    const { data, error } = await this.supabase
      .from('tasks')
      .select()
      .eq('parent_task_id', parentTaskId)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Get task with all its subtasks (hierarchical)
   */
  async getTaskWithSubtasks(taskId: string): Promise<{
    task: Task;
    subtasks: Task[];
  }> {
    const task = await this.supabase
      .from('tasks')
      .select()
      .eq('id', taskId)
      .single();

    if (task.error) throw task.error;

    const subtasks = await this.getSubtasks(taskId);

    return {
      task: task.data,
      subtasks
    };
  }

  /**
   * Get upcoming tasks (due soon)
   */
  async getUpcomingTasks(opts: {
    userId?: string;
    hoursAhead?: number;
  } = {}): Promise<Task[]> {
    const now = new Date();
    const future = new Date(now.getTime() + (opts.hoursAhead || 24) * 60 * 60 * 1000);

    let query = this.supabase
      .from('tasks')
      .select()
      .eq('agent_id', this.agentId)
      .neq('status', 'done')
      .not('due_at', 'is', null)
      .gte('due_at', now.toISOString())
      .lte('due_at', future.toISOString())
      .order('due_at', { ascending: true });

    if (opts.userId) {
      query = query.eq('user_id', opts.userId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  // ============ LEARNINGS ============

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
  }

  /**
   * Get learnings
   */
  async getLearnings(opts: {
    category?: string;
    severity?: string;
    limit?: number;
  } = {}): Promise<Learning[]> {
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
  }

  /**
   * Search learnings by topic for context
   */
  async searchLearnings(query: string, opts: {
    limit?: number;
  } = {}): Promise<Learning[]> {
    const { data, error } = await this.supabase
      .from('learnings')
      .select()
      .eq('agent_id', this.agentId)
      .or(`trigger.ilike.%${query}%,lesson.ilike.%${query}%,action.ilike.%${query}%`)
      .order('created_at', { ascending: false })
      .limit(opts.limit || 10);

    if (error) throw error;
    return data || [];
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

  // ============ TASK DEPENDENCIES ============

  /**
   * Add a task dependency (taskId depends on dependsOnTaskId)
   */
  async addTaskDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    // Store in metadata
    const task = await this.supabase
      .from('tasks')
      .select()
      .eq('id', taskId)
      .single();

    if (task.error) throw task.error;

    const dependencies = (task.data.metadata?.dependencies as string[]) || [];
    if (!dependencies.includes(dependsOnTaskId)) {
      dependencies.push(dependsOnTaskId);
    }

    await this.supabase
      .from('tasks')
      .update({
        metadata: {
          ...task.data.metadata,
          dependencies
        }
      })
      .eq('id', taskId);
  }

  /**
   * Remove a task dependency
   */
  async removeTaskDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    const task = await this.supabase
      .from('tasks')
      .select()
      .eq('id', taskId)
      .single();

    if (task.error) throw task.error;

    const dependencies = (task.data.metadata?.dependencies as string[]) || [];
    const filtered = dependencies.filter(id => id !== dependsOnTaskId);

    await this.supabase
      .from('tasks')
      .update({
        metadata: {
          ...task.data.metadata,
          dependencies: filtered
        }
      })
      .eq('id', taskId);
  }

  /**
   * Get task dependencies
   */
  async getTaskDependencies(taskId: string): Promise<Task[]> {
    const task = await this.supabase
      .from('tasks')
      .select()
      .eq('id', taskId)
      .single();

    if (task.error) throw task.error;

    const dependencyIds = (task.data.metadata?.dependencies as string[]) || [];
    if (dependencyIds.length === 0) return [];

    const { data, error } = await this.supabase
      .from('tasks')
      .select()
      .in('id', dependencyIds);

    if (error) throw error;
    return data || [];
  }

  /**
   * Check if a task is blocked by uncompleted dependencies
   */
  async isTaskBlocked(taskId: string): Promise<boolean> {
    const dependencies = await this.getTaskDependencies(taskId);
    return dependencies.some(dep => dep.status !== 'done');
  }

  /**
   * Get tasks that are ready to start (no blocking dependencies)
   */
  async getReadyTasks(opts: {
    userId?: string;
  } = {}): Promise<Task[]> {
    const tasks = await this.getTasks({ status: 'pending', userId: opts.userId });
    const ready: Task[] = [];

    for (const task of tasks) {
      const blocked = await this.isTaskBlocked(task.id);
      if (!blocked) {
        ready.push(task);
      }
    }

    return ready;
  }

  // ============ TASK TEMPLATES ============

  /**
   * Create a task template
   */
  async createTaskTemplate(template: {
    name: string;
    description?: string;
    tasks: Array<{
      title: string;
      description?: string;
      priority?: number;
      estimatedDuration?: string;
      dependencies?: number[]; // Indexes of other tasks in this template
    }>;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    // Store as a special task with metadata flag
    const { data, error } = await this.supabase
      .from('tasks')
      .insert({
        agent_id: this.agentId,
        title: `[TEMPLATE] ${template.name}`,
        description: template.description,
        status: 'pending',
        priority: -1, // Templates have negative priority
        metadata: {
          is_template: true,
          template_data: template,
          ...template.metadata
        }
      })
      .select()
      .single();

    if (error) throw error;
    return { id: data.id };
  }

  /**
   * Get all task templates
   */
  async getTaskTemplates(): Promise<Array<{
    id: string;
    name: string;
    description?: string;
    tasks: Array<{
      title: string;
      description?: string;
      priority?: number;
      estimatedDuration?: string;
      dependencies?: number[];
    }>;
  }>> {
    const { data, error } = await this.supabase
      .from('tasks')
      .select()
      .eq('agent_id', this.agentId)
      .eq('metadata->>is_template', 'true');

    if (error) throw error;

    return (data || []).map(task => ({
      id: task.id,
      name: task.title.replace('[TEMPLATE] ', ''),
      description: task.description,
      tasks: (task.metadata?.template_data as any)?.tasks || []
    }));
  }

  /**
   * Apply a task template (create all tasks from template)
   */
  async applyTaskTemplate(templateId: string, opts: {
    userId?: string;
    startDate?: string;
    metadata?: Record<string, unknown>;
  } = {}): Promise<Task[]> {
    const template = await this.supabase
      .from('tasks')
      .select()
      .eq('id', templateId)
      .single();

    if (template.error) throw template.error;

    const templateData = template.data.metadata?.template_data as any;
    if (!templateData?.tasks) {
      throw new Error('Invalid template data');
    }

    const createdTasks: Task[] = [];
    const taskIdMap = new Map<number, string>(); // template index -> created task id

    // Create all tasks first
    for (let i = 0; i < templateData.tasks.length; i++) {
      const taskDef = templateData.tasks[i];
      
      let dueAt: string | undefined;
      if (opts.startDate && taskDef.estimatedDuration) {
        // Calculate due date based on start date + duration
        const start = new Date(opts.startDate);
        const durationHours = parseInt(taskDef.estimatedDuration) || 24;
        dueAt = new Date(start.getTime() + durationHours * 60 * 60 * 1000).toISOString();
      }

      const task = await this.createTask({
        title: taskDef.title,
        description: taskDef.description,
        priority: taskDef.priority || 0,
        dueAt,
        userId: opts.userId,
        metadata: {
          from_template: templateId,
          template_index: i,
          ...opts.metadata
        }
      });

      createdTasks.push(task);
      taskIdMap.set(i, task.id);
    }

    // Now add dependencies
    for (let i = 0; i < templateData.tasks.length; i++) {
      const taskDef = templateData.tasks[i];
      if (taskDef.dependencies && taskDef.dependencies.length > 0) {
        const taskId = taskIdMap.get(i);
        if (taskId) {
          for (const depIndex of taskDef.dependencies) {
            const depId = taskIdMap.get(depIndex);
            if (depId) {
              await this.addTaskDependency(taskId, depId);
            }
          }
        }
      }
    }

    return createdTasks;
  }

  // ============ TASK REMINDERS ============

  /**
   * Get tasks that need reminders (due soon but not done)
   */
  async getTasksNeedingReminders(opts: {
    userId?: string;
    hoursAhead?: number;
  } = {}): Promise<Array<Task & { timeUntilDue: number }>> {
    const tasks = await this.getUpcomingTasks({
      userId: opts.userId,
      hoursAhead: opts.hoursAhead || 24
    });

    const now = Date.now();
    return tasks.map(task => ({
      ...task,
      timeUntilDue: task.due_at ? new Date(task.due_at).getTime() - now : 0
    })).filter(task => task.timeUntilDue > 0);
  }

  /**
   * Format task reminder message
   */
  formatTaskReminder(task: Task, timeUntilDue: number): string {
    const hours = Math.floor(timeUntilDue / (60 * 60 * 1000));
    const minutes = Math.floor((timeUntilDue % (60 * 60 * 1000)) / (60 * 1000));
    
    let timeStr = '';
    if (hours > 0) {
      timeStr = `${hours}h ${minutes}m`;
    } else {
      timeStr = `${minutes}m`;
    }

    return `⏰ Task reminder: "${task.title}" is due in ${timeStr}\n${task.description || ''}`;
  }

  // ============ LEARNING PATTERN DETECTION ============

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
      const weekKey = weekStart.toISOString().split('T')[0];
      
      const existing = weekMap.get(weekKey) || { count: 0, severities: [] };
      existing.count++;
      existing.severities.push(l.severity);
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

  // ============ LEARNING SIMILARITY SEARCH ============

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
    const embedding = await this.generateEmbedding(text);

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
        lEmbedding = await this.generateEmbedding(lText);
        
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
        const similarity = this.cosineSimilarity(embedding, lEmbedding!);
        similarities.push({ ...l, similarity });
      }
    }

    return similarities
      .filter(s => s.similarity >= (opts.threshold || 0.7))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, opts.limit || 5);
  }

  // ============ LEARNING EXPORT/REPORT ============

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

  // ============ ENTITIES ============

  /**
   * Extract entities from text using AI
   */
  async extractEntities(text: string, opts: {
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
    const updateData: Record<string, unknown> = {};

    if (updates.name) updateData.name = updates.name;
    if (updates.aliases) updateData.aliases = updates.aliases;
    if (updates.description) updateData.description = updates.description;
    if (updates.properties) updateData.properties = updates.properties;
    if (updates.lastSeenAt) updateData.last_seen_at = updates.lastSeenAt;

    // Increment mention count
    const entity = await this.supabase
      .from('entities')
      .select()
      .eq('id', entityId)
      .single();

    if (entity.error) throw entity.error;

    updateData.mention_count = (entity.data.mention_count || 0) + 1;

    const { data, error } = await this.supabase
      .from('entities')
      .update(updateData)
      .eq('id', entityId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Find an entity by name or alias
   */
  async findEntity(nameOrAlias: string): Promise<Entity | null> {
    const { data, error } = await this.supabase
      .from('entities')
      .select()
      .eq('agent_id', this.agentId)
      .or(`name.ilike.${nameOrAlias},aliases.cs.{${nameOrAlias}}`)
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
      query = query.or(`name.ilike.%${opts.query}%,description.ilike.%${opts.query}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
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
    ].filter((v, i, a) => a.indexOf(v) === i); // Deduplicate

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

  // ============ CONTEXT ============

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
    const memories = await this.recall(query, {
      userId: opts.userId,
      limit: opts.maxMemories || 5
    });

    // Get recent messages from current session
    let recentMessages: Message[] = [];
    if (opts.sessionId) {
      recentMessages = await this.getMessages(opts.sessionId, {
        limit: opts.maxMessages || 20
      });
    }

    // Build context summary
    const memoryText = memories
      .map(m => `- ${m.content}`)
      .join('\n');

    const summary = memories.length > 0
      ? `Relevant memories:\n${memoryText}`
      : 'No relevant memories found.';

    return { memories, recentMessages, summary };
  }

  // ============ CONTEXT WINDOW MANAGEMENT ============

  /**
   * Build an optimized context window with token budgeting
   * Implements smart context selection and lost-in-middle mitigation
   */
  async buildOptimizedContext(opts: {
    query: string;
    sessionId?: string;
    userId?: string;
    modelContextSize?: number;
    model?: string; // Use predefined model budget
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
    const [messages, memories, learnings, entities] = await Promise.all([
      sessionId ? this.getMessages(sessionId) : Promise.resolve([]),
      this.recall(query, { userId, limit: 50 }),
      this.searchLearnings(query, { limit: 20 }),
      this.searchEntities({ query, limit: 15 })
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
        memoryCount: memories.length,
        learningCount: learnings.length,
        entityCount: entities.length
      });
    }

    // Build context window
    const window = buildContextWindow({
      messages,
      memories,
      learnings,
      entities,
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
    contextSize: string; // e.g., "32k", "128k"
  }> {
    const stats = await this.countSessionTokens(sessionId);
    
    // Get memories from this session
    const { data, error } = await this.supabase
      .from('memories')
      .select()
      .eq('source_session_id', sessionId);

    const memoryTokens = (data || []).reduce((sum, mem) => {
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

  // ============ MEMORY LIFECYCLE MANAGEMENT ============

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
          memories[i].embedding!,
          memories[j].embedding!
        );

        if (similarity >= threshold) {
          // Keep the more important/recent one
          const [keep, merge] = memories[i].importance >= memories[j].importance
            ? [memories[i], memories[j]]
            : [memories[j], memories[i]];
          
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
          ...(keep.metadata?.merged_from as string[] || []),
          merge.id
        ],
        merge_count: (keep.metadata?.merge_count as number || 0) + 1,
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

  /**
   * Auto-cleanup old sessions
   * Archive or delete sessions older than a threshold
   */
  async cleanupOldSessions(opts: {
    olderThanDays?: number; // Default 90 days
    action?: 'archive' | 'delete'; // Default 'archive'
    keepSummaries?: boolean; // Keep sessions with summaries
    userId?: string;
  } = {}): Promise<{ archived?: number; deleted?: number }> {
    const olderThanDays = opts.olderThanDays ?? 90;
    const action = opts.action ?? 'archive';
    const keepSummaries = opts.keepSummaries ?? true;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    let query = this.supabase
      .from('sessions')
      .select()
      .eq('agent_id', this.agentId)
      .lt('started_at', cutoffDate.toISOString());

    if (opts.userId) {
      query = query.eq('user_id', opts.userId);
    }

    if (keepSummaries) {
      query = query.is('summary', null);
    }

    const { data: sessions, error } = await query;
    if (error) throw error;

    if (!sessions || sessions.length === 0) {
      return action === 'delete' ? { deleted: 0 } : { archived: 0 };
    }

    if (action === 'delete') {
      // Delete sessions and their messages
      for (const session of sessions) {
        // Delete messages first
        await this.supabase
          .from('messages')
          .delete()
          .eq('session_id', session.id);

        // Delete session
        await this.supabase
          .from('sessions')
          .delete()
          .eq('id', session.id);
      }

      return { deleted: sessions.length };
    } else {
      // Archive by marking in metadata
      for (const session of sessions) {
        await this.supabase
          .from('sessions')
          .update({
            metadata: {
              ...session.metadata,
              archived: true,
              archived_at: new Date().toISOString()
            }
          })
          .eq('id', session.id);
      }

      return { archived: sessions.length };
    }
  }

  /**
   * Get cleanup statistics
   */
  async getCleanupStats(): Promise<{
    totalSessions: number;
    archivedSessions: number;
    oldSessions: number;
    totalMessages: number;
    orphanedMessages: number;
  }> {
    const { data: sessions, error: sessError } = await this.supabase
      .from('sessions')
      .select()
      .eq('agent_id', this.agentId);

    if (sessError) throw sessError;

    const totalSessions = sessions?.length || 0;
    const archivedSessions = sessions?.filter(s => s.metadata?.archived).length || 0;
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    const oldSessions = sessions?.filter(s => new Date(s.started_at) < cutoffDate).length || 0;

    const { data: messages, error: msgError } = await this.supabase
      .from('messages')
      .select()
      .in('session_id', sessions?.map(s => s.id) || []);

    if (msgError) throw msgError;

    const totalMessages = messages?.length || 0;

    // Find orphaned messages (messages without sessions)
    const { data: allMessages, error: allMsgError } = await this.supabase
      .from('messages')
      .select('id, session_id');

    if (allMsgError) throw allMsgError;

    const sessionIds = new Set(sessions?.map(s => s.id) || []);
    const orphanedMessages = allMessages?.filter(m => !sessionIds.has(m.session_id)).length || 0;

    return {
      totalSessions,
      archivedSessions,
      oldSessions,
      totalMessages,
      orphanedMessages
    };
  }
}

// Re-export context manager utilities
export {
  ContextBudget,
  ContextWindow,
  ContextItem,
  createContextBudget,
  createAdaptiveBudget,
  buildContextWindow,
  formatContextWindow,
  getContextStats,
  getBudgetForModel,
  estimateTokens,
  estimateTokensAccurate
} from './context-manager';

// Export Clawdbot integration
export {
  ClawdbotMemoryIntegration,
  ClawdbotConfig,
  MessageContext,
  createClawdbotIntegration,
  createLoggingMiddleware
} from './clawdbot-integration';

// Export error handling utilities
export {
  SupaclawError,
  DatabaseError,
  EmbeddingError,
  ValidationError,
  RateLimitError,
  RetryOptions,
  CircuitBreaker,
  retry,
  wrapDatabaseOperation,
  wrapEmbeddingOperation,
  validateInput,
  safeJsonParse,
  withTimeout,
  gracefulFallback,
  batchWithErrorHandling
} from './error-handling';

// Export hook client
export {
  createHookClient,
  SupaclawHookClient,
  HookClientConfig,
  MessageFilter,
  shouldLog,
} from './hook-client';

export default Supaclaw;
