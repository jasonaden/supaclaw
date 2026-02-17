# Supaclaw - Clawdbot Skill

**Status:** Phase 10 (Clawdbot Integration)  
**Version:** 1.0.0-beta  
**Category:** Memory & Context Management

## Overview

Supaclaw is a comprehensive memory system that replaces traditional file-based memory (MEMORY.md, TODO.md, etc.) with a semantic, searchable database.

**What it solves:**
- ✅ No more loading 50KB MEMORY.md every turn
- ✅ Semantic search finds only relevant memories
- ✅ Auto-logging of all conversations
- ✅ Session continuity across restarts
- ✅ Task tracking with dependencies
- ✅ Learning capture and retrieval

## Quick Start

### 1. Install & Setup

```bash
# Install from npm
npm install -g supaclaw

# Or use the local build
cd /Users/hankim/clawd/supaclaw
npm run build
npm link

# Initialize (creates database, runs migrations)
supaclaw init

# Import existing Clawdbot memories
supaclaw import-all ~/clawd --user-id han
```

### 2. Configure Environment

Add to your `.env` or environment:

```bash
export SUPABASE_URL="your-supabase-url"
export SUPABASE_KEY="your-supabase-anon-key"
export OPENAI_API_KEY="sk-..." # For embeddings & auto-summarization
```

### 3. Integration with Clawdbot

Supaclaw integrates seamlessly with Clawdbot through:
1. **Auto-logging** - Every message is automatically captured
2. **Semantic search** - Replaces `memory_search` with vector search
3. **Context injection** - Relevant memories auto-loaded into prompts
4. **Session tracking** - Conversations are structured and resumable

## CLI Commands

### Memory Management

```bash
# Search memories semantically
supaclaw search "user preferences for code style"

# Get all memories in a category
supaclaw memories --category preferences

# Export memories to markdown
supaclaw export ~/backup/memories.md
```

### Session Management

```bash
# List recent sessions
supaclaw sessions --limit 20

# Export a session to markdown
supaclaw session <session-id> --export

# Resume a session (get context)
supaclaw resume <session-id>
```

### Task Management

```bash
# List pending tasks
supaclaw tasks --status pending

# Create a new task
supaclaw task create "Finish Phase 10" --priority 3

# Update task status
supaclaw task update <task-id> --status done

# Get upcoming tasks (due soon)
supaclaw tasks --upcoming 24h
```

### Learning Management

```bash
# List all learnings
supaclaw learnings

# Search learnings by topic
supaclaw learnings --search "API errors"

# Export learnings report
supaclaw learnings --export ~/learnings-report.md
```

### Database

```bash
# Show database status
supaclaw status

# Run migrations
supaclaw migrate

# Test connection
supaclaw test
```

## Programmatic Usage (TypeScript/JavaScript)

```typescript
import { Supaclaw } from 'supaclaw';

const memory = new Supaclaw({
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_KEY!,
  agentId: 'hans-assistant',
  embeddingProvider: 'openai',
  openaiApiKey: process.env.OPENAI_API_KEY
});

await memory.initialize();

// Start a session (Clawdbot does this automatically)
const session = await memory.startSession({
  userId: 'han',
  channel: 'telegram'
});

// Add messages (auto-logged by Clawdbot)
await memory.addMessage(session.id, {
  role: 'user',
  content: 'What's the stock price of TSLA?'
});

await memory.addMessage(session.id, {
  role: 'assistant',
  content: 'Tesla is currently trading at $245.'
});

// Store important facts as memories
await memory.remember({
  content: 'User is actively trading stocks, focus on TSLA',
  category: 'context',
  importance: 0.8,
  sessionId: session.id
});

// Semantic search (replaces memory_search)
const relevant = await memory.recall('user stock preferences', {
  userId: 'han',
  limit: 5
});

// End session with auto-summary
await memory.endSession(session.id, { autoSummarize: true });
```

## Integration Hooks

### Auto-Logging Messages

When integrated with Clawdbot, every message is automatically logged:

