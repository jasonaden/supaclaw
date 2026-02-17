# Supaclaw

**Persistent memory for AI agents using Supabase.**

Stop losing context. Stop re-reading massive markdown files. Give your agent a real memory.

[![npm version](https://badge.fury.io/js/supaclaw.svg)](https://www.npmjs.com/package/supaclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## The Problem

AI agents using file-based memory (MEMORY.md, daily logs) face:
- **Context window bloat** — files grow unbounded, eating your token budget
- **Forgetting** — context resets wipe session memory
- **No search** — linear scan through text to find relevant info
- **Unstructured** — can't query "what did we discuss about X?"

## The Solution

Supaclaw uses **Supabase (Postgres)** to give your agent:
- **Session tracking** — every conversation logged with metadata
- **Semantic search** — find relevant memories via vector similarity (pgvector)
- **Smart context** — only load what's relevant, not everything
- **Context window management** — token budgeting, lost-in-middle mitigation
- **Entity relationships** — knowledge graph with multi-hop traversal
- **Tasks & learnings** — structured task tracking and self-improvement records
- **Multi-agent** — share memories across agents via `agent_id` scoping

## Quick Start

```bash
npm install supaclaw
```

```typescript
import { Supaclaw } from 'supaclaw';

const memory = new Supaclaw({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  agentId: 'my-agent',
  embeddingProvider: 'openai',        // optional: enables semantic search
  openaiApiKey: process.env.OPENAI_API_KEY
});

await memory.initialize(); // creates tables on first run

// Sessions & messages
const session = await memory.startSession({ userId: 'user-123' });
await memory.addMessage(session.id, { role: 'user', content: 'I prefer TypeScript' });
await memory.endSession(session.id, { autoSummarize: true });

// Long-term memories
await memory.remember({
  content: 'User prefers TypeScript over JavaScript',
  category: 'preference',
  importance: 0.9
});

// Search (semantic if embeddings enabled, keyword fallback)
const results = await memory.recall('programming language preferences', {
  minSimilarity: 0.7,
  limit: 10
});

// Hybrid search (vector + keyword)
const hybrid = await memory.hybridRecall('coding tips', {
  vectorWeight: 0.7,
  keywordWeight: 0.3
});

// Entity extraction & knowledge graph
const { entities, relationships } = await memory.extractEntitiesWithRelationships(
  'Alice works at TechCorp in San Francisco'
);
const related = await memory.findRelatedEntities(entityId, { maxDepth: 2 });

// Tasks
const task = await memory.createTask({ title: 'Build feature X', priority: 5 });
await memory.addTaskDependency(childTaskId, task.id);

// Learnings
await memory.learn({
  category: 'error',
  trigger: 'Migration failed',
  lesson: 'Always backup before schema changes',
  severity: 'critical'
});

// Smart context for LLM prompts (token-budgeted)
const context = await memory.getSmartContext('project updates', {
  sessionId: session.id,
  model: 'claude-3.5-sonnet'
});
```

## Setup

1. Create a [Supabase](https://supabase.com) project
2. Enable the `vector` extension:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
3. Run migrations:
   ```bash
   npx supaclaw migrate
   ```
4. Set environment variables:
   ```bash
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_KEY=your-anon-key
   OPENAI_API_KEY=sk-...  # optional, for semantic search
   ```

## Architecture

Supaclaw is organized as a facade over domain-specific managers:

| Module | Class | Responsibility |
|--------|-------|---------------|
| `src/index.ts` | `Supaclaw` | Thin facade, constructor, context methods |
| `src/sessions.ts` | `SessionManager` | Conversation lifecycle, message logging |
| `src/memories.ts` | `MemoryManager` | Long-term storage, semantic search, tagging |
| `src/entities.ts` | `EntityManager` | Entity extraction, relationship graph |
| `src/tasks.ts` | `TaskManager` | Task CRUD, dependencies, templates |
| `src/learnings.ts` | `LearningManager` | Self-improvement records, pattern detection |
| `src/maintenance.ts` | `MaintenanceManager` | Session cleanup, stats |
| `src/context-manager.ts` | — | Token budgeting, lost-in-middle mitigation |
| `src/error-handling.ts` | — | Error hierarchy, retry, circuit breaker |

All managers share a `SupaclawDeps` interface (defined in `src/types.ts`) containing the Supabase client, agent ID, and optional OpenAI client.

### Database Schema

Seven tables in Supabase/Postgres, all scoped by `agent_id`:

```
sessions, messages, memories, entities, entity_relationships, tasks, learnings
```

Embeddings use pgvector (`VECTOR(1536)`) with IVFFlat index. See [SCHEMA.md](./SCHEMA.md) for full column definitions.

## Search Modes

| Mode | Method | Needs Embeddings | Best For |
|------|--------|-----------------|----------|
| Keyword | `recall()` | No | Fast exact-term lookups |
| Semantic | `recall()` | Yes | Conceptual/meaning search |
| Hybrid | `hybridRecall()` | Yes | Best overall results |

```typescript
// Keyword (default when no embedding provider)
const kw = await memory.recall('TypeScript', { limit: 10 });

// Semantic (requires embeddingProvider: 'openai')
const sem = await memory.recall('programming best practices', { minSimilarity: 0.75 });

// Hybrid (combines both)
const hyb = await memory.hybridRecall('AI agents', { vectorWeight: 0.7, keywordWeight: 0.3 });
```

## Context Window Management

```typescript
// Simple: auto-budgeted context
const ctx = await memory.getSmartContext('project updates', {
  sessionId: 'current-session',
  model: 'claude-3.5-sonnet'
});

// Advanced: custom budget allocation
import { createContextBudget } from 'supaclaw/context';

const budget = createContextBudget({
  modelContextSize: 200000,
  recentMessagesPct: 0.5,
  memoriesPct: 0.3,
  learningsPct: 0.15,
  entitiesPct: 0.05
});

const result = await memory.buildOptimizedContext({
  query: 'project updates',
  customBudget: budget,
  useLostInMiddleFix: true  // places important items at edges
});
```

See [CONTEXT_WINDOW_GUIDE.md](./docs/guides/CONTEXT_WINDOW_GUIDE.md) for detailed examples.

## CLI

```bash
npx supaclaw init                    # interactive setup
npx supaclaw migrate                 # run database migrations
npx supaclaw status                  # check connection & stats
npx supaclaw search "TypeScript"     # keyword search
npx supaclaw search "best practices" --mode semantic
npx supaclaw search "AI" --mode hybrid --limit 15
npx supaclaw sessions --limit 20 --active
npx supaclaw export memories.md
npx supaclaw import MEMORY.md
npx supaclaw import-all ~/clawd --user-id han  # bulk import
```

## Clawdbot Integration

```typescript
import { createClawdbotIntegration } from 'supaclaw';

const integration = createClawdbotIntegration({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_KEY!,
  agentId: 'my-assistant',
  userId: 'user-1',
  autoLog: true,
  sessionTimeout: 30 * 60 * 1000
});

// Auto-log messages
await integration.logUserMessage(chatId, 'Hello!', { channel: 'telegram' });
await integration.logAssistantMessage(chatId, 'Hi there!');

// Build context for system prompts
const context = await integration.buildContext(userQuery, {
  includeMemories: true,
  includeLearnings: true,
  includeRecentMessages: true
});

// Heartbeat (call periodically)
const { upcomingTasks, inactiveSessions } = await integration.heartbeat();
```

## API Overview

The `Supaclaw` class exposes methods across six domains. Key methods:

**Sessions**: `startSession`, `addMessage`, `endSession`, `resumeSession`, `searchSessions`, `exportSessionToMarkdown`

**Memories**: `remember`, `recall`, `hybridRecall`, `findSimilarMemories`, `forget`, `tagMemory`, `searchMemoriesByTags`, `versionMemory`, `decayMemoryImportance`, `consolidateMemories`

**Entities**: `extractEntities`, `extractEntitiesWithRelationships`, `createEntity`, `findEntity`, `searchEntities`, `mergeEntities`, `createEntityRelationship`, `getEntityRelationships`, `findRelatedEntities`

**Tasks**: `createTask`, `updateTask`, `deleteTask`, `getTasks`, `getSubtasks`, `getUpcomingTasks`, `addTaskDependency`, `getReadyTasks`, `createTaskTemplate`, `applyTaskTemplate`

**Learnings**: `learn`, `getLearnings`, `searchLearnings`, `applyLearning`, `detectLearningPatterns`, `exportLearningsReport`

**Context**: `getContext`, `getSmartContext`, `buildOptimizedContext`

All methods are fully typed. See `src/types.ts` for interfaces.

## Contributing

PRs welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT
