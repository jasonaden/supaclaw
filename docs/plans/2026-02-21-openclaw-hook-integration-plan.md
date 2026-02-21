# OpenClaw Hook Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a hook client API and Supabase Edge Function webhook receiver so OpenClaw hooks and external services can auto-log conversations and manage sessions.

**Architecture:** New `SupaclawHookClient` class in `src/hook-client.ts` wraps the existing `Supaclaw` class, adding batching, filtering, and external-key session management. Supabase Edge Functions provide an HTTP webhook API with per-source secret authentication. Both paths share the same DB schema.

**Tech Stack:** TypeScript (strict), Supabase (Postgres + Edge Functions/Deno), vitest, OpenAI (summarization)

**Design doc:** `docs/plans/2026-02-21-openclaw-hook-integration-design.md`

---

## Phase 1: Database & Core Changes

### Task 1: Migration — `external_key` on sessions

**Files:**
- Create: `supabase/migrations/20260221100001_add_external_key.sql`

**Step 1: Write the migration**

```sql
-- Add external_key column for hook-based session lookup
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS external_key TEXT;

-- Partial unique index: only one active session per external key
CREATE UNIQUE INDEX IF NOT EXISTS sessions_external_key_active_idx
  ON sessions(external_key) WHERE ended_at IS NULL;
```

**Step 2: Commit**

```bash
git add supabase/migrations/20260221100001_add_external_key.sql
git commit -m "migration: add external_key column to sessions"
```

---

### Task 2: Migration — `webhook_sources` table

**Files:**
- Create: `supabase/migrations/20260221100002_create_webhook_sources.sql`

**Step 1: Write the migration**

```sql
-- Webhook sources: authorized external integrations
CREATE TABLE IF NOT EXISTS webhook_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  allowed_actions TEXT[] DEFAULT ARRAY['log_message', 'end_session', 'get_or_create_session'],
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_sources_agent_id_idx ON webhook_sources(agent_id);
CREATE INDEX IF NOT EXISTS webhook_sources_enabled_idx ON webhook_sources(enabled) WHERE enabled = true;
```

**Step 2: Commit**

```bash
git add supabase/migrations/20260221100002_create_webhook_sources.sql
git commit -m "migration: add webhook_sources table"
```

---

### Task 3: Add `getOrCreateSession` to Supaclaw class

This method is needed by both the JS hook client and the Edge Function, so it belongs on the core class.

**Files:**
- Test: `tests/hook-client.test.ts` (start the file)
- Modify: `src/index.ts:240-258` (sessions section)

**Step 1: Write the failing test**

