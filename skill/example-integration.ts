/**
 * Example Clawdbot Integration
 * 
 * This shows how to integrate Supaclaw with Clawdbot
 */

import { createClawdbotIntegration, createLoggingMiddleware } from '../src/clawdbot-integration';

// Initialize integration
const memoryIntegration = createClawdbotIntegration({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_KEY!,
  agentId: 'hans-assistant',
  userId: 'han',
  embeddingProvider: 'openai',
  openaiApiKey: process.env.OPENAI_API_KEY,
  autoLog: true,
  autoInject: true,
  sessionTimeout: 30 * 60 * 1000 // 30 minutes
});

// Initialize
await memoryIntegration.initialize();

// Create logging middleware
const logMessage = createLoggingMiddleware(memoryIntegration);

/**
 * Example 1: Handle incoming message
 */
async function handleUserMessage(chatId: string, text: string) {
  // Auto-log user message
  await logMessage({
    chatId,
    role: 'user',
    content: text,
    context: {
      channel: 'telegram',
      timestamp: new Date().toISOString()
    }
  });

  // Build context for system prompt
  const context = await memoryIntegration.buildContext(text, {
    includeMemories: true,
    includeLearnings: true,
    includeRecentMessages: true,
    chatId,
    maxMemories: 5,
    maxLearnings: 3
  });

  // Generate response (pseudocode)
  const response = await generateClaudeResponse({
    systemPrompt: BASE_PROMPT + '\n\n' + context,
    userMessage: text
  });

  // Auto-log assistant response
  await logMessage({
    chatId,
    role: 'assistant',
    content: response.text,
    context: {
      channel: 'telegram',
      model: 'claude-sonnet-4-5',
      timestamp: new Date().toISOString()
    }
  });

  return response.text;
}

/**
 * Example 2: Replace memory_search tool
 */
async function memory_search(query: string, userId = 'han') {
  const results = await memoryIntegration.memorySearch(query, {
    userId,
    limit: 5,
    minImportance: 0.5
  });

  return {
    results: results.map(r => ({
      path: 'database',
      content: r.content,
      category: r.category,
      importance: r.importance
    })),
    count: results.length
  };
}

/**
 * Example 3: Replace memory_get tool
 */
async function memory_get(category?: string, userId = 'han') {
  const results = await memoryIntegration.memoryGet({
    category,
    userId,
    limit: 10
  });

  return {
    results: results.map(r => ({
      content: r.content,
      category: r.category,
      importance: r.importance
    })),
    count: results.length
  };
}

/**
 * Example 4: Store a memory
 */
async function storeMemory(chatId: string, content: string, category?: string, importance = 0.5) {
  await memoryIntegration.remember(content, {
    category,
    importance,
    chatId
  });
}

/**
 * Example 5: Record a learning
 */
async function recordLearning(chatId: string, trigger: string, lesson: string, category: 'error' | 'correction' | 'improvement' | 'capability_gap' = 'correction') {
  await memoryIntegration.learn({
    category,
    trigger,
    lesson,
    chatId,
    severity: 'info'
  });
}

/**
 * Example 6: Create a task
 */
async function createTask(title: string, priority = 0, dueAt?: string) {
  await memoryIntegration.createTask({
    title,
    priority,
    dueAt
  });
}

/**
 * Example 7: Session lifecycle
 */
async function onConversationEnd(chatId: string) {
  // End session with auto-summary and memory extraction
  await memoryIntegration.endSession(chatId, {
    autoSummarize: true,
    extractMemories: true
  });
}

/**
 * Example 8: Heartbeat check (call every 30 min)
 */
async function onHeartbeat() {
  const { upcomingTasks, inactiveSessions } = await memoryIntegration.heartbeat();

  // Send task reminders
  for (const task of upcomingTasks) {
    const message = memoryIntegration.getMemory().formatTaskReminder(task, task.timeUntilDue);
    await sendNotification('telegram', message);
  }

  console.log(`Cleaned up ${inactiveSessions} inactive sessions`);
}

/**
 * Example 9: Advanced - Entity extraction
 */
async function extractEntitiesFromMessage(text: string, chatId: string) {
  const memory = memoryIntegration.getMemory();
  const entities = await memory.extractEntities(text);

  console.log(`Extracted ${entities.length} entities:`, entities.map(e => e.name));
}

/**
 * Example 10: Advanced - Learning recommendations
 */
async function getLearningsForContext(query: string) {
  const memory = memoryIntegration.getMemory();
  const learnings = await memory.getLearningRecommendations(query, 5);

  return learnings.map(l => ({
    lesson: l.lesson,
    category: l.category,
    applied: l.applied_count
  }));
}

// Export functions for Clawdbot tool definitions
export {
  memory_search,
  memory_get,
  storeMemory,
  recordLearning,
  createTask,
  handleUserMessage,
  onConversationEnd,
  onHeartbeat
};

// Pseudocode - actual implementation would be in Clawdbot
function generateClaudeResponse(opts: { systemPrompt: string; userMessage: string }) {
  // This would be your actual Claude API call
  return { text: "Response from Claude" };
}

function sendNotification(channel: string, message: string) {
  // This would be your actual notification function
  console.log(`[${channel}] ${message}`);
}

const BASE_PROMPT = `You are Hans Assistant, a helpful AI agent.`;
