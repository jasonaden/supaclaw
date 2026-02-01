# Context Window Management Guide

OpenClaw Memory includes advanced context window management features to optimize token usage and improve LLM performance.

## Features

### 1. Token Budgeting
Automatically allocate context window space across different content types:
- Recent messages (40% by default)
- Long-term memories (30%)
- Learnings (20%)
- Entities (10%)

### 2. Smart Context Selection
Prioritize content based on:
- **Importance**: User-defined importance scores (0-1)
- **Recency**: Exponential decay over time
- **Relevance**: Semantic similarity to the current query

### 3. Lost-in-Middle Mitigation
Research shows LLMs pay more attention to the beginning and end of context windows. Our implementation places high-importance items at these edges to maximize attention.

## Usage Examples

### Basic Usage

```typescript
import OpenClawMemory from 'openclaw-memory';

const memory = new OpenClawMemory({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_KEY!,
  agentId: 'my-agent',
  embeddingProvider: 'openai',
  openaiApiKey: process.env.OPENAI_API_KEY
});

// Get optimized context for a query
const context = await memory.getSmartContext('What did we discuss about the project?', {
  sessionId: 'current-session-id',
  model: 'claude-3.5-sonnet' // Uses 200k context window
});

console.log(context);
// Output: Formatted context with memories, messages, learnings, and entities
```

### Advanced Usage with Custom Budgets

```typescript
import { createContextBudget } from 'openclaw-memory';

// Create custom budget
const budget = createContextBudget({
  modelContextSize: 200000, // 200k tokens
  recentMessagesPct: 0.5,   // 50% for messages
  memoriesPct: 0.3,         // 30% for memories
  learningsPct: 0.15,       // 15% for learnings
  entitiesPct: 0.05         // 5% for entities
});

// Build context with custom budget and weights
const result = await memory.buildOptimizedContext({
  query: 'Project status update',
  sessionId: 'session-123',
  customBudget: budget,
  useLostInMiddleFix: true,
  importanceWeight: 0.8,    // 80% importance
  recencyWeight: 0.2        // 20% recency
});

console.log('Context stats:', result.stats);
console.log('Formatted context:', result.formatted);
```

### Adaptive Budgeting

The system can automatically adjust budgets based on available content:

```typescript
import { createAdaptiveBudget } from 'openclaw-memory';

// Fetch content counts
const messages = await memory.getMessages(sessionId);
const memories = await memory.recall('query', { limit: 100 });
const learnings = await memory.searchLearnings('query', { limit: 50 });
const entities = await memory.searchEntities({ limit: 30 });

// Create adaptive budget
const budget = createAdaptiveBudget({
  messageCount: messages.length,
  memoryCount: memories.length,
  learningCount: learnings.length,
  entityCount: entities.length
});

// Use adaptive budget
const result = await memory.buildOptimizedContext({
  query: 'What should I know?',
  customBudget: budget
});
```

### Model-Specific Budgets

Pre-configured budgets for popular models:

```typescript
import { getBudgetForModel } from 'openclaw-memory';

// Get budget for specific model
const claudeBudget = getBudgetForModel('claude-3.5-sonnet'); // 200k tokens
const gpt4Budget = getBudgetForModel('gpt-4-turbo');         // 128k tokens
const gpt35Budget = getBudgetForModel('gpt-3.5-turbo');     // 16k tokens

console.log('Claude budget:', claudeBudget);
```

### Testing Different Budgets

Compare context windows across different models:

```typescript
const results = await memory.testContextBudgets('Project updates', {
  sessionId: 'session-123',
  models: ['gpt-3.5-turbo', 'gpt-4-turbo', 'claude-3.5-sonnet']
});

results.forEach(({ model, budget, stats }) => {
  console.log(`${model}:`);
  console.log(`  Total items: ${stats.totalItems}`);
  console.log(`  Total tokens: ${stats.totalTokens}`);
  console.log(`  Budget used: ${(stats.budgetUsed * 100).toFixed(1)}%`);
  console.log(`  Truncated: ${stats.truncated}`);
});
```

## Lost-in-Middle Mitigation

The "lost in the middle" effect refers to LLMs paying less attention to content in the middle of long contexts. Our implementation mitigates this by:

1. **Sorting by importance**: Rank all context items by importance score
2. **Edge placement**: Put highest-importance items at the beginning and end
3. **Middle filling**: Place lower-importance items in the middle

