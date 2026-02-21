import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { wrapDatabaseOperation } from './error-handling';
import type { SupaclawDeps, SupaclawConfig, Session, Message, Memory } from './types';

export class SessionManager {
  private supabase: SupabaseClient;
  private agentId: string;
  private config: SupaclawConfig;
  private openai?: OpenAI;

  /**
   * Optional callback used by extractMemoriesFromSession to persist memories.
   * Injected from deps in the constructor.
   */
  private rememberFn?: (memory: {
    content: string;
    category?: string;
    importance?: number;
    userId?: string;
    sessionId?: string;
    expiresAt?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<Memory>;

  constructor(deps: SupaclawDeps) {
    this.supabase = deps.supabase;
    this.agentId = deps.agentId;
    this.config = deps.config;
    this.openai = deps.openai;
    this.rememberFn = deps.rememberFn;
  }

  /**
   * Start a new conversation session
   */
  async startSession(opts: {
    userId?: string;
    channel?: string;
    metadata?: Record<string, unknown>;
  } = {}): Promise<Session> {
    return wrapDatabaseOperation(async () => {
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
    }, 'startSession');
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

    return wrapDatabaseOperation(async () => {
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
    }, 'endSession');
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
    const contextParts: string[] = [];
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
        currentRole = roleMatch[1]!.toLowerCase() as typeof currentRole;
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
          if (!this.rememberFn) {
            throw new Error('rememberFn not wired — use the Supaclaw facade');
          }
          const memory = await this.rememberFn({
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
        // Rough estimation: 1 token ~ 4 characters
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

  /**
   * Add a message to a session
   */
  async addMessage(sessionId: string, message: {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    tokenCount?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Message> {
    return wrapDatabaseOperation(async () => {
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
    }, 'addMessage');
  }

  /**
   * Get messages from a session
   */
  async getMessages(sessionId: string, opts: {
    limit?: number;
    offset?: number;
  } = {}): Promise<Message[]> {
    return wrapDatabaseOperation(async () => {
      const { data, error } = await this.supabase
        .from('messages')
        .select()
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
        .range(opts.offset || 0, (opts.offset || 0) + (opts.limit || 100) - 1);

      if (error) throw error;
      return data || [];
    }, 'getMessages');
  }
}
