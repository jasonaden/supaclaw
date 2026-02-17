# Supaclaw - Database Schema

## Core Tables

### 1. `sessions`
Every conversation gets a session. This is the primary organizational unit.

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,           -- Which agent (main, subagent, etc.)
  user_id TEXT,                      -- Who they're talking to
  channel TEXT,                      -- telegram, discord, webchat, etc.
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  summary TEXT,                      -- AI-generated session summary
  metadata JSONB DEFAULT '{}'        -- Flexible additional data
);
```

### 2. `messages`
Every message in every session. The raw conversation log.

```sql
CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                -- 'user', 'assistant', 'system', 'tool'
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  token_count INT,                   -- Track usage
  metadata JSONB DEFAULT '{}'        -- Tool calls, attachments, etc.
);
```

### 3. `memories`
Distilled, long-term memories. The "important stuff" extracted from sessions.

```sql
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  user_id TEXT,                      -- Whose memory (null = global)
  category TEXT,                     -- 'preference', 'fact', 'decision', 'task', etc.
  content TEXT NOT NULL,
  importance FLOAT DEFAULT 0.5,      -- 0-1 score for retrieval prioritization
  source_session_id UUID REFERENCES sessions(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,            -- Optional TTL for temporary memories
  embedding VECTOR(1536),            -- For semantic search (OpenAI ada-002 dimensions)
  metadata JSONB DEFAULT '{}'
);

-- Index for vector similarity search
CREATE INDEX memories_embedding_idx ON memories 
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### 4. `entities`
People, places, things the agent knows about.

```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,         -- 'person', 'place', 'project', 'tool', etc.
  name TEXT NOT NULL,
  aliases TEXT[],                    -- Alternative names
  description TEXT,
  properties JSONB DEFAULT '{}',     -- Flexible key-value properties
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  mention_count INT DEFAULT 1,
  embedding VECTOR(1536),
  
  UNIQUE(agent_id, entity_type, name)
);
```

### 5. `tasks`
Persistent task tracking (replaces TODO.md).

```sql
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  user_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending',     -- 'pending', 'in_progress', 'blocked', 'done'
  priority INT DEFAULT 0,
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  source_session_id UUID REFERENCES sessions(id),
  parent_task_id UUID REFERENCES tasks(id),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 6. `learnings`
Self-improvement records (replaces LEARNINGS.md).

```sql
CREATE TABLE learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  category TEXT NOT NULL,            -- 'error', 'correction', 'improvement', 'capability_gap'
  trigger TEXT NOT NULL,             -- What caused this learning
  lesson TEXT NOT NULL,              -- What was learned
  action TEXT,                       -- What to do differently
  severity TEXT DEFAULT 'info',      -- 'info', 'warning', 'critical'
  source_session_id UUID REFERENCES sessions(id),
  applied_count INT DEFAULT 0,       -- How many times this learning was used
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);
```

## Key Features

### 1. Session Summarization
When a session ends (or grows too long), automatically summarize it:
- Extract key decisions
- Note new entities/relationships
- Create memories from important facts
- Store summary in session record

### 2. Semantic Memory Search
Instead of loading entire MEMORY.md:
```sql
-- Find relevant memories for current context
SELECT content, importance, created_at
FROM memories
WHERE agent_id = $1
ORDER BY embedding <=> $2  -- Vector similarity
LIMIT 10;
```

### 3. Context Window Management
Before each response, pull relevant context:
- Recent messages from current session
- Relevant memories (semantic search)
- Active tasks
- Entity info for mentioned people/things

### 4. Multi-Agent Memory Sharing
Agents can share memories:
```sql
-- Get memories shared across all agents
SELECT * FROM memories 
WHERE agent_id = 'shared' 
AND user_id = $1;
```

## Migration Strategy

### From Markdown to Supabase
1. Parse existing MEMORY.md → memories table
2. Parse daily logs → sessions + messages
3. Parse TODO.md → tasks table
4. Parse LEARNINGS.md → learnings table
5. Keep markdown as backup/fallback

## API Design (npm package)

```typescript
import { Supaclaw } from 'supaclaw';

const memory = new Supaclaw({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  agentId: 'main'
});

// Start a session
const session = await memory.startSession({ 
  userId: 'han', 
  channel: 'telegram' 
});

// Log messages
await memory.addMessage(session.id, { 
  role: 'user', 
  content: 'Hello!' 
});

// Create a memory
await memory.remember({
  content: 'Han prefers concise responses',
  category: 'preference',
  importance: 0.8
});

// Search memories
const relevant = await memory.recall('user preferences', { limit: 5 });

// End session with summary
await memory.endSession(session.id, { 
  summary: 'Discussed project requirements...' 
});
```

## Benefits Summary

| Problem | Solution |
|---------|----------|
| Context window limits | Only load relevant memories via semantic search |
| Forgetting across sessions | Persistent database with session history |
| Unstructured data | SQL queries, typed schemas, relationships |
| No search | pgvector semantic search + full-text search |
| Single agent | Multi-agent memory sharing |
| Manual memory curation | Auto-extract from conversations |