```typescript
// In your Clawdbot message handler
async function handleMessage(msg: Message) {
  const session = await getOrCreateSession(msg.chat.id);
  
  // Log user message
  await memory.addMessage(session.id, {
    role: 'user',
    content: msg.text,
    metadata: { messageId: msg.id, timestamp: msg.date }
  });
  
  // Process with Claude...
  const response = await claude.chat(...);
  
  // Log assistant response
  await memory.addMessage(session.id, {
    role: 'assistant',
    content: response.content,
    metadata: { model: response.model }
  });
}
```

### Replacing memory_search

```typescript
// Old way (file-based)
function memory_search(query: string) {
  const content = fs.readFileSync('~/clawd/MEMORY.md', 'utf-8');
  // ... keyword search on entire file
}

// New way (semantic)
async function memory_search(query: string) {
  const results = await memory.recall(query, {
    userId: 'han',
    limit: 5,
    minImportance: 0.5
  });
  
  return results.map(r => ({
    content: r.content,
    category: r.category,
    importance: r.importance
  }));
}
```

### Replacing memory_get

```typescript
// Old way (file-based)
function memory_get(path: string, from?: number, lines?: number) {
  const content = fs.readFileSync(path, 'utf-8');
  // ... return snippet
}

// New way (database)
async function memory_get(category?: string, limit = 10) {
  return await memory.getMemories({
    userId: 'han',
    category,
    limit
  });
}
```

### Context Injection

Automatically inject relevant memories into the system prompt:

```typescript
async function buildSystemPrompt(userQuery: string) {
  // Get relevant memories
  const memories = await memory.recall(userQuery, {
    userId: 'han',
    limit: 5
  });
  
  // Get recent learnings
  const learnings = await memory.getLearningRecommendations(userQuery, 3);
  
  let prompt = BASE_SYSTEM_PROMPT;
  
  if (memories.length > 0) {
    prompt += '\n\n## Relevant Context\n\n';
    memories.forEach(m => {
      prompt += `- [${m.category}] ${m.content}\n`;
    });
  }
  
  if (learnings.length > 0) {
    prompt += '\n\n## Past Learnings\n\n';
    learnings.forEach(l => {
      prompt += `- ${l.lesson}\n`;
    });
  }
  
  return prompt;
}
```

### Session Lifecycle Hooks

```typescript
// When Clawdbot starts (or user sends first message)
async function onSessionStart(chatId: string, userId: string) {
  const session = await memory.startSession({
    userId,
    channel: 'telegram',
    metadata: { chatId }
  });
  
  // Store session ID for this chat
  sessionMap.set(chatId, session.id);
}

// When conversation ends (timeout, user says goodbye, etc.)
async function onSessionEnd(chatId: string) {
  const sessionId = sessionMap.get(chatId);
  if (!sessionId) return;
  
  // End with auto-summary
  await memory.endSession(sessionId, {
    autoSummarize: true
  });
  
  // Extract important memories
  await memory.extractMemoriesFromSession(sessionId, {
    autoExtract: true,
    minImportance: 0.6
  });
  
  sessionMap.delete(chatId);
}

// Heartbeat check (every 30 min)
async function onHeartbeat() {
  // Check for tasks due soon
  const upcoming = await memory.getTasksNeedingReminders({
    userId: 'han',
    hoursAhead: 2
  });
  
  for (const task of upcoming) {
    const msg = memory.formatTaskReminder(task, task.timeUntilDue);
    await sendNotification('telegram', msg);
  }
}
```

## Schema Overview

### Core Tables

1. **sessions** - Conversation sessions
   - `id`, `agent_id`, `user_id`, `channel`, `started_at`, `ended_at`, `summary`

2. **messages** - All messages in sessions
   - `id`, `session_id`, `role`, `content`, `token_count`, `created_at`

3. **memories** - Long-term memories with embeddings
   - `id`, `agent_id`, `user_id`, `category`, `content`, `importance`, `embedding`, `expires_at`

4. **tasks** - Task tracking
   - `id`, `agent_id`, `user_id`, `title`, `status`, `priority`, `due_at`, `parent_task_id`

