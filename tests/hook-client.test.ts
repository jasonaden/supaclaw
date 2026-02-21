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
