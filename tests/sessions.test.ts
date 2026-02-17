import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Supaclaw } from '../src/index';
import type { Session } from '../src/index';

// These tests require a real Supabase instance
// Set env vars: SUPABASE_URL, SUPABASE_KEY
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const TEST_AGENT_ID = `test-agent-${Date.now()}`;

const shouldSkip = !SUPABASE_URL || !SUPABASE_KEY;

describe.skipIf(shouldSkip)('Session Management', () => {
  let memory: Supaclaw;
  let createdSessionIds: string[] = [];

  beforeAll(async () => {
    memory = new Supaclaw({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_KEY,
      agentId: TEST_AGENT_ID
    });

    await memory.initialize();
  });

  afterAll(async () => {
    // Cleanup: delete test sessions
    if (createdSessionIds.length > 0) {
      // Note: In production, you'd add a cleanup method to the API
      console.log(`Cleanup: ${createdSessionIds.length} test sessions created`);
    }
  });

  it('should start a new session', async () => {
    const session = await memory.startSession({
      userId: 'test-user',
      channel: 'test-channel',
      metadata: { test: true }
    });

    expect(session).toBeDefined();
    expect(session.id).toBeDefined();
    expect(session.agent_id).toBe(TEST_AGENT_ID);
    expect(session.user_id).toBe('test-user');
    expect(session.channel).toBe('test-channel');
    expect(session.started_at).toBeDefined();
    expect(session.ended_at).toBeUndefined();
    expect(session.metadata).toEqual({ test: true });

    createdSessionIds.push(session.id);
  });

  it('should start a session without optional fields', async () => {
    const session = await memory.startSession();

    expect(session).toBeDefined();
    expect(session.id).toBeDefined();
    expect(session.agent_id).toBe(TEST_AGENT_ID);
    expect(session.user_id).toBeUndefined();
    expect(session.channel).toBeUndefined();

    createdSessionIds.push(session.id);
  });

  it('should retrieve a session by ID', async () => {
    const created = await memory.startSession({ userId: 'retrieve-test' });
    createdSessionIds.push(created.id);

    const retrieved = await memory.getSession(created.id);

    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(created.id);
    expect(retrieved?.user_id).toBe('retrieve-test');
  });

  it('should return null for non-existent session', async () => {
    const session = await memory.getSession('00000000-0000-0000-0000-000000000000');
    expect(session).toBeNull();
  });

  it('should end a session', async () => {
    const session = await memory.startSession({ userId: 'end-test' });
    createdSessionIds.push(session.id);

    const ended = await memory.endSession(session.id, {
      summary: 'Test session summary'
    });

    expect(ended.id).toBe(session.id);
    expect(ended.ended_at).toBeDefined();
    expect(ended.summary).toBe('Test session summary');
  });

  it('should get recent sessions', async () => {
    // Create a few sessions
    const s1 = await memory.startSession({ userId: 'recent-user-1' });
    const s2 = await memory.startSession({ userId: 'recent-user-2' });
    const s3 = await memory.startSession({ userId: 'recent-user-1' });

    createdSessionIds.push(s1.id, s2.id, s3.id);

    const recent = await memory.getRecentSessions({ limit: 5 });

    expect(recent).toBeDefined();
    expect(recent.length).toBeGreaterThanOrEqual(3);
    expect(recent[0].agent_id).toBe(TEST_AGENT_ID);
    
    // Should be ordered by most recent first
    expect(new Date(recent[0].started_at).getTime())
      .toBeGreaterThanOrEqual(new Date(recent[1].started_at).getTime());
  });

  it('should filter sessions by user ID', async () => {
    const targetUserId = `filter-user-${Date.now()}`;
    
    const s1 = await memory.startSession({ userId: targetUserId });
    const s2 = await memory.startSession({ userId: 'other-user' });

    createdSessionIds.push(s1.id, s2.id);

    const filtered = await memory.getRecentSessions({ 
      userId: targetUserId,
      limit: 10 
    });

    expect(filtered.length).toBeGreaterThanOrEqual(1);
    filtered.forEach(session => {
      expect(session.user_id).toBe(targetUserId);
    });
  });

  it('should handle session metadata', async () => {
    const metadata = {
      source: 'telegram',
      chatId: 12345,
      nested: { key: 'value' }
    };

    const session = await memory.startSession({ metadata });
    createdSessionIds.push(session.id);

    const retrieved = await memory.getSession(session.id);
    expect(retrieved?.metadata).toEqual(metadata);
  });
});
