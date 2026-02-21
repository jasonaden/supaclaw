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
