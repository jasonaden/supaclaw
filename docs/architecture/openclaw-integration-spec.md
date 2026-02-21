# OpenClaw Integration Spec

## Overview

This spec defines what supaclaw needs to expose for OpenClaw gateway hooks to auto-log conversations and provide semantic memory to agents.

OpenClaw uses **hooks** — small JS handlers that fire on gateway events (`message:received`, `message:sent`, `command:new`, etc.). The hook needs to call into supaclaw's library to log messages and manage sessions.

## Hook Lifecycle

```
User sends message
  → gateway fires message:received
  → hook: getOrCreateSession() + logMessage(role=user)

Agent responds
  → gateway fires message:sent
  → hook: logMessage(role=assistant)

User runs /new (session reset)
  → gateway fires command:new
  → hook: endSession(autoSummarize=true)
  → next message creates a new session
```

## What the Hook Receives

Each event from OpenClaw includes:

```typescript
{
  type: 'message' | 'command' | 'session' | 'agent',
  action: 'received' | 'sent' | 'new' | 'reset',
  sessionKey: string,        // e.g. "agent:nix-tanaka:main"
  timestamp: Date,
  context: {
    workspace?: { dir: string },  // workspace path (where .supaclaw.json lives)
    channel?: string,             // "telegram", "webchat", "discord", etc.
    senderId?: string,            // user ID from the channel
    message?: { content: string },
    agentId?: string,
  }
}
```

## Required API Surface

### 1. `SupaclawHookClient` (new class or factory)

A lightweight client optimized for hook usage. Hooks run inside the gateway process — they need to be fast, non-blocking, and resilient to errors.

```typescript
import { createHookClient } from 'supaclaw';

// Load config from workspace .supaclaw.json
const client = createHookClient({
  configPath: '/path/to/.supaclaw.json',
  // OR explicit config:
  supabaseUrl: '...',
  supabaseKey: '...',
  agentId: 'nix-tanaka',
  openaiApiKey: '...', // for auto-summarize
});
```

### 2. `getOrCreateSession(externalKey, opts)` ⭐ NEW

Find an existing session by external key, or create one. This is the main gap.

```typescript
const session = await client.getOrCreateSession('agent:nix-tanaka:main', {
  channel: 'telegram',
  userId: 'jason',
  metadata: { source: 'openclaw' },
});
// Returns: { id: 'uuid', isNew: boolean }
```

**Implementation notes:**
- Store `externalKey` in session metadata (e.g. `metadata.external_key`)
- Lookup: query sessions where `metadata->>'external_key' = ?` AND `ended_at IS NULL`
- If found and not ended: return it
- If not found or ended: create new session
- Consider adding an `external_key` column to sessions table for indexed lookups (vs JSONB query)

### 3. `logMessage(sessionId, role, content, opts?)` 

Already exists as `addMessage`. Just needs to work efficiently from a hook context.

```typescript
await client.logMessage(session.id, 'user', 'Hello, what did we decide about X?', {
  timestamp: event.timestamp,
  channel: 'telegram',
});
```

**Requirements:**
- Fire-and-forget friendly (don't block the gateway)
- Skip messages matching filter patterns (NO_REPLY, HEARTBEAT_OK, system messages)
- Optional: batch/buffer messages and flush periodically (reduces DB round-trips)

### 4. `endSession(sessionId, opts?)`

Already exists. Needs to work with the cheap summarize model.

```typescript
await client.endSession(session.id, {
  autoSummarize: true,
  summarizeModel: 'gpt-4o-mini', // cheap model
});
```

**Requirements:**
- `summarizeModel` option to override the default model for cost control
- Graceful if session has no messages (skip summarize)
- Should handle being called multiple times safely (idempotent)

### 5. Message Filtering

The hook shouldn't log noise. Supaclaw should provide or respect a filter:

```typescript
const client = createHookClient({
  // ...config
  messageFilter: {
    skipPatterns: ['NO_REPLY', 'HEARTBEAT_OK'],
    skipPrefixes: ['[System Message]'],
    minLength: 1,
    skipRoles: [], // e.g. skip 'system' messages
  },
});
```

Or expose a `shouldLog(content, role)` method the hook can call.

## Optional / Nice-to-Have

### 6. Auto-embed on log

When a user message comes in that's substantial (not just "yes" or "ok"), generate an embedding and store as a memory. This gives semantic search over conversation history, not just imported MEMORY.md content.

```typescript
await client.logMessage(session.id, 'user', content, {
  autoRemember: true,         // extract & store as memory if substantial
  minRememberLength: 50,      // only auto-remember messages > 50 chars
  rememberImportance: 0.5,    // default importance for auto-remembered
});
```

### 7. Context injection helper

When an agent needs relevant context, supaclaw should provide a formatted string for injection into the system prompt:

```typescript
const context = await client.getRelevantContext(userMessage, {
  limit: 5,
  mode: 'hybrid',
  maxTokens: 500,  // budget for context injection
});
// Returns formatted markdown string:
// ## Relevant Memories
// - [preference] User prefers TypeScript
// - [decision] We chose Supabase over Firebase for memory
```

### 8. Batch message logging

For high-throughput scenarios, buffer messages and flush periodically:

```typescript
const client = createHookClient({
  // ...config
  batchMode: true,
  flushIntervalMs: 5000,  // flush every 5 seconds
  maxBatchSize: 20,        // or when buffer hits 20 messages
});

// Messages are buffered
await client.logMessage(...); // instant return, queued

// Explicit flush if needed
await client.flush();
```

## Database Changes Needed

### New column on `sessions` table:

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS external_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_external_key_active_idx 
  ON sessions(external_key) WHERE ended_at IS NULL;
```

This enables fast lookup of active sessions by OpenClaw session key.

### New column on `messages` table (if not exists):

```sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
```

For storing channel info, timestamps, etc.

## Example Hook Implementation (consumer side)

Once supaclaw exposes this API, the OpenClaw hook becomes trivial:

```javascript
// hooks/supaclaw-logger/handler.js
const { createHookClient } = require('supaclaw');

let client = null;

const handler = async (event) => {
  if (!client) {
    client = createHookClient({
      configPath: event.context?.workspace?.dir + '/.supaclaw.json',
    });
  }

  if (event.type === 'message') {
    const role = event.action === 'received' ? 'user' : 'assistant';
    const content = event.context?.message?.content;
    if (!content) return;

    const session = await client.getOrCreateSession(event.sessionKey, {
      channel: event.context?.channel,
      userId: event.context?.senderId,
    });

    await client.logMessage(session.id, role, content);

  } else if (event.type === 'command' && event.action === 'new') {
    const session = await client.getOrCreateSession(event.sessionKey);
    if (!session.isNew) {
      await client.endSession(session.id, { autoSummarize: true });
    }
  }
};

module.exports = handler;
module.exports.default = handler;
```

## Priority

1. **Must have:** `createHookClient`, `getOrCreateSession`, `logMessage`, `endSession` with model override
2. **Should have:** message filtering, `external_key` column
3. **Nice to have:** auto-remember, context injection, batch mode

## Testing

Test against the sandbox environment:
- Supabase project: `supaclaw` (ref: `nauwgekukuiolsnvkesn`)
- Sandbox gateway: port 19001 (`j ocss` to start)
- Sandbox dashboard: `j ocsd`
- Config: `~/.openclaw-staging/workspace-nix-staging/.supaclaw.json`
