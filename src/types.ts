import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';

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

/** Item within a task template's tasks array */
export interface TaskTemplateItem {
  title: string;
  description?: string;
  priority?: number;
  estimatedDuration?: string;
  dependencies?: number[];
}

/** Dependency injection container for domain managers */
export interface SupaclawDeps {
  supabase: SupabaseClient;
  agentId: string;
  openai?: OpenAI;
  config: SupaclawConfig;
}
