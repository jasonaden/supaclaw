import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// ============ Phase 2: Hook Client ============

import { shouldLog, createHookClient, SupaclawHookClient, type MessageFilter, type HookClientConfig } from '../src/hook-client';
import * as fs from 'fs';

vi.mock('fs');

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

    // Advance past one interval tick and flush the microtask queue
    await vi.advanceTimersByTimeAsync(5000);

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