Create `tests/hook-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Supaclaw } from '../src/index';

// Mock Supabase client
function createMockSupabase() {
  const mockChain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    single: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(),
  };

  return {
    from: vi.fn().mockReturnValue(mockChain),
    rpc: vi.fn(),
    _chain: mockChain,
  };
}

// Helper to create Supaclaw with mocked Supabase
function createTestSupaclaw(mockSupabase: ReturnType<typeof createMockSupabase>) {
  const supaclaw = new Supaclaw({
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    agentId: 'test-agent',
  });
  // Replace internal supabase client with mock
  (supaclaw as any).supabase = mockSupabase;
  return supaclaw;
}

describe('Supaclaw.getOrCreateSession', () => {
  let mockSupabase: ReturnType<typeof createMockSupabase>;
  let supaclaw: Supaclaw;

  beforeEach(() => {
    mockSupabase = createMockSupabase();
    supaclaw = createTestSupaclaw(mockSupabase);
  });

  it('should return existing active session when found', async () => {
    const existingSession = {
      id: 'existing-uuid',
      agent_id: 'test-agent',
      external_key: 'agent:nix:main',
      started_at: '2026-02-21T00:00:00Z',
      ended_at: null,
      metadata: {},
    };

    mockSupabase._chain.maybeSingle.mockResolvedValue({
      data: existingSession,
      error: null,
    });

    const result = await supaclaw.getOrCreateSession('agent:nix:main');

    expect(result).toEqual({ id: 'existing-uuid', isNew: false });
    expect(mockSupabase.from).toHaveBeenCalledWith('sessions');
  });

  it('should create new session when none found', async () => {
    // First call: lookup returns null
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    // Second call: insert returns new session
    mockSupabase._chain.single.mockResolvedValueOnce({
      data: {
        id: 'new-uuid',
        agent_id: 'test-agent',
        external_key: 'agent:nix:main',
        started_at: '2026-02-21T00:00:00Z',
        metadata: { source: 'openclaw' },
      },
      error: null,
    });

    const result = await supaclaw.getOrCreateSession('agent:nix:main', {
      channel: 'telegram',
      userId: 'jason',
      metadata: { source: 'openclaw' },
    });

    expect(result).toEqual({ id: 'new-uuid', isNew: true });
  });

  it('should pass channel and userId when creating new session', async () => {
    mockSupabase._chain.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });

    mockSupabase._chain.single.mockResolvedValueOnce({
      data: { id: 'new-uuid', agent_id: 'test-agent' },
      error: null,
    });

    await supaclaw.getOrCreateSession('key', {
      channel: 'discord',
      userId: 'user123',
    });

    // Verify insert was called with correct args
    expect(mockSupabase._chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: 'test-agent',
        external_key: 'key',
        channel: 'discord',
        user_id: 'user123',
      })
    );
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: FAIL — `getOrCreateSession is not a function`

**Step 3: Implement `getOrCreateSession` on Supaclaw**

Add to `src/index.ts` after the `startSession` method (after line 258):

```typescript
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/hook-client.test.ts src/index.ts
git commit -m "feat: add getOrCreateSession to Supaclaw class"
```

---

### Task 4: Add `summarizeModel` support to `endSession`

Currently `generateSessionSummary` hardcodes `gpt-4o-mini`. We need to allow overriding the model.

**Files:**
- Test: `tests/hook-client.test.ts` (append)
- Modify: `src/index.ts:263-319` (endSession + generateSessionSummary)

**Step 1: Write the failing test**

Append to `tests/hook-client.test.ts`:

```typescript
describe('Supaclaw.endSession with summarizeModel', () => {
  let mockSupabase: ReturnType<typeof createMockSupabase>;
  let supaclaw: Supaclaw;

  beforeEach(() => {
    mockSupabase = createMockSupabase();
    supaclaw = new Supaclaw({
      supabaseUrl: 'http://localhost:54321',
      supabaseKey: 'test-key',
      agentId: 'test-agent',
      openaiApiKey: 'test-openai-key',
    });
    (supaclaw as any).supabase = mockSupabase;
  });

  it('should accept summarizeModel option', async () => {
    // Mock getMessages to return some messages
    const getMessagesSpy = vi.spyOn(supaclaw, 'getMessages').mockResolvedValue([
      { id: '1', session_id: 's1', role: 'user', content: 'Hello', created_at: '', metadata: {} },
    ]);

    // Mock OpenAI
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'Summary of conversation' } }],
    });
    (supaclaw as any).openai = { chat: { completions: { create: mockCreate } } };

    // Mock the update
    mockSupabase._chain.single.mockResolvedValue({
      data: { id: 's1', ended_at: '2026-02-21T00:00:00Z', summary: 'Summary of conversation' },
      error: null,
    });

    await supaclaw.endSession('s1', {
      autoSummarize: true,
      summarizeModel: 'gpt-4o',
    });

    // Verify the model was passed to OpenAI
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-4o' })
    );

    getMessagesSpy.mockRestore();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: FAIL — endSession does not accept `summarizeModel`

**Step 3: Update `endSession` and `generateSessionSummary` signatures**

In `src/index.ts`, modify `endSession` (around line 263):

```typescript
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
```

Modify `generateSessionSummary` (around line 291):

```typescript
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
```

(Rest of the method stays the same.)

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/hook-client.test.ts src/index.ts
git commit -m "feat: add summarizeModel option to endSession"
```

---

## Phase 2: Hook Client

### Task 5: Message filtering — `shouldLog`

Pure function, no DB dependencies. Good TDD starter.

**Files:**
- Test: `tests/hook-client.test.ts` (append)
- Create: `src/hook-client.ts` (start the file)

**Step 1: Write the failing tests**

Append to `tests/hook-client.test.ts`:

```typescript
import { shouldLog, type MessageFilter } from '../src/hook-client';

