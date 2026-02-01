import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OpenClawMemory } from '../src/index';
import type { Memory } from '../src/index';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const TEST_AGENT_ID = `test-agent-${Date.now()}`;

const shouldSkip = !SUPABASE_URL || !SUPABASE_KEY;

describe.skipIf(shouldSkip)('Memory Management', () => {
  let memory: OpenClawMemory;
  let createdMemoryIds: string[] = [];

  beforeAll(async () => {
    memory = new OpenClawMemory({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_KEY,
      agentId: TEST_AGENT_ID
    });

    await memory.initialize();
  });

  afterAll(async () => {
    // Cleanup created memories
    for (const id of createdMemoryIds) {
      try {
        await memory.forget(id);
      } catch (err) {
        console.error(`Failed to cleanup memory ${id}:`, err);
      }
    }
    console.log(`Cleanup: ${createdMemoryIds.length} test memories deleted`);
  });

  it('should create a basic memory', async () => {
    const mem = await memory.remember({
      content: 'User prefers TypeScript over JavaScript',
      category: 'preference',
      importance: 0.8
    });

    expect(mem).toBeDefined();
    expect(mem.id).toBeDefined();
    expect(mem.agent_id).toBe(TEST_AGENT_ID);
    expect(mem.content).toBe('User prefers TypeScript over JavaScript');
    expect(mem.category).toBe('preference');
    expect(mem.importance).toBe(0.8);
    expect(mem.created_at).toBeDefined();
    expect(mem.updated_at).toBeDefined();

    createdMemoryIds.push(mem.id);
  });

  it('should create memory with default importance', async () => {
    const mem = await memory.remember({
      content: 'Test memory with default importance'
    });

    expect(mem.importance).toBe(0.5); // default
    createdMemoryIds.push(mem.id);
  });

  it('should create memory with metadata', async () => {
    const metadata = {
      source: 'conversation',
      confidence: 0.9,
      tags: ['coding', 'preferences']
    };

    const mem = await memory.remember({
      content: 'User likes Rust for systems programming',
      category: 'preference',
      metadata
    });

    expect(mem.metadata).toEqual(metadata);
    createdMemoryIds.push(mem.id);
  });

  it('should create memory with expiration', async () => {
    const expiresAt = new Date(Date.now() + 86400000).toISOString(); // +1 day

    const mem = await memory.remember({
      content: 'Temporary memory',
      expiresAt
    });

    expect(mem.expires_at).toBe(expiresAt);
    createdMemoryIds.push(mem.id);
  });

  it('should link memory to session', async () => {
    const session = await memory.startSession({ userId: 'memory-link-test' });

    const mem = await memory.remember({
      content: 'Memory linked to session',
      sessionId: session.id
    });

    expect(mem.source_session_id).toBe(session.id);
    createdMemoryIds.push(mem.id);
  });

  it('should recall memories by keyword', async () => {
    const uniqueKeyword = `test-${Date.now()}`;

    const m1 = await memory.remember({
      content: `User likes ${uniqueKeyword} very much`,
      category: 'preference',
      importance: 0.9
    });

    const m2 = await memory.remember({
      content: `${uniqueKeyword} is important`,
      category: 'fact',
      importance: 0.7
    });

    const m3 = await memory.remember({
      content: 'Unrelated memory',
      category: 'fact',
      importance: 0.5
    });

    createdMemoryIds.push(m1.id, m2.id, m3.id);

    const results = await memory.recall(uniqueKeyword, { limit: 10 });

    expect(results.length).toBeGreaterThanOrEqual(2);
    const foundIds = results.map(r => r.id);
    expect(foundIds).toContain(m1.id);
    expect(foundIds).toContain(m2.id);
  });

  it('should filter recall by category', async () => {
    const categoryTag = `cat-${Date.now()}`;

    const m1 = await memory.remember({
      content: 'Preference memory',
      category: 'preference',
      importance: 0.8
    });

    const m2 = await memory.remember({
      content: 'Fact memory',
      category: 'fact',
      importance: 0.8
    });

    createdMemoryIds.push(m1.id, m2.id);

    const prefResults = await memory.recall('memory', { category: 'preference' });
    expect(prefResults.every(r => r.category === 'preference')).toBe(true);
  });

  it('should filter recall by minimum importance', async () => {
    const keyword = `imp-${Date.now()}`;

    const m1 = await memory.remember({
      content: `High importance ${keyword}`,
      importance: 0.9
    });

    const m2 = await memory.remember({
      content: `Low importance ${keyword}`,
      importance: 0.2
    });

    createdMemoryIds.push(m1.id, m2.id);

    const results = await memory.recall(keyword, { minImportance: 0.5 });
    
    expect(results.every(r => r.importance >= 0.5)).toBe(true);
    const foundIds = results.map(r => r.id);
    expect(foundIds).toContain(m1.id);
    expect(foundIds).not.toContain(m2.id);
  });

  it('should delete a memory', async () => {
    const mem = await memory.remember({
      content: 'Memory to delete'
    });

    createdMemoryIds.push(mem.id);

    await memory.forget(mem.id);

    // Try to recall - should not find it
    const allMemories = await memory.getMemories({ limit: 100 });
    const found = allMemories.find(m => m.id === mem.id);
    expect(found).toBeUndefined();

    // Remove from cleanup list since we already deleted it
    createdMemoryIds = createdMemoryIds.filter(id => id !== mem.id);
  });

  it('should get memories with pagination', async () => {
    // Create several memories
    const mems = [];
    for (let i = 0; i < 5; i++) {
      const m = await memory.remember({
        content: `Pagination test memory ${i}`,
        category: 'test'
      });
      mems.push(m);
      createdMemoryIds.push(m.id);
    }

    const page1 = await memory.getMemories({ category: 'test', limit: 3, offset: 0 });
    expect(page1.length).toBe(3);

    const page2 = await memory.getMemories({ category: 'test', limit: 3, offset: 3 });
    expect(page2.length).toBeGreaterThanOrEqual(2);
  });

  it('should filter memories by user ID', async () => {
    const targetUser = `user-${Date.now()}`;

    const m1 = await memory.remember({
      content: 'User-specific memory',
      userId: targetUser,
      category: 'personal'
    });

    const m2 = await memory.remember({
      content: 'General memory',
      category: 'general'
    });

    createdMemoryIds.push(m1.id, m2.id);

    const filtered = await memory.getMemories({ userId: targetUser });
    expect(filtered.every(m => m.user_id === targetUser)).toBe(true);
  });

  it('should get context with memories', async () => {
    const keyword = `context-${Date.now()}`;

    const m1 = await memory.remember({
      content: `${keyword} is a test keyword`,
      importance: 0.9
    });

    const m2 = await memory.remember({
      content: `More about ${keyword}`,
      importance: 0.7
    });

    createdMemoryIds.push(m1.id, m2.id);

    const context = await memory.getContext(keyword, { maxMemories: 5 });

    expect(context.memories.length).toBeGreaterThanOrEqual(2);
    expect(context.summary).toContain('Relevant memories:');
    expect(context.recentMessages).toEqual([]); // no session specified
  });

  it('should get context with session messages', async () => {
    const keyword = `ctx-session-${Date.now()}`;
    const session = await memory.startSession();

    await memory.addMessage(session.id, {
      role: 'user',
      content: `Tell me about ${keyword}`
    });

    await memory.addMessage(session.id, {
      role: 'assistant',
      content: `Here's info about ${keyword}`
    });

    const mem = await memory.remember({
      content: `${keyword} is interesting`,
      sessionId: session.id
    });

    createdMemoryIds.push(mem.id);

    const context = await memory.getContext(keyword, {
      sessionId: session.id,
      maxMessages: 10
    });

    expect(context.recentMessages.length).toBe(2);
    expect(context.memories.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle empty recall results', async () => {
    const results = await memory.recall('this-keyword-definitely-does-not-exist-12345', {
      limit: 10
    });

    expect(results).toEqual([]);
  });

  it('should order memories by importance and recency', async () => {
    const tag = `order-${Date.now()}`;

    const m1 = await memory.remember({
      content: `${tag} low importance`,
      importance: 0.3
    });

    const m2 = await memory.remember({
      content: `${tag} high importance`,
      importance: 0.9
    });

    const m3 = await memory.remember({
      content: `${tag} medium importance`,
      importance: 0.6
    });

    createdMemoryIds.push(m1.id, m2.id, m3.id);

    const results = await memory.recall(tag);

    // Should be ordered by importance desc
    expect(results[0].id).toBe(m2.id); // highest importance first
  });
});
