import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

export interface OpenClawMemoryConfig {
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

export class OpenClawMemory {
  private supabase: SupabaseClient;
  private agentId: string;
  private config: OpenClawMemoryConfig;
  private openai?: OpenAI;

  constructor(config: OpenClawMemoryConfig) {
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
        'Tables not found. Run migrations first: npx openclaw-memory migrate'
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
   * End a session with optional summary
   */
  async endSession(sessionId: string, opts: {
    summary?: string;
    autoSummarize?: boolean;
  } = {}): Promise<Session> {
    let summary = opts.summary;

    // Auto-generate summary if requested
    if (opts.autoSummarize && !summary && this.openai) {
      summary = await this.generateSessionSummary(sessionId);
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
  async generateSessionSummary(sessionId: string): Promise<string> {
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
      model: 'gpt-4o-mini',
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
   * Get entity relationship suggestions
   * (Simple implementation - checks co-occurrence in same sessions)
   */
  async getEntityRelationships(entityId: string, opts: {
    limit?: number;
  } = {}): Promise<Array<{ entity: Entity; cooccurrenceCount: number }>> {
    // This is a simplified version - a real implementation would track relationships in a separate table
    const entity = await this.supabase
      .from('entities')
      .select()
      .eq('id', entityId)
      .single();

    if (entity.error) throw entity.error;

    // For now, return empty array
    // TODO: Implement relationship tracking table
    return [];
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
}

export default OpenClawMemory;