describe('shouldLog', () => {
  it('should return true when no filter is configured', () => {
    expect(shouldLog('Hello world', 'user', undefined)).toBe(true);
  });

  it('should return true when message passes all filters', () => {
    const filter: MessageFilter = {
      skipPatterns: ['HEARTBEAT'],
      skipPrefixes: ['[System]'],
      minLength: 1,
      skipRoles: ['system'],
    };
    expect(shouldLog('Hello world', 'user', filter)).toBe(true);
  });

  it('should filter by skipPatterns (regex match)', () => {
    const filter: MessageFilter = { skipPatterns: ['NO_REPLY', 'HEARTBEAT_OK'] };
    expect(shouldLog('NO_REPLY', 'user', filter)).toBe(false);
    expect(shouldLog('Status: HEARTBEAT_OK received', 'user', filter)).toBe(false);
    expect(shouldLog('Hello world', 'user', filter)).toBe(true);
  });

  it('should filter by skipPrefixes', () => {
    const filter: MessageFilter = { skipPrefixes: ['[System Message]', '[Bot]'] };
    expect(shouldLog('[System Message] Restarting...', 'user', filter)).toBe(false);
    expect(shouldLog('[Bot] Auto-reply', 'user', filter)).toBe(false);
    expect(shouldLog('Hello world', 'user', filter)).toBe(true);
  });

  it('should filter by minLength', () => {
    const filter: MessageFilter = { minLength: 5 };
    expect(shouldLog('Hi', 'user', filter)).toBe(false);
    expect(shouldLog('Hello world', 'user', filter)).toBe(true);
    expect(shouldLog('', 'user', filter)).toBe(false);
  });

  it('should filter by skipRoles', () => {
    const filter: MessageFilter = { skipRoles: ['system', 'tool'] };
    expect(shouldLog('Hello', 'system', filter)).toBe(false);
    expect(shouldLog('Result', 'tool', filter)).toBe(false);
    expect(shouldLog('Hello', 'user', filter)).toBe(true);
    expect(shouldLog('Hello', 'assistant', filter)).toBe(true);
  });

  it('should handle combined filters (all must pass)', () => {
    const filter: MessageFilter = {
      skipPatterns: ['HEARTBEAT'],
      skipPrefixes: ['[System]'],
      minLength: 3,
      skipRoles: ['tool'],
    };
    // Passes all
    expect(shouldLog('Hello world', 'user', filter)).toBe(true);
    // Fails minLength
    expect(shouldLog('Hi', 'user', filter)).toBe(false);
    // Fails pattern
    expect(shouldLog('HEARTBEAT ping', 'user', filter)).toBe(false);
    // Fails prefix
    expect(shouldLog('[System] reboot', 'user', filter)).toBe(false);
    // Fails role
    expect(shouldLog('Hello world', 'tool', filter)).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: FAIL — cannot import `shouldLog` from `../src/hook-client`

**Step 3: Implement `shouldLog` and types**

Create `src/hook-client.ts`:

```typescript
export interface MessageFilter {
  skipPatterns?: string[];
  skipPrefixes?: string[];
  minLength?: number;
  skipRoles?: string[];
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hook-client.ts tests/hook-client.test.ts
git commit -m "feat: add shouldLog message filtering"
```

---

### Task 6: `createHookClient` factory + config resolution

**Files:**
- Test: `tests/hook-client.test.ts` (append)
- Modify: `src/hook-client.ts`

**Step 1: Write the failing tests**

Append to `tests/hook-client.test.ts`:

```typescript
import { createHookClient, type HookClientConfig } from '../src/hook-client';
import * as fs from 'fs';

vi.mock('fs');

describe('createHookClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should create client with explicit config', () => {
    const client = createHookClient({
      supabaseUrl: 'http://localhost:54321',
      supabaseKey: 'test-key',
      agentId: 'test-agent',
    });

    expect(client).toBeDefined();
    expect(typeof client.getOrCreateSession).toBe('function');
    expect(typeof client.logMessage).toBe('function');
    expect(typeof client.endSession).toBe('function');
    expect(typeof client.shouldLog).toBe('function');
    expect(typeof client.flush).toBe('function');
    expect(typeof client.destroy).toBe('function');
  });

  it('should create client from configPath', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      supabaseUrl: 'http://from-config:54321',
      supabaseKey: 'config-key',
      agentId: 'config-agent',
    }));

    const client = createHookClient({
      configPath: '/path/to/.supaclaw.json',
    });

    expect(client).toBeDefined();
    expect(fs.readFileSync).toHaveBeenCalledWith('/path/to/.supaclaw.json', 'utf-8');
  });

  it('should merge configPath with explicit options (explicit wins)', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      supabaseUrl: 'http://from-config:54321',
      supabaseKey: 'config-key',
      agentId: 'config-agent',
    }));

    const client = createHookClient({
      configPath: '/path/to/.supaclaw.json',
      agentId: 'explicit-agent',
    });

    expect(client).toBeDefined();
    // We'll verify the agentId was overridden in integration tests
  });

  it('should throw if no supabaseUrl provided', () => {
    expect(() => createHookClient({
      supabaseKey: 'key',
      agentId: 'agent',
    })).toThrow(/supabaseUrl/);
  });

  it('should throw if no supabaseKey provided', () => {
    expect(() => createHookClient({
      supabaseUrl: 'http://localhost',
      agentId: 'agent',
    })).toThrow(/supabaseKey/);
  });

  it('should throw if no agentId provided', () => {
    expect(() => createHookClient({
      supabaseUrl: 'http://localhost',
      supabaseKey: 'key',
    })).toThrow(/agentId/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: FAIL — `createHookClient` not exported

**Step 3: Implement `createHookClient` factory and `SupaclawHookClient` class skeleton**

Add to `src/hook-client.ts`:

```typescript
import * as fs from 'fs';
import { Supaclaw, type SupaclawConfig } from './index';

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
    _sessionId: string,
    _role: string,
    _content: string,
    _opts?: Record<string, unknown>
  ): Promise<void> {
    // Implemented in Task 7
    throw new Error('Not implemented');
  }

  async endSession(
    _sessionId: string,
    _opts?: Record<string, unknown>
  ): Promise<void> {
    // Implemented in Task 8
    throw new Error('Not implemented');
  }

  async getRelevantContext(
    _query: string,
    _opts?: Record<string, unknown>
  ): Promise<string> {
    // Implemented in Task 10
    throw new Error('Not implemented');
  }

  async flush(): Promise<void> {
    // Implemented in Task 9
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hook-client.ts tests/hook-client.test.ts
git commit -m "feat: add createHookClient factory with config resolution"
```

---

### Task 7: `logMessage` — immediate mode

**Files:**
- Test: `tests/hook-client.test.ts` (append)
- Modify: `src/hook-client.ts`

**Step 1: Write the failing tests**

Append to `tests/hook-client.test.ts`:

```typescript
describe('SupaclawHookClient.logMessage', () => {
  let client: SupaclawHookClient;
  let mockSupaclaw: any;

  beforeEach(() => {
    mockSupaclaw = {
      addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
      remember: vi.fn().mockResolvedValue({ id: 'mem-1' }),
      getOrCreateSession: vi.fn(),
    };

    client = new SupaclawHookClient(mockSupaclaw, {
      messageFilter: {
        skipPatterns: ['HEARTBEAT'],
        minLength: 1,
      },
    });
  });

  it('should log a message in immediate mode', async () => {
    await client.logMessage('session-1', 'user', 'Hello world');

    expect(mockSupaclaw.addMessage).toHaveBeenCalledWith('session-1', {
      role: 'user',
      content: 'Hello world',
      metadata: {},
    });
  });

  it('should skip filtered messages', async () => {
    await client.logMessage('session-1', 'user', 'HEARTBEAT ping');

    expect(mockSupaclaw.addMessage).not.toHaveBeenCalled();
  });

  it('should skip empty messages', async () => {
    await client.logMessage('session-1', 'user', '');

    expect(mockSupaclaw.addMessage).not.toHaveBeenCalled();
  });

  it('should pass metadata through', async () => {
    await client.logMessage('session-1', 'user', 'Hello', {
      channel: 'telegram',
      timestamp: '2026-02-21T00:00:00Z',
    });

    expect(mockSupaclaw.addMessage).toHaveBeenCalledWith('session-1', {
      role: 'user',
      content: 'Hello',
      metadata: { channel: 'telegram', timestamp: '2026-02-21T00:00:00Z' },
    });
  });

  it('should auto-remember substantial messages when enabled', async () => {
    await client.logMessage('session-1', 'user', 'This is a substantial message that should be remembered for later use', {
      autoRemember: true,
      minRememberLength: 20,
      rememberImportance: 0.7,
    });

    expect(mockSupaclaw.remember).toHaveBeenCalledWith({
      content: 'This is a substantial message that should be remembered for later use',
      category: 'conversation',
      importance: 0.7,
      sessionId: 'session-1',
    });
  });

  it('should NOT auto-remember short messages', async () => {
    await client.logMessage('session-1', 'user', 'ok', {
      autoRemember: true,
      minRememberLength: 50,
    });

    expect(mockSupaclaw.remember).not.toHaveBeenCalled();
  });

  it('should use default minRememberLength of 50', async () => {
    await client.logMessage('session-1', 'user', 'Short msg', {
      autoRemember: true,
    });

    // 9 chars < 50 default
    expect(mockSupaclaw.remember).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: FAIL — `logMessage` throws "Not implemented"

**Step 3: Implement `logMessage`**

Replace the `logMessage` stub in `src/hook-client.ts`:

```typescript
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hook-client.ts tests/hook-client.test.ts
git commit -m "feat: implement logMessage with filtering and auto-remember"
```

---

### Task 8: `endSession` wrapper (idempotent)

**Files:**
- Test: `tests/hook-client.test.ts` (append)
- Modify: `src/hook-client.ts`

**Step 1: Write the failing tests**

Append to `tests/hook-client.test.ts`:

```typescript
describe('SupaclawHookClient.endSession', () => {
  let client: SupaclawHookClient;
  let mockSupaclaw: any;

  beforeEach(() => {
    mockSupaclaw = {
      endSession: vi.fn().mockResolvedValue({ id: 's1', ended_at: '2026-02-21' }),
      getSession: vi.fn(),
      addMessage: vi.fn(),
      remember: vi.fn(),
      getOrCreateSession: vi.fn(),
    };

    client = new SupaclawHookClient(mockSupaclaw, {});
  });

  it('should delegate to supaclaw.endSession', async () => {
    mockSupaclaw.getSession.mockResolvedValue({
      id: 's1',
      ended_at: null,
    });

    await client.endSession('s1', { autoSummarize: true });

    expect(mockSupaclaw.endSession).toHaveBeenCalledWith('s1', {
      autoSummarize: true,
      summarizeModel: undefined,
    });
  });

  it('should pass summarizeModel through', async () => {
    mockSupaclaw.getSession.mockResolvedValue({
      id: 's1',
      ended_at: null,
    });

    await client.endSession('s1', {
      autoSummarize: true,
      summarizeModel: 'gpt-4o',
    });

    expect(mockSupaclaw.endSession).toHaveBeenCalledWith('s1', {
      autoSummarize: true,
      summarizeModel: 'gpt-4o',
    });
  });

  it('should be idempotent — no-op if session already ended', async () => {
    mockSupaclaw.getSession.mockResolvedValue({
      id: 's1',
      ended_at: '2026-02-21T00:00:00Z',
    });

    await client.endSession('s1');

    expect(mockSupaclaw.endSession).not.toHaveBeenCalled();
  });

  it('should flush buffer before ending session', async () => {
    const batchClient = new SupaclawHookClient(mockSupaclaw, { batchMode: true });
    mockSupaclaw.getSession.mockResolvedValue({ id: 's1', ended_at: null });

    // Add a message to the buffer
    (batchClient as any).buffer.push({
      sessionId: 's1',
      role: 'user',
      content: 'buffered msg',
      metadata: {},
    });

    await batchClient.endSession('s1');

    expect(mockSupaclaw.addMessage).toHaveBeenCalled();
    expect(mockSupaclaw.endSession).toHaveBeenCalled();

    await batchClient.destroy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: FAIL — endSession throws "Not implemented"

**Step 3: Implement `endSession`**

Replace the `endSession` stub in `src/hook-client.ts`:

```typescript
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
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hook-client.ts tests/hook-client.test.ts
git commit -m "feat: implement idempotent endSession on hook client"
```

---

### Task 9: Batch mode

**Files:**
- Test: `tests/hook-client.test.ts` (append)
- Modify: `src/hook-client.ts`

**Step 1: Write the failing tests**

Append to `tests/hook-client.test.ts`:

```typescript
describe('Batch mode', () => {
  let mockSupaclaw: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSupaclaw = {
      addMessage: vi.fn().mockResolvedValue({ id: 'msg-1' }),
      remember: vi.fn(),
      getSession: vi.fn(),
      endSession: vi.fn(),
      getOrCreateSession: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should buffer messages instead of inserting immediately', async () => {
    const client = new SupaclawHookClient(mockSupaclaw, {
      batchMode: true,
      maxBatchSize: 10,
    });

    await client.logMessage('s1', 'user', 'Hello');
    await client.logMessage('s1', 'assistant', 'Hi there');

    // Not flushed yet
    expect(mockSupaclaw.addMessage).not.toHaveBeenCalled();

    await client.destroy();
  });

  it('should flush when buffer hits maxBatchSize', async () => {
    const client = new SupaclawHookClient(mockSupaclaw, {
      batchMode: true,
      maxBatchSize: 3,
    });

    await client.logMessage('s1', 'user', 'Msg 1');
    await client.logMessage('s1', 'user', 'Msg 2');
    expect(mockSupaclaw.addMessage).not.toHaveBeenCalled();

    await client.logMessage('s1', 'user', 'Msg 3'); // triggers flush
    expect(mockSupaclaw.addMessage).toHaveBeenCalledTimes(3);

    await client.destroy();
  });

  it('should flush on timer interval', async () => {
    const client = new SupaclawHookClient(mockSupaclaw, {
      batchMode: true,
      flushIntervalMs: 5000,
      maxBatchSize: 100,
    });

    await client.logMessage('s1', 'user', 'Hello');

    expect(mockSupaclaw.addMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5000);
    // Need to wait for the async flush
    await vi.runAllTimersAsync();

    expect(mockSupaclaw.addMessage).toHaveBeenCalledTimes(1);

    await client.destroy();
  });

  it('should flush remaining on destroy', async () => {
    const client = new SupaclawHookClient(mockSupaclaw, {
      batchMode: true,
      maxBatchSize: 100,
    });

    await client.logMessage('s1', 'user', 'Msg 1');
    await client.logMessage('s1', 'user', 'Msg 2');

    expect(mockSupaclaw.addMessage).not.toHaveBeenCalled();

    await client.destroy();

    expect(mockSupaclaw.addMessage).toHaveBeenCalledTimes(2);
  });

  it('should not fail when flushing empty buffer', async () => {
    const client = new SupaclawHookClient(mockSupaclaw, { batchMode: true });

    await client.flush(); // should not throw

    expect(mockSupaclaw.addMessage).not.toHaveBeenCalled();

    await client.destroy();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: FAIL — batch mode doesn't buffer (flush doesn't insert buffered messages)

**Step 3: Implement flush**

Replace the `flush` stub in `src/hook-client.ts`:

```typescript
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const messages = [...this.buffer];
    this.buffer = [];

    // Insert all buffered messages
    for (const msg of messages) {
      await this.supaclaw.addMessage(msg.sessionId, {
        role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
        content: msg.content,
        metadata: msg.metadata,
      });
    }
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hook-client.ts tests/hook-client.test.ts
git commit -m "feat: implement batch mode with timer + size flush"
```

---

### Task 10: Context injection — `getRelevantContext`

**Files:**
- Test: `tests/hook-client.test.ts` (append)
- Modify: `src/hook-client.ts`

**Step 1: Write the failing tests**

Append to `tests/hook-client.test.ts`:

```typescript
describe('SupaclawHookClient.getRelevantContext', () => {
  let client: SupaclawHookClient;
  let mockSupaclaw: any;

  beforeEach(() => {
    mockSupaclaw = {
      hybridRecall: vi.fn().mockResolvedValue([
        { content: 'User prefers TypeScript', category: 'preference', importance: 0.8 },
        { content: 'We chose Supabase over Firebase', category: 'decision', importance: 0.9 },
      ]),
      recall: vi.fn().mockResolvedValue([
        { content: 'User prefers TypeScript', category: 'preference', importance: 0.8 },
      ]),
      addMessage: vi.fn(),
      remember: vi.fn(),
      getSession: vi.fn(),
      endSession: vi.fn(),
      getOrCreateSession: vi.fn(),
    };

    client = new SupaclawHookClient(mockSupaclaw, {});
  });

  it('should return formatted markdown from hybrid recall', async () => {
    const result = await client.getRelevantContext('What stack are we using?');

    expect(result).toContain('## Relevant Memories');
    expect(result).toContain('[preference]');
    expect(result).toContain('User prefers TypeScript');
    expect(result).toContain('[decision]');
    expect(result).toContain('We chose Supabase over Firebase');
  });

  it('should pass limit to recall', async () => {
    await client.getRelevantContext('query', { limit: 3 });

    expect(mockSupaclaw.hybridRecall).toHaveBeenCalledWith(
      'query',
      expect.objectContaining({ limit: 3 })
    );
  });

  it('should use keyword mode when specified', async () => {
    await client.getRelevantContext('query', { mode: 'keyword' });

    expect(mockSupaclaw.recall).toHaveBeenCalled();
    expect(mockSupaclaw.hybridRecall).not.toHaveBeenCalled();
  });

  it('should return empty string when no memories found', async () => {
    mockSupaclaw.hybridRecall.mockResolvedValue([]);

    const result = await client.getRelevantContext('unknown topic');

    expect(result).toBe('');
  });

  it('should use general label when category is null', async () => {
    mockSupaclaw.hybridRecall.mockResolvedValue([
      { content: 'Some memory', category: null, importance: 0.5 },
    ]);

    const result = await client.getRelevantContext('query');

    expect(result).toContain('[general]');
    expect(result).toContain('Some memory');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: FAIL — `getRelevantContext` throws "Not implemented"

**Step 3: Implement `getRelevantContext`**

Replace the stub in `src/hook-client.ts`:

```typescript
  async getRelevantContext(
    query: string,
    opts: {
      limit?: number;
      mode?: 'hybrid' | 'semantic' | 'keyword';
      maxTokens?: number;
    } = {}
  ): Promise<string> {
    const limit = opts.limit ?? 5;
    const mode = opts.mode ?? 'hybrid';

    let memories: Array<{ content: string; category?: string | null; importance?: number }>;

    if (mode === 'keyword') {
      memories = await this.supaclaw.recall(query, { limit });
    } else {
      memories = await this.supaclaw.hybridRecall(query, { limit });
    }

    if (memories.length === 0) return '';

    const lines = memories.map(m => {
      const cat = m.category || 'general';
      return `- [${cat}] ${m.content}`;
    });

    return `## Relevant Memories\n${lines.join('\n')}`;
  }
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hook-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/hook-client.ts tests/hook-client.test.ts
git commit -m "feat: implement getRelevantContext with formatted markdown output"
```

---

### Task 11: Export hook client from index.ts

**Files:**
- Modify: `src/index.ts:2975-3017` (exports section)

**Step 1: Add exports**

Add before the `export default Supaclaw;` line in `src/index.ts`:

```typescript
// Export hook client
export {
  createHookClient,
  SupaclawHookClient,
  HookClientConfig,
  MessageFilter,
  shouldLog,
} from './hook-client';
```

**Step 2: Verify build**

Run: `npm run build`
Expected: No TypeScript errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: export hook client from main entry point"
```

---

## Phase 3: Webhook Security + CLI

### Task 12: Webhook secret utilities

**Files:**
- Create: `src/webhook-auth.ts`
- Create: `tests/webhook-auth.test.ts`

**Step 1: Write the failing tests**

Create `tests/webhook-auth.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  generateWebhookSecret,
  hashSecret,
  verifySecret,
} from '../src/webhook-auth';

describe('Webhook Auth', () => {
  describe('generateWebhookSecret', () => {
    it('should generate a secret starting with whsec_', () => {
      const secret = generateWebhookSecret();
      expect(secret).toMatch(/^whsec_[a-zA-Z0-9_-]+$/);
    });

    it('should generate unique secrets', () => {
      const a = generateWebhookSecret();
      const b = generateWebhookSecret();
      expect(a).not.toBe(b);
    });

    it('should generate secrets of sufficient length', () => {
      const secret = generateWebhookSecret();
      // whsec_ prefix (6) + at least 32 chars of randomness
      expect(secret.length).toBeGreaterThanOrEqual(38);
    });
  });

  describe('hashSecret / verifySecret', () => {
    it('should verify a correct secret against its hash', async () => {
      const secret = 'whsec_testSecret123';
      const hash = await hashSecret(secret);
      expect(await verifySecret(secret, hash)).toBe(true);
    });

    it('should reject an incorrect secret', async () => {
      const hash = await hashSecret('whsec_correct');
      expect(await verifySecret('whsec_wrong', hash)).toBe(false);
    });

    it('should produce different hashes for different secrets', async () => {
      const hash1 = await hashSecret('whsec_one');
      const hash2 = await hashSecret('whsec_two');
      expect(hash1).not.toBe(hash2);
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/webhook-auth.test.ts`
Expected: FAIL — module not found

**Step 3: Implement webhook auth utilities**

Create `src/webhook-auth.ts`:

```typescript
import { randomBytes, createHash } from 'crypto';

/**
 * Generate a new webhook secret with whsec_ prefix.
 */
export function generateWebhookSecret(): string {
  const random = randomBytes(32).toString('base64url');
  return `whsec_${random}`;
}

/**
 * Hash a webhook secret for storage.
 * Uses SHA-256 — sufficient for high-entropy random secrets.
 */
export async function hashSecret(secret: string): Promise<string> {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Verify a webhook secret against a stored hash.
 */
export async function verifySecret(secret: string, hash: string): Promise<boolean> {
  const computed = await hashSecret(secret);
  // Constant-time comparison to prevent timing attacks
  if (computed.length !== hash.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  }
  return result === 0;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/webhook-auth.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/webhook-auth.ts tests/webhook-auth.test.ts
git commit -m "feat: add webhook secret generation and verification"
```

---

### Task 13: CLI webhook commands

**Files:**
- Test: `tests/webhook-cli.test.ts`
- Modify: `src/cli.ts`

**Step 1: Write a lightweight test**

Create `tests/webhook-cli.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateWebhookSecret, hashSecret } from '../src/webhook-auth';

// Webhook CLI logic test — the CLI commands are plumbing
// that call these functions + Supabase CRUD.

describe('Webhook CLI logic', () => {
  it('should generate a secret and produce a valid hash', async () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith('whsec_')).toBe(true);

    const hash = await hashSecret(secret);
    expect(hash).toBeDefined();
    expect(hash.length).toBe(64); // SHA-256 hex = 64 chars
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run tests/webhook-cli.test.ts`
Expected: PASS

**Step 3: Add webhook commands to CLI**

In `src/cli.ts`, look at the existing patterns for how `program` and helpers like `loadConfig` / Supabase client creation work. Add a `webhook` command group before `program.parse()`:

```typescript
const webhook = program.command('webhook').description('Manage webhook sources');

webhook
  .command('register')
  .description('Register a new webhook source')
  .requiredOption('--name <name>', 'Name for this webhook source (e.g. "telegram-bot")')
  .option('--agent-id <id>', 'Agent ID (defaults to config agentId)')
  .action(async (options: { name: string; agentId?: string }) => {
    const config = loadConfig();
    const supabase = createSupabaseClient(config);
    const { generateWebhookSecret, hashSecret } = await import('./webhook-auth');

    const agentId = options.agentId || config.agentId;
    const secret = generateWebhookSecret();
    const secretHash = await hashSecret(secret);

    const { error } = await supabase.from('webhook_sources').insert({
      agent_id: agentId,
      name: options.name,
      secret_hash: secretHash,
    });

    if (error) {
      console.error('Failed to register webhook source:', error.message);
      process.exit(1);
    }

    console.log('');
    console.log('Webhook source registered: ' + options.name);
    console.log('Agent: ' + agentId);
    console.log('');
    console.log('Secret (save this, shown only once):');
    console.log('  ' + secret);
    console.log('');
  });

webhook
  .command('list')
  .description('List registered webhook sources')
  .action(async () => {
    const config = loadConfig();
    const supabase = createSupabaseClient(config);

    const { data, error } = await supabase
      .from('webhook_sources')
      .select('id, agent_id, name, enabled, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to list webhook sources:', error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) {
      console.log('No webhook sources registered.');
      return;
    }

    console.log('');
    console.log('Webhook Sources:');
    console.log('');
    for (const src of data) {
      const status = src.enabled ? 'enabled' : 'disabled';
      console.log('  ' + src.name + ' (' + src.agent_id + ') - ' + status);
      console.log('    ID: ' + src.id + ' | Created: ' + src.created_at);
    }
    console.log('');
  });

webhook
  .command('revoke')
  .description('Disable a webhook source')
  .argument('<id>', 'Webhook source ID')
  .action(async (id: string) => {
    const config = loadConfig();
    const supabase = createSupabaseClient(config);

    const { error } = await supabase
      .from('webhook_sources')
      .update({ enabled: false })
      .eq('id', id);

    if (error) {
      console.error('Failed to revoke webhook source:', error.message);
      process.exit(1);
    }

    console.log('Webhook source ' + id + ' revoked.');
  });
```

Note: Check the existing CLI code for the exact names of `loadConfig` and the Supabase client helper. Adapt the names to match what's there.

**Step 4: Verify build**

Run: `npm run build`
Expected: No errors

**Step 5: Commit**

```bash
git add src/cli.ts tests/webhook-cli.test.ts
git commit -m "feat: add webhook register/list/revoke CLI commands"
```

---

## Phase 4: Supabase Edge Functions

### Task 14: Webhook receiver Edge Function

**Files:**
- Create: `supabase/functions/supaclaw-webhook/index.ts`

Note: Edge Functions use Deno runtime. No npm imports — use esm.sh for Supabase client.

**Step 1: Create the Edge Function**

Create `supabase/functions/supaclaw-webhook/index.ts` with the following content. This is a Deno Edge Function that receives HTTP POST requests, verifies webhook secrets, and routes to session/message handlers.

The function should:
1. Accept POST requests only
2. Verify the `Authorization: Bearer whsec_...` header against `webhook_sources` table
3. Extract `agent_id` from the matched source (not from request body)
4. Route based on URL path: `get-or-create-session`, `log-message`, `end-session`
5. Enforce 100KB request body limit
6. Check `allowed_actions` on the source

Key implementation details:
- Import Supabase client from `https://esm.sh/@supabase/supabase-js@2`
- Use `Deno.env.get('SUPABASE_URL')` and `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`
- Hash incoming secret with Web Crypto API: `crypto.subtle.digest('SHA-256', ...)`
- Look up `webhook_sources` by `secret_hash` + `enabled = true`
- For `get-or-create-session`: query sessions by `external_key` + `agent_id` + `ended_at IS NULL`
- For `log-message`: requires active session, inserts to messages table
- For `end-session`: updates `ended_at` on session, idempotent

**Step 2: Commit**

```bash
git add supabase/functions/supaclaw-webhook/index.ts
git commit -m "feat: add webhook receiver Edge Function"
```

---

### Task 15: Webhook admin Edge Function

**Files:**
- Create: `supabase/functions/webhook-admin/index.ts`

**Step 1: Create the Edge Function**

Create `supabase/functions/webhook-admin/index.ts`. This Edge Function:

1. Serves an admin HTML page on `GET /` with:
   - Supabase Auth login (magic link)
   - Table of registered webhook sources
   - Register new source form (generates secret, displays once)
   - Enable/disable toggle and revoke button per source
   - Uses safe DOM manipulation (document.createElement, textContent) — no innerHTML with user data

2. API routes protected by Supabase Auth JWT:
   - `GET /sources` — list webhook sources
   - `POST /sources` — register new source, returns `{ ok: true, secret: "whsec_..." }`
   - `PATCH /sources/:id` — toggle enabled
   - `DELETE /sources/:id` — revoke

Key implementation details:
- HTML page uses `supabase.createClient` from CDN for auth
- All API calls include `Authorization: Bearer <jwt>` from Supabase Auth session
- Server-side uses `supabase.auth.getUser(token)` to verify JWT
- Secret generation uses Web Crypto API (Deno): `crypto.getRandomValues` + `crypto.subtle.digest`
- Use `document.createElement` and `textContent` for DOM manipulation to avoid XSS
- Source names and agent IDs displayed via `textContent`, never inserted as raw HTML

**Step 2: Commit**

```bash
git add supabase/functions/webhook-admin/index.ts
git commit -m "feat: add webhook admin Edge Function with HTML UI"
```

---

### Task 16: Export webhook auth from index.ts

**Files:**
- Modify: `src/index.ts` (exports section)

**Step 1: Add export**

Add before `export default Supaclaw;`:

```typescript
// Export webhook auth utilities
export {
  generateWebhookSecret,
  hashSecret,
  verifySecret,
} from './webhook-auth';
```

**Step 2: Verify build**

Run: `npm run build`
Expected: No errors

**Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: export webhook auth utilities from main entry point"
```

---

## Phase 5: Verification

### Task 17: Run all tests and final build

**Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 2: Run build**

Run: `npm run build`
Expected: No TypeScript errors

**Step 3: Verify exports work**

Run: `node -e "const s = require('./dist/index.js'); console.log(Object.keys(s).filter(k => k.includes('Hook') || k.includes('webhook') || k.includes('shouldLog')))"`
Expected: Shows `createHookClient`, `SupaclawHookClient`, `shouldLog`, `generateWebhookSecret`, etc.

**Step 4: Final commit if any fixups needed**

```bash
git add -A
git commit -m "chore: final cleanup and verification"
```

---

## Summary

| Phase | Tasks | New Files | Modified Files |
|-------|-------|-----------|----------------|
| 1: DB & Core | 1-4 | 1 migration, start test file | `src/index.ts` |
| 2: Hook Client | 5-11 | `src/hook-client.ts` | `src/index.ts` exports |
| 3: Webhook Security + CLI | 12-13 | `src/webhook-auth.ts`, test files | `src/cli.ts` |
| 4: Edge Functions | 14-16 | 2 Edge Functions | `src/index.ts` exports |
| 5: Verification | 17 | — | fixups if needed |

**Total: 17 tasks, ~17 commits**
