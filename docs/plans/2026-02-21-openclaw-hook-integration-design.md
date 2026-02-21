# OpenClaw Hook Integration Design

## Overview

Add a hook client API and webhook receiver to supaclaw so OpenClaw gateway hooks (and external services) can auto-log conversations and manage sessions in Supabase.

Two integration paths:
1. **JS library** (`createHookClient`) — for Node.js consumers that import supaclaw directly
2. **Supabase Edge Function** — HTTP webhook receiver for external services

Both share the same database schema and business logic.

## Database Changes

### Migration: `external_key` on sessions

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS external_key TEXT;
CREATE UNIQUE INDEX sessions_external_key_active_idx
  ON sessions(external_key) WHERE ended_at IS NULL;
```

Partial unique index: only one active session per external key. Ended sessions keep their key for history.

### Migration: `metadata` on messages

```sql
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
```

For storing channel info, source timestamps on individual messages.

### Migration: `webhook_sources` table

```sql
CREATE TABLE webhook_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  allowed_actions TEXT[] DEFAULT ARRAY['log_message', 'end_session'],
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Tracks authorized webhook integrations. Each source gets a secret; the Edge Function verifies it per-request.

## JS Library: `SupaclawHookClient`

**File:** `src/hook-client.ts`

Thin wrapper around the existing `Supaclaw` class. Adds hook-specific features (batching, filtering, external key session management) while delegating DB operations to Supaclaw.

### Factory

```typescript
import { createHookClient } from 'supaclaw';

const client = createHookClient({
  configPath: '/path/to/.supaclaw.json',
  // OR explicit:
  supabaseUrl: '...',
  supabaseKey: '...',
  agentId: 'nix-tanaka',
  openaiApiKey: '...',

  messageFilter: {
    skipPatterns: ['NO_REPLY', 'HEARTBEAT_OK'],
    skipPrefixes: ['[System Message]'],
    minLength: 1,
    skipRoles: [],
  },

  batchMode: true,
  flushIntervalMs: 5000,
  maxBatchSize: 20,
});
```

### Config resolution

If `configPath` is provided, read `.supaclaw.json` and merge with explicit options (explicit wins).

### Methods

| Method | Description |
|--------|-------------|
| `getOrCreateSession(externalKey, opts?)` | Find active session by external key, or create one. Returns `{ id, isNew }` |
| `logMessage(sessionId, role, content, opts?)` | Log a message. Respects filter. Supports `autoRemember` option |
| `endSession(sessionId, opts?)` | End session with optional `autoSummarize` and `summarizeModel` override |
| `shouldLog(content, role)` | Check if a message passes the filter |
| `getRelevantContext(query, opts?)` | Formatted markdown of relevant memories for prompt injection |
| `flush()` | Manually flush the message buffer |
| `destroy()` | Clear timer, flush remaining, clean up |

### `getOrCreateSession(externalKey, opts?)`

```typescript
const session = await client.getOrCreateSession('agent:nix-tanaka:main', {
  channel: 'telegram',
  userId: 'jason',
  metadata: { source: 'openclaw' },
});
// Returns: { id: 'uuid', isNew: boolean }
```

Implementation:
1. Query sessions where `external_key = ? AND ended_at IS NULL AND agent_id = ?`
2. If found: return `{ id, isNew: false }`
3. If not found: insert new session with external_key, return `{ id, isNew: true }`

### `logMessage(sessionId, role, content, opts?)`

```typescript
await client.logMessage(session.id, 'user', content, {
  timestamp: event.timestamp,
  channel: 'telegram',
  autoRemember: true,
  minRememberLength: 50,
  rememberImportance: 0.5,
});
```

Flow:
1. Check `shouldLog(content, role)` — skip if filtered
2. If `batchMode`: push to buffer, flush if buffer >= maxBatchSize
3. If not batchMode: call `Supaclaw.addMessage()` directly
4. If `autoRemember` and content.length >= minRememberLength: call `Supaclaw.remember()`

### `endSession(sessionId, opts?)`

```typescript
await client.endSession(session.id, {
  autoSummarize: true,
  summarizeModel: 'gpt-4o-mini',
});
```

- Delegates to `Supaclaw.endSession()` with autoSummarize
- `summarizeModel` overrides the model used in `generateSessionSummary` (OpenAI only)
- Idempotent: if session already ended, no-op
- Graceful: if session has no messages, skip summarize

### Message Filtering

```typescript
shouldLog(content: string, role: string): boolean
```

Returns false if:
- content matches any `skipPatterns` (regex)
- content starts with any `skipPrefixes`
- content.length < `minLength`
- role is in `skipRoles`

### Batch Mode

In-memory array buffer. Dual flush trigger:
- `setInterval` at `flushIntervalMs` (default 5000ms)
- Immediate flush when buffer.length >= `maxBatchSize` (default 20)

