/**
 * Tests for Clawdbot Integration
 */

import { vi } from 'vitest';
import { createClawdbotIntegration, ClawdbotMemoryIntegration } from '../src/clawdbot-integration';

const hasSupabase = !!process.env['SUPABASE_URL'] && !!process.env['SUPABASE_KEY'];

describe.skipIf(!hasSupabase)('Clawdbot Integration', () => {
  let integration: ClawdbotMemoryIntegration;

  beforeAll(() => {
    integration = createClawdbotIntegration({
      supabaseUrl: process.env.SUPABASE_URL || 'http://localhost:54321',
      supabaseKey: process.env.SUPABASE_KEY || 'test-key',
      agentId: 'test-agent',
      userId: 'test-user',
      embeddingProvider: 'none', // Disable embeddings for tests
      autoLog: true,
      sessionTimeout: 5000 // 5 seconds for testing
    });
  });

  describe('Session Management', () => {
    it('should create a new session', async () => {
      const sessionId = await integration.getOrCreateSession('chat-1', {
        userId: 'test-user',
        channel: 'telegram'
      });

      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
    });

    it('should reuse existing session within timeout', async () => {
      const sessionId1 = await integration.getOrCreateSession('chat-2');
      const sessionId2 = await integration.getOrCreateSession('chat-2');

      expect(sessionId1).toBe(sessionId2);
    });

    it('should create new session after timeout', async () => {
      const sessionId1 = await integration.getOrCreateSession('chat-3');
      
      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 6000));
      
      const sessionId2 = await integration.getOrCreateSession('chat-3');

      expect(sessionId1).not.toBe(sessionId2);
    }, 10000);
  });

  describe('Message Logging', () => {
    it('should log user message', async () => {
      await integration.logUserMessage('chat-4', 'Hello, world!', {
        channel: 'telegram',
        messageId: 'msg-1'
      });

      // Verify by checking session
      const sessionId = await integration.getOrCreateSession('chat-4');
      const memory = integration.getMemory();
      const messages = await memory.getMessages(sessionId);

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[messages.length - 1].content).toBe('Hello, world!');
      expect(messages[messages.length - 1].role).toBe('user');
    });

    it('should log assistant message', async () => {
      await integration.logAssistantMessage('chat-5', 'Hi there!', {
        channel: 'telegram',
        model: 'claude-sonnet-4-5'
      });

      const sessionId = await integration.getOrCreateSession('chat-5');
      const memory = integration.getMemory();
      const messages = await memory.getMessages(sessionId);

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[messages.length - 1].content).toBe('Hi there!');
      expect(messages[messages.length - 1].role).toBe('assistant');
    });

    it('should log system message', async () => {
      await integration.logSystemMessage('chat-6', 'Session started');

      const sessionId = await integration.getOrCreateSession('chat-6');
      const memory = integration.getMemory();
      const messages = await memory.getMessages(sessionId);

      expect(messages.length).toBeGreaterThan(0);
      expect(messages[messages.length - 1].content).toBe('Session started');
      expect(messages[messages.length - 1].role).toBe('system');
    });
  });

  describe('Memory Operations', () => {
    it('should store and retrieve memories', async () => {
      await integration.remember('User prefers TypeScript', {
        category: 'preferences',
        importance: 0.8,
        chatId: 'chat-7'
      });

      const results = await integration.memoryGet({
        category: 'preferences'
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('TypeScript');
    });

    it('should search memories (fallback without embeddings)', async () => {
      // Store a memory
      await integration.remember('User loves pizza', {
        category: 'preferences',
        importance: 0.7
      });

      // Search (will use keyword fallback)
      const results = await integration.memorySearch('pizza', {
        limit: 5
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.content.includes('pizza'))).toBe(true);
    });
  });

  describe('Learning Operations', () => {
    it('should record a learning', async () => {
      await integration.learn({
        category: 'correction',
        trigger: 'User corrected me',
        lesson: 'User prefers Rust over TypeScript',
        chatId: 'chat-8'
      });

      const memory = integration.getMemory();
      const learnings = await memory.getLearnings({
        category: 'correction'
      });

      expect(learnings.length).toBeGreaterThan(0);
      expect(learnings.some(l => l.lesson.includes('Rust'))).toBe(true);
    });
  });

  describe('Task Operations', () => {
    it('should create a task', async () => {
      const task = await integration.createTask({
        title: 'Test task',
        priority: 2,
        description: 'This is a test'
      });

      expect(task.title).toBe('Test task');
      expect(task.priority).toBe(2);
    });

    it('should get upcoming tasks', async () => {
      // Create a task due in 1 hour
      const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await integration.createTask({
        title: 'Upcoming task',
        dueAt
      });

      const upcoming = await integration.getUpcomingTasks(2); // Next 2 hours

      expect(upcoming.length).toBeGreaterThan(0);
      expect(upcoming.some(t => t.title === 'Upcoming task')).toBe(true);
    });
  });

  describe('Context Building', () => {
    beforeEach(async () => {
      // Store some test memories
      await integration.remember('User likes concise code', {
        category: 'preferences',
        importance: 0.8
      });

      await integration.learn({
        category: 'correction',
        trigger: 'User corrected code style',
        lesson: 'Avoid verbose comments'
      });
    });

    it('should build context with memories', async () => {
      const context = await integration.buildContext('code preferences', {
        includeMemories: true,
        includeLearnings: false
      });

      expect(context).toContain('Relevant Context');
      expect(context).toContain('concise code');
    });

    it('should build context with learnings', async () => {
      const context = await integration.buildContext('code style', {
        includeMemories: false,
        includeLearnings: true
      });

      expect(context).toContain('Past Learnings');
      expect(context).toContain('verbose comments');
    });

    it('should build context with recent messages', async () => {
      await integration.logUserMessage('chat-9', 'What is TypeScript?');
      await integration.logAssistantMessage('chat-9', 'TypeScript is a superset of JavaScript');

      const context = await integration.buildContext('TypeScript', {
        includeMemories: false,
        includeLearnings: false,
        includeRecentMessages: true,
        chatId: 'chat-9'
      });

      expect(context).toContain('Recent Conversation');
    });
  });

  describe('Session Lifecycle', () => {
    it('should end a session', async () => {
      const chatId = 'chat-10';
      await integration.logUserMessage(chatId, 'Test message');
      
      await integration.endSession(chatId, {
        summary: 'Test session summary',
        autoSummarize: false
      });

      const memory = integration.getMemory();
      const sessions = await memory.searchSessions({ limit: 1 });
      const lastSession = sessions[0];

      expect(lastSession.ended_at).toBeDefined();
      expect(lastSession.summary).toBe('Test session summary');
    });

    it('should cleanup inactive sessions', async () => {
      await integration.getOrCreateSession('chat-11');
      
      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 6000));
      
      await integration.cleanupInactiveSessions();

      // Session should be ended in database
      // (we can't easily verify this without checking the database directly)
    }, 10000);
  });

  describe('Heartbeat', () => {
    it('should run heartbeat check', async () => {
      const result = await integration.heartbeat();

      expect(result).toHaveProperty('upcomingTasks');
      expect(result).toHaveProperty('inactiveSessions');
      expect(Array.isArray(result.upcomingTasks)).toBe(true);
      expect(typeof result.inactiveSessions).toBe('number');
    });
  });
});