5. **learnings** - Captured learnings
   - `id`, `agent_id`, `category`, `trigger`, `lesson`, `action`, `severity`, `applied_count`

6. **entities** - Extracted entities (people, places, concepts)
   - `id`, `agent_id`, `entity_type`, `name`, `aliases`, `description`, `mention_count`

7. **entity_relationships** - Relationships between entities
   - `id`, `source_entity_id`, `target_entity_id`, `relationship_type`, `confidence`

## Migration Guide

### From MEMORY.md

**Before:**
```markdown
## Preferences

- User prefers TypeScript over JavaScript
- Likes concise code without comments

## Projects

Working on Supaclaw. Building AI agents.
```

**After:**
```bash
supaclaw import-memory-md ~/clawd/MEMORY.md
```

**Result:**
- 2 memories in "preferences" category
- 1 memory in "projects" category
- All searchable, no need to load entire file

### From memory/*.md (Daily Logs)

**Before:**
```
~/clawd/memory/
  2024-01-28.md
  2024-01-29.md
  2024-01-30.md
```

**After:**
```bash
supaclaw import-daily-logs ~/clawd/memory --user-id han
```

**Result:**
- Sessions created for each date
- Messages extracted with timestamps
- Fully searchable conversation history

### From TODO.md

**Before:**
```markdown
## Priority: High

- [ ] Finish Phase 10
- [x] Write parsers
```

**After:**
```bash
supaclaw import-todo-md ~/clawd/TODO.md
```

**Result:**
- Tasks with status (pending/done)
- Priority levels preserved
- Due dates extracted from `[due: ...]` tags

### From LEARNINGS.md

**Before:**
```markdown
## Category: Corrections

**Trigger**: User said "actually, I prefer Rust"
**Lesson**: User prefers Rust over TypeScript
```

**After:**
```bash
supaclaw import-learnings-md ~/clawd/LEARNINGS.md
```

**Result:**
- Learnings categorized and searchable
- Applied count tracking
- Retrievable by context

## Performance Notes

**Query Speed:**
- Semantic search: ~100-300ms (includes embedding generation)
- Keyword search: ~10-50ms
- Session retrieval: ~5-20ms

**Token Savings:**
- Before: Load 50KB MEMORY.md = ~12,500 tokens
- After: Load 5 relevant memories = ~500 tokens
- **Savings: ~95% reduction**

**Cost Savings:**
- Embeddings: $0.0001 per 1K tokens (text-embedding-3-small)
- One-time cost to embed 1000 memories: ~$0.10
- Ongoing cost: Only new memories need embedding

## Troubleshooting

### Connection Issues

```bash
# Test database connection
supaclaw test

# Check status
supaclaw status
```

### Missing Tables

```bash
# Run migrations
supaclaw migrate
```

### No Search Results

Check if embeddings are enabled:
```bash
# Verify OPENAI_API_KEY is set
echo $OPENAI_API_KEY

# Search with fallback to keyword
supaclaw search "your query" --fallback
```

### Performance Issues

```bash
# Add indexes (migrations include these)
supaclaw migrate

# Clear expired memories
supaclaw cleanup --expired

# Limit search results
supaclaw search "query" --limit 5
```

## Roadmap

### ✅ Phase 1-9 Complete
- Core memory system
- Session & message logging
- Task & learning tracking
- Import from markdown files
- CLI commands

### 🚧 Phase 10 (Current): Clawdbot Integration
- Auto-logging middleware
- Replace memory_search/memory_get
- Session lifecycle hooks
- Context injection

### 📋 Phase 11 (Next): Polish & Publish
- Error handling & retries
- TypeScript strict mode
- Bundle optimization
- Publish to npm
- GitHub release v1.0.0

## Support

**Repo:** https://github.com/arephan/supaclaw  
**Issues:** https://github.com/arephan/supaclaw/issues  
**Docs:** See `/Users/hankim/clawd/supaclaw/README.md`

## License

MIT - See LICENSE file
