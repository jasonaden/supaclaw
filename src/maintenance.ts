import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { wrapDatabaseOperation } from './error-handling';
import type { SupaclawDeps, SupaclawConfig } from './types';

export class MaintenanceManager {
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
   * Auto-cleanup old sessions
   * Archive or delete sessions older than a threshold
   */
  async cleanupOldSessions(opts: {
    olderThanDays?: number; // Default 90 days
    action?: 'archive' | 'delete'; // Default 'archive'
    keepSummaries?: boolean; // Keep sessions with summaries
    userId?: string;
  } = {}): Promise<{ archived?: number; deleted?: number }> {
    return wrapDatabaseOperation(async () => {
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
    }, 'cleanupOldSessions');
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
    return wrapDatabaseOperation(async () => {
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
    }, 'getCleanupStats');
  }
}
