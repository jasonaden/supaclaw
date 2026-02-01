# 🧠 OpenClaw Memory

**Persistent memory for AI agents using Supabase.**

Stop losing context. Stop re-reading massive markdown files. Give your agent a real memory.

[![npm version](https://badge.fury.io/js/openclaw-memory.svg)](https://www.npmjs.com/package/openclaw-memory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## The Problem

AI agents using file-based memory (MEMORY.md, daily logs) face:
- **Context window bloat** - Files grow unbounded, eating your token budget
- **Forgetting** - Context resets wipe session memory  
- **No search** - Linear scan through text to find relevant info
- **Unstructured** - Can't query "what did we discuss about X?"

## The Solution

OpenClaw Memory uses **Supabase (Postgres)** to give your agent:
- ✅ **Session tracking** - Every conversation logged with metadata
- ✅ **Semantic search** - Find relevant memories via vector similarity (pgvector)
- ✅ **Smart context** - Only load what's relevant, not everything
- ✅ **Context window management** - Token budgeting, smart selection, lost-in-middle mitigation
- ✅ **Entity relationships** - Knowledge graph with multi-hop traversal, confidence scoring
- ✅ **Multi-agent** - Share memories across agents
- ✅ **Structured data** - SQL queries, relationships, types

## Quick Start

```bash
npm install openclaw-memory
```

```typescript
import { OpenClawMemory } from 'openclaw-memory';

const memory = new OpenClawMemory({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  agentId: 'my-agent',
  // Optional: Enable semantic search with OpenAI embeddings
  embeddingProvider: 'openai',
  openaiApiKey: process.env.OPENAI_API_KEY
});

// Initialize tables (first run only)
await memory.initialize();

// Start a conversation session
const session = await memory.startSession({ 
  userId: 'user-123', 
  channel: 'telegram' 
});

// Log messages
await memory.addMessage(session.id, { 
  role: 'user', 
  content: 'Remember that I prefer TypeScript over JavaScript' 
});

// Create a persistent memory
await memory.remember({
  content: 'User prefers TypeScript over JavaScript',
  category: 'preference',
  importance: 0.9
});

// Later: recall relevant memories (semantic search if embeddings enabled)
const memories = await memory.recall('programming language preferences', {
  minSimilarity: 0.7,  // Cosine similarity threshold
  limit: 10
});
// Returns: [{ content: 'User prefers TypeScript...', importance: 0.9, similarity: 0.85, ... }]

// Or use hybrid search (combines semantic + keyword matching)
const hybrid = await memory.hybridRecall('coding tips', {
  vectorWeight: 0.7,    // Weight for semantic similarity
  keywordWeight: 0.3,   // Weight for keyword matching
  limit: 10
});

// Find memories similar to an existing one
const similar = await memory.findSimilarMemories(memoryId, {
  minSimilarity: 0.8,
  limit: 5
});

// End session with AI-generated summary
await memory.endSession(session.id, { autoSummarize: true });

// Resume interrupted session
const { session, messages, context } = await memory.resumeSession(sessionId);

// Extract entities from conversation
const entities = await memory.extractEntities('I love using Claude for coding');
// Returns: [{ entity_type: 'product', name: 'Claude', description: '...' }]

// Extract entities AND relationships in one call
const { entities, relationships } = await memory.extractEntitiesWithRelationships(
  'Alice works at TechCorp in San Francisco'
);
// Returns entities: Han (person), TechCorp (organization), San Francisco (place)
// Returns relationships: Han → works_at → TechCorp, TechCorp → located_in → San Francisco

// Find related entities through graph traversal (multi-hop)
const related = await memory.findRelatedEntities(hanId, { maxDepth: 2 });
// Returns entities connected within 2 hops with relationship paths and confidence scores

// Create tasks with hierarchy
const project = await memory.createTask({ title: 'Build feature X' });
await memory.createTask({ 
  title: 'Design UI', 
  parentTaskId: project.id 
});

// Get upcoming tasks (due in next 24h)
const upcoming = await memory.getUpcomingTasks({ hoursAhead: 24 });

// Record learnings for future context
await memory.learn({
  category: 'error',
  trigger: 'Database migration failed',
  lesson: 'Always backup before schema changes',
  severity: 'critical'
});

// Search learnings when facing similar issues
const relevantLearnings = await memory.searchLearnings('database');
```

## Database Schema

### Sessions
```sql
sessions (id, agent_id, user_id, channel, started_at, ended_at, summary, metadata)
```

### Messages
```sql
messages (id, session_id, role, content, created_at, token_count, metadata)
```

### Memories
```sql
memories (id, agent_id, user_id, category, content, importance, embedding, expires_at, ...)
```

### Entities
```sql
entities (id, agent_id, entity_type, name, aliases, properties, embedding, ...)
```

### Entity Relationships
```sql
entity_relationships (id, agent_id, source_entity_id, target_entity_id, relationship_type, 
                      confidence, mention_count, properties, ...)
```

### Tasks
```sql
tasks (id, agent_id, title, status, priority, due_at, ...)
```

### Learnings
```sql
learnings (id, agent_id, category, trigger, lesson, action, severity, ...)
```

See [SCHEMA.md](./SCHEMA.md) for full details.

## Search Modes

OpenClaw Memory supports three search strategies:

### 📝 Keyword Search (Default)
Traditional text matching - fast, no API keys needed.

```typescript
const results = await memory.recall('TypeScript', { limit: 10 });
```

### 🧠 Semantic Search
Uses OpenAI embeddings for meaning-based search. Understands that "coding tips" and "programming best practices" are related.

```typescript
const results = await memory.recall('machine learning', {
  minSimilarity: 0.75,  // Cosine similarity threshold (0-1)
  limit: 10
});
```

**Requirements:**
- `embeddingProvider: 'openai'` in config
- `OPENAI_API_KEY` environment variable
- Run migration `002_vector_search.sql`

### ⚡ Hybrid Search (Best Results)
Combines semantic understanding with keyword matching.

```typescript
const results = await memory.hybridRecall('AI agents', {
  vectorWeight: 0.7,    // 70% semantic similarity
  keywordWeight: 0.3,   // 30% keyword matching
  limit: 10
});
```

**When to use each:**
- **Keyword** - Fast lookups, exact term matching
- **Semantic** - Conceptual search, understanding context
- **Hybrid** - Best overall results, balances both strategies

## 🎯 Context Window Management

Advanced token budgeting and smart context selection to optimize LLM performance.

### Smart Context Generation

```typescript
// Simple: Get optimized context for a query
const context = await memory.getSmartContext('What did we discuss about the project?', {
  sessionId: 'current-session',
  model: 'claude-3.5-sonnet'  // Auto-configures for 200k context
});

// Advanced: Full control over budget and selection
const result = await memory.buildOptimizedContext({
  query: 'Project updates',
  sessionId: 'session-123',
  model: 'claude-3.5-sonnet',
  useLostInMiddleFix: true,    // Place important items at edges
  importanceWeight: 0.8,        // 80% importance, 20% recency
  recencyWeight: 0.2
});

console.log('Context:', result.formatted);
console.log('Stats:', result.stats);
```

### Custom Budget Allocation

```typescript
import { createContextBudget } from 'openclaw-memory';

const budget = createContextBudget({
  modelContextSize: 200000,     // 200k tokens for Claude
  recentMessagesPct: 0.5,       // 50% for messages
  memoriesPct: 0.3,             // 30% for memories
  learningsPct: 0.15,           // 15% for learnings
  entitiesPct: 0.05             // 5% for entities
});

const result = await memory.buildOptimizedContext({
  query: 'Tell me everything',
  customBudget: budget
});
```

### Adaptive Budgeting

Automatically adjusts allocation based on available content:

```typescript
import { createAdaptiveBudget } from 'openclaw-memory';

const budget = createAdaptiveBudget({
  messageCount: 100,   // Lots of messages
  memoryCount: 20,     // Few memories
  learningCount: 10,
  entityCount: 5
});
// Result: More budget allocated to messages
```

### Lost-in-Middle Mitigation

Research shows LLMs pay less attention to content in the middle of long contexts. OpenClaw automatically places high-importance items at the beginning and end:

```typescript
const result = await memory.buildOptimizedContext({
  query: 'Important details',
  useLostInMiddleFix: true  // ✓ High-importance at edges
});
```

See [CONTEXT_WINDOW_GUIDE.md](./CONTEXT_WINDOW_GUIDE.md) for detailed examples and best practices.

## CLI Usage

```bash
# Initialize config
npx openclaw-memory init

# Run migrations
npx openclaw-memory migrate

# Test connection
npx openclaw-memory test

# Check database status
npx openclaw-memory status

# Search memories (keyword mode)
npx openclaw-memory search "TypeScript"

# Semantic search (requires OPENAI_API_KEY)
npx openclaw-memory search "coding best practices" --mode semantic

# Hybrid search
npx openclaw-memory search "AI patterns" --mode hybrid --limit 15

# List sessions
npx openclaw-memory sessions --limit 20 --active

# Export memories
npx openclaw-memory export memories.md

# Import memories
npx openclaw-memory import MEMORY.md

# Import from Clawdbot workspace
npx openclaw-memory import-memory-md ~/clawd/MEMORY.md
npx openclaw-memory import-daily-logs ~/clawd/memory
npx openclaw-memory import-todo-md ~/clawd/TODO.md
npx openclaw-memory import-learnings-md ~/clawd/LEARNINGS.md

# Import everything at once
npx openclaw-memory import-all ~/clawd --user-id han
```

## 🤖 Clawdbot Integration

OpenClaw Memory provides seamless integration with [Clawdbot](https://github.com/clawdbot/clawdbot) to replace file-based memory systems.

### Installation as Clawdbot Skill

```bash
# Install via clawdhub
clawdhub install openclaw-memory

# Or install globally via npm
npm install -g openclaw-memory
```

### Quick Setup

```typescript
import { createClawdbotIntegration } from 'openclaw-memory';

const integration = createClawdbotIntegration({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_KEY!,
  agentId: 'hans-assistant',
  userId: 'han',
  embeddingProvider: 'openai',
  openaiApiKey: process.env.OPENAI_API_KEY,
  autoLog: true,          // Auto-log all messages
  sessionTimeout: 30 * 60 * 1000  // 30 min inactivity
});

await integration.initialize();
```

### Auto-Logging Messages

```typescript
// User message
await integration.logUserMessage(chatId, 'What is TypeScript?', {
  channel: 'telegram',
  messageId: msg.id
});

// Assistant response
await integration.logAssistantMessage(chatId, 'TypeScript is...', {
  model: 'claude-sonnet-4-5'
});
```

### Replacing memory_search Tool

**Before (file-based):**
```typescript
function memory_search(query: string) {
  const content = fs.readFileSync('MEMORY.md', 'utf-8');
  return content.split('\n').filter(line => 
    line.toLowerCase().includes(query.toLowerCase())
  );
}
```

**After (semantic search):**
```typescript
async function memory_search(query: string) {
  return await integration.memorySearch(query, {
    userId: 'han',
    limit: 5,
    minImportance: 0.5
  });
}
```

**Benefits:**
- 🎯 Semantic understanding (finds "code style" when you search "programming preferences")
- 📉 95% token reduction (5 memories vs entire file)
- ⚡ Faster (database query vs file I/O)
- 🎚️ Importance filtering (only relevant memories)

### Auto-Injecting Context into System Prompts

```typescript
async function buildSystemPrompt(userQuery: string) {
  // Get relevant memories, learnings, and recent messages
  const context = await integration.buildContext(userQuery, {
    includeMemories: true,
    includeLearnings: true,
    includeRecentMessages: true,
    chatId: 'telegram-123',
    maxMemories: 5,
    maxLearnings: 3
  });

  return BASE_SYSTEM_PROMPT + '\n\n' + context;
}
```

**Generated Context:**
```
## Relevant Context

- [preferences] User prefers TypeScript over JavaScript
- [projects] Working on stock trading challenge
- [context] User is actively trading TSLA

## Past Learnings

- [correction] User prefers Rust for performance-critical code
  Action: Suggest Rust for system-level tasks

## Recent Conversation

- user: What's the stock price of TSLA?
- assistant: Tesla is currently trading at $245.
```

### Session Lifecycle Hooks

```typescript
// Session auto-created on first message
const sessionId = await integration.getOrCreateSession('telegram-123');

// End session with auto-summary
await integration.endSession('telegram-123', {
  autoSummarize: true,
  extractMemories: true
});

// Heartbeat check (call every 30 min)
const { upcomingTasks, inactiveSessions } = await integration.heartbeat();

// Send task reminders
for (const task of upcomingTasks) {
  const reminder = integration.getMemory().formatTaskReminder(task, task.timeUntilDue);
  await sendNotification(reminder);
}
```

### Token & Cost Savings

**Before (MEMORY.md):**
- File size: 50 KB
- Tokens per turn: ~12,500
- Cost per 1M turns: ~$37.50

**After (OpenClaw Memory):**
- Memories retrieved: 5
- Tokens per turn: ~500
- Cost per 1M turns: ~$1.50
- **💰 Savings: 96% reduction, $36/M turns**

### Complete Integration Example

See [`skill/example-integration.ts`](skill/example-integration.ts) for a full working example showing:
- Message handler with auto-logging
- Tool replacement (memory_search, memory_get)
- Context injection
- Session lifecycle
- Heartbeat monitoring

### Migrating from Clawdbot Memory Files

If you're using traditional Clawdbot memory files, OpenClaw Memory can import them:

**Supported formats:**
- `MEMORY.md` → memories table (with importance and category tags)
- `memory/*.md` → sessions + messages (daily logs)
- `TODO.md` → tasks table (with status and due dates)
- `LEARNINGS.md` → learnings table (with triggers and lessons)

**Import examples:**

```bash
# Import MEMORY.md
npx openclaw-memory import-memory-md ~/clawd/MEMORY.md

# Import daily logs from memory/
npx openclaw-memory import-daily-logs ~/clawd/memory --user-id han

# Import TODO.md
npx openclaw-memory import-todo-md ~/clawd/TODO.md

# Import LEARNINGS.md
npx openclaw-memory import-learnings-md ~/clawd/LEARNINGS.md

# Import everything at once
npx openclaw-memory import-all ~/clawd --user-id han
```

**What gets imported:**
- MEMORY.md: Parses sections (##) as categories, list items and paragraphs as memories
- Daily logs: Extracts sessions and User/Assistant message exchanges
- TODO.md: Imports tasks with status (pending/completed/cancelled), priority, and due dates
- LEARNINGS.md: Imports learnings with category, trigger, lesson, and importance

**Tag support:**
- `[importance: 0.9]` - Set memory importance (0.0-1.0)
- `[2024-01-28]` - Set creation date
- `[due: 2024-02-15]` - Set task due date

```

## Setup Supabase

1. Create a [Supabase](https://supabase.com) project
2. Enable the `vector` extension:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. Run the migrations:
   ```bash
   npx openclaw-memory migrate
   ```
4. Set environment variables:
   ```bash
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_KEY=your-anon-key
   ```

## API Reference

### `new OpenClawMemory(config)`
Create a memory instance.

**Config options:**
- `supabaseUrl` - Supabase project URL
- `supabaseKey` - Supabase anon or service key
- `agentId` - Unique identifier for this agent
- `embeddingProvider` - Optional: 'openai', 'voyage', or 'none'
- `openaiApiKey` - Required if using OpenAI embeddings
- `embeddingModel` - Optional: OpenAI model name (default: 'text-embedding-3-small')

### `memory.initialize()`
Create database tables if they don't exist.

### `memory.startSession(opts)`
Start a new conversation session.

### `memory.addMessage(sessionId, message)`
Log a message to a session.

### `memory.endSession(sessionId, opts?)`
End a session, optionally with a summary.

**Options:**
- `summary` - Manual summary text
- `autoSummarize` - Auto-generate summary using AI (requires OpenAI)

### `memory.generateSessionSummary(sessionId)`
Generate an AI summary of a session (2-3 sentences).

### `memory.resumeSession(sessionId)`
Resume an interrupted session with context.

**Returns:** `{ session, messages, context }`

### `memory.searchSessions(opts?)`
Search sessions by date range and metadata.

**Options:**
- `userId`, `channel`, `startDate`, `endDate`
- `limit`, `offset`

### `memory.exportSessionToMarkdown(sessionId)`
Export a session to markdown format.

### `memory.importSessionFromMarkdown(markdown, opts?)`
Import a session from markdown.

### `memory.extractMemoriesFromSession(sessionId, opts?)`
Extract key memories from a session using AI.

**Options:**
- `minImportance` - Minimum importance threshold (default: 0.5)
- `autoExtract` - Use AI to extract (requires OpenAI)

### `memory.countSessionTokens(sessionId)`
Count total tokens used in a session.

**Returns:** `{ totalTokens, messageCount, averageTokensPerMessage }`

### `memory.remember(memory)`
Store a long-term memory. Automatically generates embeddings if provider configured.

### `memory.recall(query, opts?)`
Search for relevant memories using semantic similarity (if embeddings enabled) or keyword matching.

**Options:**
- `userId` - Filter by user
- `category` - Filter by category
- `limit` - Maximum results (default: 10)
- `minImportance` - Minimum importance score
- `minSimilarity` - Minimum cosine similarity (0-1, default: 0.7)

### `memory.hybridRecall(query, opts?)`
Hybrid search combining vector similarity and keyword matching.

**Options:**
- All options from `recall()` plus:
- `vectorWeight` - Weight for semantic similarity (default: 0.7)
- `keywordWeight` - Weight for keyword matching (default: 0.3)

### `memory.findSimilarMemories(memoryId, opts?)`
Find memories similar to an existing memory.

**Options:**
- `minSimilarity` - Minimum similarity threshold (default: 0.8)
- `limit` - Maximum results (default: 5)

### `memory.forget(memoryId)`
Delete a memory.

### `memory.getContext(query, opts?)`
Get relevant context for the current query (memories + recent messages).

### `memory.createTask(task)`
Create a task with optional hierarchy.

**Options:** `title`, `description`, `priority`, `dueAt`, `parentTaskId`

### `memory.updateTask(taskId, updates)`
Update task properties.

### `memory.deleteTask(taskId)`
Delete a task.

### `memory.getTasks(opts?)`
Get tasks with filters.

**Options:** `status`, `userId`, `limit`

### `memory.getSubtasks(parentTaskId)`
Get all subtasks of a parent task.

### `memory.getTaskWithSubtasks(taskId)`
Get a task with all its subtasks (hierarchical view).

### `memory.getUpcomingTasks(opts?)`
Get tasks due soon (default: next 24 hours).

### `memory.learn(learning)`
Record a learning for future reference.

**Options:** `category`, `trigger`, `lesson`, `action`, `severity`

### `memory.getLearnings(opts?)`
Get recorded learnings.

**Options:** `category`, `severity`, `limit`

### `memory.searchLearnings(query, opts?)`
Search learnings by topic.

### `memory.applyLearning(learningId)`
Mark a learning as applied (increments usage count).

### `memory.extractEntities(text, opts?)`
Extract named entities from text using AI.

**Returns:** Array of entities (person, place, organization, product, concept)

### `memory.createEntity(entity)`
Manually create an entity.

### `memory.updateEntity(entityId, updates)`
Update an entity (increments mention count).

### `memory.findEntity(nameOrAlias)`
Find an entity by name or alias (case-insensitive).

### `memory.searchEntities(opts?)`
Search entities with filters.

**Options:** `query`, `entityType`, `limit`

### `memory.mergeEntities(primaryId, duplicateId)`
Merge duplicate entities (deduplication).

### `memory.createEntityRelationship(rel)`
Create or update a relationship between entities.

**Parameters:**
- `sourceEntityId` - Source entity UUID
- `targetEntityId` - Target entity UUID
- `relationshipType` - Type: `works_at`, `knows`, `created`, `located_in`, etc.
- `properties` - Optional additional context
- `confidence` - Confidence score 0-1 (default: 0.5)
- `sessionId` - Optional source session

**Returns:** EntityRelationship

### `memory.getEntityRelationships(entityId, opts?)`
Get relationships for an entity.

**Options:**
- `direction` - `'outgoing'` | `'incoming'` | `'both'` (default: `'both'`)
- `relationshipType` - Filter by type
- `minConfidence` - Minimum confidence threshold (default: 0.3)
- `limit` - Maximum results (default: 50)

**Returns:** Array of `{ relationship, relatedEntity, direction }`

### `memory.findRelatedEntities(entityId, opts?)`
Find entities connected through multi-hop relationships (graph traversal).

**Options:**
- `maxDepth` - Maximum hops (default: 2)
- `minConfidence` - Minimum confidence threshold (default: 0.5)

**Returns:** Array of `{ entityId, entityName, entityType, relationshipPath, totalConfidence, depth }`

### `memory.getEntityNetworkStats()`
Get entity network statistics.

**Returns:** `{ totalEntities, totalRelationships, avgConnectionsPerEntity, mostConnectedEntity }`

### `memory.extractEntitiesWithRelationships(text, opts?)`
Extract entities AND relationships from text using AI (one call).

**Returns:** `{ entities: Entity[], relationships: EntityRelationship[] }`

### `memory.searchRelationships(opts?)`
Search relationships with filters.

**Options:** `relationshipType`, `minConfidence`, `limit`

### `memory.deleteEntityRelationship(relationshipId)`
Delete a relationship.

### `memory.decayMemoryImportance(opts?)`
Apply importance decay to old memories (lifecycle management).

**Options:**
- `userId` - Filter by user
- `decayRate` - Decay rate 0-1 (default: 0.1)
- `minImportance` - Minimum importance threshold (default: 0.1)
- `olderThanDays` - Only decay memories older than X days (default: 7)

**Returns:** `{ updated: number, avgDecay: number }`

### `memory.consolidateMemories(opts?)`
Merge similar/duplicate memories to reduce clutter.

**Options:**
- `userId` - Filter by user
- `similarityThreshold` - Similarity threshold 0-1 (default: 0.9)
- `category` - Filter by category
- `limit` - Max pairs to check (default: 100)

**Returns:** `{ merged: number, kept: number }`

### `memory.versionMemory(memoryId)`
Create a version snapshot of a memory.

**Returns:** `{ memory, versionId }`

### `memory.getMemoryVersions(memoryId)`
Get version history for a memory.

**Returns:** Array of `{ version, timestamp, content, importance }`

### `memory.tagMemory(memoryId, tags)`
Add tags to a memory for organization.

### `memory.untagMemory(memoryId, tags)`
Remove tags from a memory.

### `memory.searchMemoriesByTags(tags, opts?)`
Search memories by tags.

**Options:**
- `matchAll` - If true, must match ALL tags; if false, match ANY (default: false)
- `limit` - Maximum results (default: 50)

### `memory.cleanupOldSessions(opts?)`
Archive or delete old sessions (maintenance).

**Options:**
- `olderThanDays` - Archive sessions older than X days (default: 90)
- `action` - 'archive' or 'delete' (default: 'archive')
- `keepSummaries` - Keep sessions with summaries (default: true)
- `userId` - Filter by user

**Returns:** `{ archived?: number, deleted?: number }`

### `memory.getCleanupStats()`
Get cleanup statistics for monitoring.

**Returns:** `{ totalSessions, archivedSessions, oldSessions, totalMessages, orphanedMessages }`

## Integration with OpenClaw/Clawdbot

This package is designed to integrate with [Clawdbot](https://github.com/clawdbot/clawdbot):

```typescript
// In your agent's AGENTS.md equivalent
// Instead of reading MEMORY.md, use:
const context = await memory.getContext(userMessage);
```

## Roadmap

### ✅ Completed
- [x] CLI for memory management
- [x] Markdown import/export
- [x] Semantic search (OpenAI embeddings)
- [x] Hybrid search (vector + keyword)
- [x] Vector similarity functions
- [x] Automatic session summarization
- [x] Entity extraction from conversations
- [x] Session export/import (markdown)
- [x] Memory extraction from sessions
- [x] Task hierarchy (subtasks)
- [x] Learning application tracking
- [x] Context window budgeting & management
- [x] **Memory importance decay over time**
- [x] **Memory consolidation (merge similar)**
- [x] **Memory versioning (historical snapshots)**
- [x] **Memory tagging system**
- [x] **Auto-cleanup old sessions**
- [x] **Cleanup statistics & monitoring**

### 🚧 In Progress
- [ ] Voyage AI embedding provider
- [ ] Local embeddings (transformers.js)
- [ ] Clawdbot skill integration

### 📋 Planned
- [ ] Multi-agent memory sharing
- [ ] Entity relationship tracking table
- [ ] Memory migration tools (MEMORY.md → DB)
- [ ] Real-time subscriptions
- [ ] Memory access logging
- [ ] Memory reactions/ratings

## Contributing

PRs welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
