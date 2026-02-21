import * as fs from 'fs';
import { Supaclaw, type SupaclawConfig } from './index';

export interface MessageFilter {
  skipPatterns?: string[];
  skipPrefixes?: string[];
  minLength?: number;
  skipRoles?: string[];
}

export interface HookClientConfig {
  configPath?: string;
  supabaseUrl?: string;
  supabaseKey?: string;
  agentId?: string;
  openaiApiKey?: string;
  embeddingProvider?: SupaclawConfig['embeddingProvider'];
  embeddingModel?: string;
  geminiApiKey?: string;

  messageFilter?: MessageFilter;
  batchMode?: boolean;
  flushIntervalMs?: number;
  maxBatchSize?: number;
}

interface BufferedMessage {
  sessionId: string;
  role: string;
  content: string;
  metadata: Record<string, unknown>;
}

/**
 * Check if a message should be logged based on filter rules.
 * Returns true if the message passes all filters.
 */
export function shouldLog(
  content: string,
  role: string,
  filter: MessageFilter | undefined
): boolean {
  if (!filter) return true;

  if (filter.skipRoles?.includes(role)) {
    return false;
  }

  if (filter.minLength !== undefined && content.length < filter.minLength) {
    return false;
  }

  if (filter.skipPrefixes?.some(prefix => content.startsWith(prefix))) {
    return false;
  }

  if (filter.skipPatterns?.some(pattern => new RegExp(pattern).test(content))) {
    return false;
  }

  return true;
}

export class SupaclawHookClient {
  private supaclaw: Supaclaw;
  private filter?: MessageFilter;
  private batchMode: boolean;
  private flushIntervalMs: number;
  private maxBatchSize: number;
  private buffer: BufferedMessage[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;

  constructor(supaclaw: Supaclaw, config: HookClientConfig) {
    this.supaclaw = supaclaw;
    this.filter = config.messageFilter;
    this.batchMode = config.batchMode ?? false;
    this.flushIntervalMs = config.flushIntervalMs ?? 5000;
    this.maxBatchSize = config.maxBatchSize ?? 20;

    if (this.batchMode) {
      this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    }
  }

  shouldLog(content: string, role: string): boolean {
    return shouldLog(content, role, this.filter);
  }

  async getOrCreateSession(
    externalKey: string,
    opts?: { channel?: string; userId?: string; metadata?: Record<string, unknown> }
  ): Promise<{ id: string; isNew: boolean }> {
    return this.supaclaw.getOrCreateSession(externalKey, opts);
  }

  async logMessage(
    sessionId: string,
    role: string,
    content: string,
    opts: {
      channel?: string;
      timestamp?: string;
      autoRemember?: boolean;
      minRememberLength?: number;
      rememberImportance?: number;
      [key: string]: unknown;
    } = {}
  ): Promise<void> {
    if (!this.shouldLog(content, role)) return;

    const { autoRemember, minRememberLength, rememberImportance, ...rest } = opts;
    const metadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      metadata[k] = v;
    }

    if (this.batchMode) {
      this.buffer.push({ sessionId, role, content, metadata });
      if (this.buffer.length >= this.maxBatchSize) {
        await this.flush();
      }
    } else {
      await this.supaclaw.addMessage(sessionId, {
        role: role as 'user' | 'assistant' | 'system' | 'tool',
        content,
        metadata,
      });
    }

    // Auto-remember if enabled and message is substantial
    if (autoRemember) {
      const minLen = minRememberLength ?? 50;
      if (content.length >= minLen) {
        await this.supaclaw.remember({
          content,
          category: 'conversation',
          importance: rememberImportance ?? 0.5,
          sessionId,
        });
      }
    }
  }

  async endSession(
    sessionId: string,
    opts: {
      autoSummarize?: boolean;
      summarizeModel?: string;
    } = {}
  ): Promise<void> {
    // Flush any buffered messages for this session first
    if (this.batchMode && this.buffer.length > 0) {
      await this.flush();
    }

    // Check if session is already ended (idempotent)
    const session = await this.supaclaw.getSession(sessionId);
    if (!session || session.ended_at) return;

    await this.supaclaw.endSession(sessionId, {
      autoSummarize: opts.autoSummarize,
      summarizeModel: opts.summarizeModel,
    });
  }

  async getRelevantContext(
    _query: string,
    _opts?: Record<string, unknown>
  ): Promise<string> {
    // Implemented in Task 10
    throw new Error('Not implemented');
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const messages = [...this.buffer];
    this.buffer = [];

    for (const msg of messages) {
      await this.supaclaw.addMessage(msg.sessionId, {
        role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
        content: msg.content,
        metadata: msg.metadata,
      });
    }
  }

  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flush();
  }
}

/**
 * Create a hook client for OpenClaw gateway integration.
 * Reads config from .supaclaw.json if configPath provided,
 * merges with explicit options (explicit wins).
 */
export function createHookClient(config: HookClientConfig): SupaclawHookClient {
  let resolved = { ...config };

  if (config.configPath) {
    const fileContent = fs.readFileSync(config.configPath, 'utf-8');
    const fileConfig = JSON.parse(fileContent);
    // File config as base, explicit options override
    resolved = { ...fileConfig, ...config };
  }

  if (!resolved.supabaseUrl) throw new Error('supabaseUrl is required');
  if (!resolved.supabaseKey) throw new Error('supabaseKey is required');
  if (!resolved.agentId) throw new Error('agentId is required');

  const supaclaw = new Supaclaw({
    supabaseUrl: resolved.supabaseUrl,
    supabaseKey: resolved.supabaseKey,
    agentId: resolved.agentId,
    openaiApiKey: resolved.openaiApiKey,
    embeddingProvider: resolved.embeddingProvider,
    embeddingModel: resolved.embeddingModel,
    geminiApiKey: resolved.geminiApiKey,
  });

  return new SupaclawHookClient(supaclaw, resolved);
}