### Example

```typescript
// Enable lost-in-middle fix (enabled by default)
const result = await memory.buildOptimizedContext({
  query: 'Important project details',
  sessionId: 'session-123',
  useLostInMiddleFix: true  // ✓ High-importance at edges
});

// Disable for chronological order
const chronological = await memory.buildOptimizedContext({
  query: 'Same query',
  sessionId: 'session-123',
  useLostInMiddleFix: false  // ✗ Chronological order
});
```

## Token Estimation

Two estimation methods are available:

```typescript
import { estimateTokens, estimateTokensAccurate } from 'openclaw-memory';

const text = "The quick brown fox jumps over the lazy dog";

// Simple character-based (1 token ≈ 4 chars)
const simple = estimateTokens(text);
console.log('Simple estimate:', simple);

// Word-based (1 token ≈ 0.75 words)
const accurate = estimateTokensAccurate(text);
console.log('Accurate estimate:', accurate);
```

## Session Token Tracking

Monitor token usage for sessions:

```typescript
// Basic token count
const stats = await memory.countSessionTokens('session-123');
console.log('Total tokens:', stats.totalTokens);
console.log('Messages:', stats.messageCount);
console.log('Avg per message:', stats.averageTokensPerMessage);

// Estimate total usage including memories
const estimate = await memory.estimateSessionTokenUsage('session-123');
console.log('Messages:', estimate.messages, 'tokens');
console.log('Memories:', estimate.memories, 'tokens');
console.log('Total:', estimate.total, 'tokens');
console.log('Recommended context size:', estimate.contextSize);
```

## Best Practices

### 1. Match Budget to Model
Always use the correct budget for your LLM:

```typescript
// ✓ Good: Use model-specific budget
const context = await memory.getSmartContext(query, {
  model: 'claude-3.5-sonnet'
});

// ✗ Bad: Generic budget may waste or exceed limits
const context = await memory.buildOptimizedContext({
  query,
  modelContextSize: 8000 // Too small for Claude
});
```

### 2. Tune Importance Weights
Adjust based on your use case:

```typescript
// For real-time chat: prioritize recency
const chatContext = await memory.buildOptimizedContext({
  query: 'What did the user just say?',
  recencyWeight: 0.7,
  importanceWeight: 0.3
});

// For complex reasoning: prioritize importance
const reasoningContext = await memory.buildOptimizedContext({
  query: 'Analyze the entire project history',
  recencyWeight: 0.2,
  importanceWeight: 0.8
});
```

### 3. Monitor Context Stats
Check if you're hitting budget limits:

```typescript
const result = await memory.buildOptimizedContext({ query });

if (result.stats.truncated) {
  console.warn('Context was truncated!');
  console.log('Items selected:', result.stats.totalItems);
  console.log('Budget used:', (result.stats.budgetUsed * 100).toFixed(1) + '%');
}
```

### 4. Use Lost-in-Middle Fix for Long Contexts
Enable when context is >50k tokens:

```typescript
const estimate = await memory.estimateSessionTokenUsage(sessionId);

const useFix = estimate.total > 50000;

const context = await memory.buildOptimizedContext({
  query,
  sessionId,
  useLostInMiddleFix: useFix
});
```

## Performance Tips

1. **Cache embeddings**: Enable embedding generation and caching for faster semantic search
2. **Limit recall**: Don't fetch more items than you can fit in context
3. **Use adaptive budgets**: Let the system allocate based on content availability
4. **Monitor token usage**: Track session tokens to optimize costs

## Research References

The lost-in-middle effect is documented in:
- "Lost in the Middle: How Language Models Use Long Contexts" (Liu et al., 2023)
- Shows LLMs perform better with relevant info at start/end vs middle
- OpenClaw implements automatic mitigation based on importance scores

## CLI Examples

```bash
# Show context window for a query
npx openclaw-memory context "What did we discuss?" \
  --session session-123 \
  --model claude-3.5-sonnet

# Compare context windows across models
npx openclaw-memory test-budgets "Project status" \
  --session session-123 \
  --models gpt-3.5-turbo,gpt-4-turbo,claude-3.5-sonnet

# Estimate session token usage
npx openclaw-memory estimate-tokens --session session-123
```

## API Reference

See [README.md](./README.md) for complete API documentation.

## Examples

See [examples/context-window.ts](./examples/context-window.ts) for runnable examples.