`flush()` does a batch insert of all buffered messages to the messages table.
`destroy()` clears the interval and performs a final flush.

### Auto-Remember

When `autoRemember: true` on logMessage and content exceeds `minRememberLength`:
- Calls `Supaclaw.remember()` with the content
- Category: `"conversation"`
- Importance: `rememberImportance` (default 0.5)
- Generates embedding if provider configured

### Context Injection

```typescript
const context = await client.getRelevantContext(userMessage, {
  limit: 5,
  mode: 'hybrid',
  maxTokens: 500,
});
// Returns formatted markdown string
```

Wraps `Supaclaw.hybridRecall()`, formats results as:
```markdown
## Relevant Memories
- [preference] User prefers TypeScript
- [decision] We chose Supabase over Firebase
```

## Supabase Edge Functions

### Webhook Receiver: `supabase/functions/supaclaw-webhook/index.ts`

Deno Edge Function. Receives HTTP POST requests from external services.

**Endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| POST | `/log-message` | Log a message to a session |
| POST | `/end-session` | End a session |
| POST | `/get-or-create-session` | Find or create session by external key |

**Auth:** `Authorization: Bearer whsec_...` header. Verified against `webhook_sources.secret_hash`. The matched source's `agent_id` is used for all operations (agent_id is NOT accepted in the request body — prevents impersonation).

**Request format example (log-message):**
```json
{
  "sessionKey": "agent:nix-tanaka:main",
  "role": "user",
  "content": "Hello, what did we decide about X?",
  "channel": "telegram",
  "senderId": "jason"
}
```

**Security constraints:**
- Webhook secret determines agent_id (no agent_id in request body)
- Request body size limit: 100KB
- Rate limiting via Supabase Edge Function built-in limits

### Webhook Admin: `supabase/functions/webhook-admin/index.ts`

Serves admin UI and handles CRUD for webhook sources.

- **GET /** — serves HTML admin page
- **GET /sources** — list webhook sources for authenticated user
- **POST /sources** — register new webhook source, returns secret once
- **DELETE /sources/:id** — revoke/delete a source
- **PATCH /sources/:id** — enable/disable a source

Protected by Supabase Auth (JWT). The HTML page uses Supabase JS client for auth (magic link).

## CLI Commands

Added to `src/cli.ts`:

- `supaclaw webhook register --name <name> --agent-id <id>` — generate secret, store hash, print secret once
- `supaclaw webhook list` — show registered sources (name, agent, status, created)
- `supaclaw webhook revoke <id>` — disable a source

## File Changes

### New files
- `src/hook-client.ts` — SupaclawHookClient class + createHookClient factory
- `tests/hook-client.test.ts` — unit tests
- `supabase/functions/supaclaw-webhook/index.ts` — webhook receiver
- `supabase/functions/webhook-admin/index.ts` — admin UI
- `supabase/migrations/XXXX_add_external_key.sql`
- `supabase/migrations/XXXX_add_message_metadata.sql`
- `supabase/migrations/XXXX_create_webhook_sources.sql`

### Modified files
- `src/index.ts` — add `getOrCreateSession` to Supaclaw class, export hook-client
- `src/cli.ts` — add `webhook` command group
- `package.json` — no new dependencies

## Testing (TDD)

Tests written before implementation. Test structure:

**`tests/hook-client.test.ts`:**
- Config resolution (configPath vs explicit, merge behavior)
- `getOrCreateSession` — returns existing, creates new, handles concurrent calls
- `shouldLog` — all filter conditions (patterns, prefixes, minLength, roles)
- `logMessage` — respects filter, batch vs immediate, auto-remember trigger
- `endSession` — autoSummarize, model override, idempotent on already-ended session
- `getRelevantContext` — formatting, limit, mode options
- Batch mode — buffer fills, timer flush, size flush, destroy cleanup
- `flush` — batch insert, empty buffer no-op

**`tests/webhook-security.test.ts`:**
- Secret verification (valid, invalid, revoked, disabled)
- Agent_id extraction from matched source
- Missing auth header rejection

All tests mock Supabase responses (no live DB in unit tests).

## Decisions

- **Summarization:** OpenAI only. `summarizeModel` overrides model name (default gpt-4o-mini).
- **Architecture:** Thin wrapper class in `src/hook-client.ts`, delegates to Supaclaw internally.
- **External key:** Dedicated indexed column, not JSONB metadata query.
- **Batch mode:** Timer + size hybrid with explicit flush/destroy.
- **Webhook security:** Per-source secrets stored as hashes in `webhook_sources` table.
- **Management:** CLI commands for automation + admin UI (Edge Function) for visual management.
- **TDD:** Tests first, then implementation.
