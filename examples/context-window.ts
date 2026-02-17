/**
 * Context Window Management Examples
 * Demonstrates token budgeting, smart context selection, and lost-in-middle mitigation
 */

import Supaclaw, {
  createContextBudget,
  createAdaptiveBudget,
  getBudgetForModel,
  estimateTokens,
  estimateTokensAccurate
} from '../src/index';

async function main() {
  // Initialize Supaclaw
  const memory = new Supaclaw({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseKey: process.env.SUPABASE_KEY!,
    agentId: 'demo-agent',
    embeddingProvider: 'openai',
    openaiApiKey: process.env.OPENAI_API_KEY
  });

  console.log('=== Supaclaw: Context Window Examples ===\n');

  // Example 1: Simple smart context
  console.log('Example 1: Get Smart Context');
  console.log('------------------------------');
  const session = await memory.startSession({ userId: 'demo-user' });
  
  // Add some messages
  await memory.addMessage(session.id, {
    role: 'user',
    content: 'I need help planning a software project'
  });
  
  await memory.addMessage(session.id, {
    role: 'assistant',
    content: 'I can help with that. What kind of project are you planning?'
  });

  // Add some memories
  await memory.remember({
    content: 'User prefers TypeScript for new projects',
    category: 'preference',
    importance: 0.9,
    userId: 'demo-user'
  });

  await memory.remember({
    content: 'User previously built a task management app',
    category: 'history',
    importance: 0.7,
    userId: 'demo-user'
  });

  // Get smart context
  const context = await memory.getSmartContext('What technologies should I use?', {
    sessionId: session.id,
    userId: 'demo-user',
    model: 'claude-3.5-sonnet'
  });

  console.log('Smart context generated:');
  console.log(context);
  console.log('\n');

  // Example 2: Custom budget
  console.log('Example 2: Custom Context Budget');
  console.log('---------------------------------');
  
  const customBudget = createContextBudget({
    modelContextSize: 128000,
    recentMessagesPct: 0.6,  // More space for messages
    memoriesPct: 0.25,
    learningsPct: 0.1,
    entitiesPct: 0.05
  });

  const customResult = await memory.buildOptimizedContext({
    query: 'Tell me about past projects',
    sessionId: session.id,
    userId: 'demo-user',
    customBudget,
    importanceWeight: 0.8,
    recencyWeight: 0.2
  });

  console.log('Context stats:');
  console.log('  Total items:', customResult.stats.totalItems);
  console.log('  Total tokens:', customResult.stats.totalTokens);
  console.log('  Budget used:', (customResult.stats.budgetUsed * 100).toFixed(1) + '%');
  console.log('  Truncated:', customResult.stats.truncated);
  console.log('  Items by type:', customResult.stats.itemsByType);
  console.log('\n');

  // Example 3: Model-specific budgets
  console.log('Example 3: Model-Specific Budgets');
  console.log('----------------------------------');
  
  const models = ['gpt-3.5-turbo', 'gpt-4-turbo', 'claude-3.5-sonnet'];
  
  for (const model of models) {
    const budget = getBudgetForModel(model);
    console.log(`${model}:`);
    console.log(`  Total context: ${budget.total.toLocaleString()} tokens`);
    console.log(`  Messages: ${budget.recentMessages.toLocaleString()} tokens`);
    console.log(`  Memories: ${budget.memories.toLocaleString()} tokens`);
    console.log(`  Learnings: ${budget.learnings.toLocaleString()} tokens`);
    console.log(`  Entities: ${budget.entities.toLocaleString()} tokens`);
  }
  console.log('\n');

  // Example 4: Adaptive budgeting
  console.log('Example 4: Adaptive Budgeting');
  console.log('-----------------------------');
  
  // Simulate scenario with lots of messages, few memories
  const messages = await memory.getMessages(session.id);
  const memories = await memory.recall('project', { userId: 'demo-user', limit: 100 });
  const learnings = await memory.searchLearnings('project', { limit: 50 });
  const entities = await memory.searchEntities({ limit: 30 });

  const adaptiveBudget = createAdaptiveBudget({
    messageCount: messages.length,
    memoryCount: memories.length,
    learningCount: learnings.length,
    entityCount: entities.length
  });

  console.log('Adaptive budget allocation:');
  console.log(`  Messages (${messages.length} items):`, adaptiveBudget.recentMessages, 'tokens');
  console.log(`  Memories (${memories.length} items):`, adaptiveBudget.memories, 'tokens');
  console.log(`  Learnings (${learnings.length} items):`, adaptiveBudget.learnings, 'tokens');
  console.log(`  Entities (${entities.length} items):`, adaptiveBudget.entities, 'tokens');
  console.log('\n');

  // Example 5: Lost-in-middle mitigation
  console.log('Example 5: Lost-in-Middle Mitigation');
  console.log('-------------------------------------');
  
  // Add more messages to demonstrate the effect
  for (let i = 0; i < 10; i++) {
    await memory.addMessage(session.id, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i + 1}: Some content here...`
    });
  }

  // With lost-in-middle fix
  const withFix = await memory.buildOptimizedContext({
    query: 'Summary',
    sessionId: session.id,
    useLostInMiddleFix: true
  });

  // Without fix (chronological)
  const withoutFix = await memory.buildOptimizedContext({
    query: 'Summary',
    sessionId: session.id,
    useLostInMiddleFix: false
  });

  console.log('With lost-in-middle fix:');
  console.log('  First item importance:', withFix.window.items[0]?.importance.toFixed(2));
  console.log('  Last item importance:', withFix.window.items[withFix.window.items.length - 1]?.importance.toFixed(2));
  
  console.log('\nWithout fix (chronological):');
  console.log('  First item timestamp:', new Date(withoutFix.window.items[0]?.timestamp).toISOString());
  console.log('  Last item timestamp:', new Date(withoutFix.window.items[withoutFix.window.items.length - 1]?.timestamp).toISOString());
  console.log('\n');

  // Example 6: Token estimation
  console.log('Example 6: Token Estimation');
  console.log('---------------------------');
  
  const testTexts = [
    'Hello world',
    'The quick brown fox jumps over the lazy dog',
    'This is a longer piece of text that contains multiple sentences. It should demonstrate the difference between simple and accurate token estimation methods.'
  ];

  for (const text of testTexts) {
    const simple = estimateTokens(text);
    const accurate = estimateTokensAccurate(text);
    console.log(`Text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    console.log(`  Characters: ${text.length}`);
    console.log(`  Simple estimate: ${simple} tokens`);
    console.log(`  Accurate estimate: ${accurate} tokens`);
  }
  console.log('\n');

  // Example 7: Session token tracking
  console.log('Example 7: Session Token Tracking');
  console.log('----------------------------------');
  
  const tokenStats = await memory.countSessionTokens(session.id);
  console.log('Session token stats:');
  console.log('  Total tokens:', tokenStats.totalTokens);
  console.log('  Message count:', tokenStats.messageCount);
  console.log('  Average per message:', tokenStats.averageTokensPerMessage);

  const estimate = await memory.estimateSessionTokenUsage(session.id);
  console.log('\nEstimated usage:');
  console.log('  Message tokens:', estimate.messages);
  console.log('  Memory tokens:', estimate.memories);
  console.log('  Total:', estimate.total);
  console.log('  Recommended context size:', estimate.contextSize);
  console.log('\n');

  // Example 8: Budget comparison
  console.log('Example 8: Test Multiple Budgets');
  console.log('---------------------------------');
  
  const comparisons = await memory.testContextBudgets('project planning', {
    sessionId: session.id,
    userId: 'demo-user',
    models: ['gpt-3.5-turbo', 'gpt-4-turbo', 'claude-3.5-sonnet']
  });

  comparisons.forEach(({ model, budget, stats }) => {
    console.log(`${model}:`);
    console.log(`  Context size: ${budget.total.toLocaleString()} tokens`);
    console.log(`  Items selected: ${stats.totalItems}`);
    console.log(`  Tokens used: ${stats.totalTokens.toLocaleString()}`);
    console.log(`  Budget utilization: ${(stats.budgetUsed * 100).toFixed(1)}%`);
    console.log(`  Truncated: ${stats.truncated}`);
    console.log('');
  });

  // Cleanup
  await memory.endSession(session.id, { autoSummarize: true });
  console.log('Session ended and cleaned up.');
}

main().catch(console.error);
