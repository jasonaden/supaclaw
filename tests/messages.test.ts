import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { OpenClawMemory } from '../src/index';
import type { Session, Message } from '../src/index';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const TEST_AGENT_ID = `test-agent-${Date.now()}`;

const shouldSkip = !SUPABASE_URL || !SUPABASE_KEY;

describe.skipIf(shouldSkip)('Message Management', () => {
  let memory: OpenClawMemory;
  let testSession: Session;
  let createdSessionIds: string[] = [];

  beforeAll(async () => {
    memory = new OpenClawMemory({
      supabaseUrl: SUPABASE_URL,
      supabaseKey: SUPABASE_KEY,
      agentId: TEST_AGENT_ID
    });

    await memory.initialize();

    // Create a test session for message tests
    testSession = await memory.startSession({
      userId: 'message-test-user',
      channel: 'test'
    });
    createdSessionIds.push(testSession.id);
  });

  afterAll(async () => {
    console.log(`Cleanup: ${createdSessionIds.length} test sessions created`);
  });

  it('should add a user message', async () => {
    const message = await memory.addMessage(testSession.id, {
      role: 'user',
      content: 'Hello, assistant!',
      metadata: { source: 'test' }
    });

    expect(message).toBeDefined();
    expect(message.id).toBeDefined();
    expect(message.session_id).toBe(testSession.id);
    expect(message.role).toBe('user');
    expect(message.content).toBe('Hello, assistant!');
    expect(message.created_at).toBeDefined();
    expect(message.metadata).toEqual({ source: 'test' });
  });

  it('should add an assistant message', async () => {
    const message = await memory.addMessage(testSession.id, {
      role: 'assistant',
      content: 'How can I help you?',
      tokenCount: 42
    });

    expect(message.role).toBe('assistant');
    expect(message.content).toBe('How can I help you?');
    expect(message.token_count).toBe(42);
  });

  it('should add system and tool messages', async () => {
    const systemMsg = await memory.addMessage(testSession.id, {
      role: 'system',
      content: 'You are a helpful assistant.'
    });

    const toolMsg = await memory.addMessage(testSession.id, {
      role: 'tool',
      content: 'Tool result: success'
    });

    expect(systemMsg.role).toBe('system');
    expect(toolMsg.role).toBe('tool');
  });

  it('should retrieve messages from a session', async () => {
    // Create a new session for this test
    const session = await memory.startSession({ userId: 'retrieval-test' });
    createdSessionIds.push(session.id);

    // Add some messages
    await memory.addMessage(session.id, { role: 'user', content: 'Message 1' });
    await memory.addMessage(session.id, { role: 'assistant', content: 'Message 2' });
    await memory.addMessage(session.id, { role: 'user', content: 'Message 3' });

    const messages = await memory.getMessages(session.id);

    expect(messages.length).toBe(3);
    expect(messages[0].content).toBe('Message 1'); // chronological order
    expect(messages[1].content).toBe('Message 2');
    expect(messages[2].content).toBe('Message 3');
  });

  it('should paginate messages', async () => {
    const session = await memory.startSession({ userId: 'pagination-test' });
    createdSessionIds.push(session.id);

    // Add 10 messages
    for (let i = 0; i < 10; i++) {
      await memory.addMessage(session.id, {
        role: 'user',
        content: `Message ${i + 1}`
      });
    }

    // Get first 5
    const page1 = await memory.getMessages(session.id, { limit: 5, offset: 0 });
    expect(page1.length).toBe(5);
    expect(page1[0].content).toBe('Message 1');

    // Get next 5
    const page2 = await memory.getMessages(session.id, { limit: 5, offset: 5 });
    expect(page2.length).toBe(5);
    expect(page2[0].content).toBe('Message 6');
  });

  it('should store message metadata', async () => {
    const metadata = {
      platform: 'telegram',
      messageId: 12345,
      edited: false
    };

    const message = await memory.addMessage(testSession.id, {
      role: 'user',
      content: 'Test metadata',
      metadata
    });

    expect(message.metadata).toEqual(metadata);

    const messages = await memory.getMessages(testSession.id);
    const found = messages.find(m => m.id === message.id);
    expect(found?.metadata).toEqual(metadata);
  });

  it('should handle long message content', async () => {
    const longContent = 'A'.repeat(10000); // 10k characters

    const message = await memory.addMessage(testSession.id, {
      role: 'user',
      content: longContent
    });

    expect(message.content.length).toBe(10000);

    const messages = await memory.getMessages(testSession.id);
    const found = messages.find(m => m.id === message.id);
    expect(found?.content).toBe(longContent);
  });

  it('should track token counts', async () => {
    const m1 = await memory.addMessage(testSession.id, {
      role: 'user',
      content: 'Short message',
      tokenCount: 3
    });

    const m2 = await memory.addMessage(testSession.id, {
      role: 'assistant',
      content: 'A much longer response with many tokens',
      tokenCount: 42
    });

    expect(m1.token_count).toBe(3);
    expect(m2.token_count).toBe(42);
  });

  it('should return empty array for session with no messages', async () => {
    const emptySession = await memory.startSession();
    createdSessionIds.push(emptySession.id);

    const messages = await memory.getMessages(emptySession.id);
    expect(messages).toEqual([]);
  });

  it('should maintain message order', async () => {
    const session = await memory.startSession({ userId: 'order-test' });
    createdSessionIds.push(session.id);

    const messages = [
      { role: 'user' as const, content: 'First' },
      { role: 'assistant' as const, content: 'Second' },
      { role: 'user' as const, content: 'Third' },
      { role: 'assistant' as const, content: 'Fourth' }
    ];

    for (const msg of messages) {
      await memory.addMessage(session.id, msg);
    }

    const retrieved = await memory.getMessages(session.id);
    expect(retrieved.length).toBe(4);
    
    for (let i = 0; i < messages.length; i++) {
      expect(retrieved[i].content).toBe(messages[i].content);
      expect(retrieved[i].role).toBe(messages[i].role);
    }
  });
});
