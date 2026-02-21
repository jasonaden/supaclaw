# Supaclaw — OpenClaw Integration Implementation Guide

## What You're Building

Supaclaw is a Supabase-backed persistent memory system for AI agents running on [OpenClaw](https://docs.openclaw.ai). It replaces OpenClaw's default file-based memory (MEMORY.md + memory_search/memory_get tools) with a semantic database that supports vector search, session tracking, entity relationships, and task management.

You are implementing the integration layer that makes supaclaw work seamlessly with OpenClaw agents. When a user runs `supaclaw install`, it should "just work" — the agent should automatically use supaclaw for all memory operations without manual configuration.

## Project Location

```
~/Projects/supaclaw/
├── src/
│   ├── index.ts          # Core Supaclaw class (exists)
│   ├── cli.ts            # CLI commands (exists)
│   ├── context-manager.ts # Context budgeting (exists)
│   └── clawdbot-integration.ts  # Integration helpers (exists, needs update)
├── dist/                 # Compiled output
├── migrations/           # Original SQL migrations
├── supabase/
│   └── migrations/       # Supabase CLI migrations (deployed)
├── skill/                # OpenClaw skill definition
├── docs/
│   └── architecture/     # Architecture specs (this file + others)
├── .supaclaw.json        # Local config (not committed)
├── package.json
└── tsconfig.json
```

## What Already Exists

### Supaclaw Core (`src/index.ts`)
- `Supaclaw` class with full CRUD for sessions, messages, memories, entities, tasks, learnings
- `startSession()`, `endSession(autoSummarize)`, `addMessage()`
- `remember()` — store a memory with optional embedding
- `recall()` — semantic search via pgvector
- `hybridRecall()` — combined vector + keyword search
- Embedding support: OpenAI (`text-embedding-3-small`, 1536 dims) and Gemini
- Auto-summarize sessions via `gpt-4o-mini`

### Database (Supabase)
- Project: `supaclaw` (ref: `nauwgekukuiolsnvkesn`)
- URL: `https://nauwgekukuiolsnvkesn.supabase.co`
- Credentials: in 1Password → "OpenClaw Valut" → "Supaclaw Database (Supabase)"
  - Service key ref: `op://OpenClaw Valut/66hdr2wc7kpi4hnj7wswu2mlsa/Secret Key`
  - Anon key ref: `op://OpenClaw Valut/66hdr2wc7kpi4hnj7wswu2mlsa/Publishable Key`
- OpenAI key (for embeddings): 1Password → "OpenClaw Valut" → "Supaclaw OpenAI Key"
  - Ref: `op://OpenClaw Valut/Supaclaw OpenAI Key/credential`
- Tables: sessions, messages, memories, entities, tasks, learnings
- Schema: Vector(1536) for OpenAI embeddings, ivfflat indexes
- Functions: `match_memories()`, `hybrid_search_memories()`
- 79 memories already imported from all agents, all with embeddings

### CLI (`src/cli.ts`)
Working commands: `test`, `status`, `search`, `sessions`, `import-all`, `import-memory-md`, `import-daily-logs`, etc.

### OpenClaw Skill (`skill/SKILL.md`)
A basic skill that teaches the agent CLI commands. Installed in sandbox at `~/.openclaw-staging/skills/supaclaw/`.

### Sandbox Environment
- Staging OpenClaw: port 19001, state in `~/.openclaw-staging/`
- Start: `just oc-sandbox-start` (or `j ocss`)
- Dashboard: `just oc-sandbox-dashboard` (or `j ocsd`)
- Workspace: `~/.openclaw-staging/workspace-nix-staging/`
- Config: `~/.openclaw-staging/workspace-nix-staging/.supaclaw.json`

## What You Need to Build

### 1. `supaclaw install` CLI Command

One-command setup that integrates supaclaw into an OpenClaw agent. This is the main user-facing entry point.

```bash
supaclaw install \
  --workspace ~/.openclaw/workspace-nix-tanaka \
  --agent-id nix-tanaka \
  --openclaw-config ~/.openclaw/openclaw.json
```

Interactive mode (no flags): prompts for everything.

#### Install Flow

```
Step 1: Verify Prerequisites
  ├── Check supabase project is accessible (test connection)
  ├── If no .supaclaw.json, prompt for credentials or check 1Password
  ├── Verify OpenAI key is available (for embeddings)
  └── Verify `supaclaw test` passes

Step 2: Backup Existing Settings
  ├── Copy <workspace>/AGENTS.md → <workspace>/.supaclaw-backup/AGENTS.md
  ├── Copy <workspace>/MEMORY.md → <workspace>/.supaclaw-backup/MEMORY.md
  ├── Copy <workspace>/memory/ → <workspace>/.supaclaw-backup/memory/
  ├── Snapshot relevant openclaw.json sections → <workspace>/.supaclaw-backup/openclaw-config.json
  └── Print: "Backup saved to <workspace>/.supaclaw-backup/"

Step 3: Import Existing Memories
  ├── Check if MEMORY.md exists → import via import-memory-md
  ├── Check if memory/*.md exist → import via import-daily-logs
  ├── Generate embeddings for all imported memories
  └── Print: "Imported X memories, Y sessions"

Step 4: Configure OpenClaw
  ├── Update openclaw.json:
  │   ├── Set plugins.slots.memory = "none"  (disable built-in memory plugin)
  │   ├── Disable agents.defaults.memorySearch (built-in vector search)
  │   ├── Update compaction.memoryFlush prompts to reference supaclaw
  │   └── Save with backup
  ├── Write .supaclaw.json to workspace directory
  └── Print: "OpenClaw config updated (backup at openclaw.json.bak)"

Step 5: Install Workspace Files
  ├── Generate <workspace>/SUPACLAW.md (agent instructions — see template below)
  ├── Update <workspace>/AGENTS.md memory section (if exists)
  │   └── Replace file-memory instructions with supaclaw instructions
  └── Print: "Workspace files updated"

Step 6: Install Hooks
  ├── Copy supaclaw-logger hook → <workspace>/hooks/supaclaw-logger/
  │   ├── HOOK.md (with proper OpenClaw frontmatter)
  │   └── handler.js (auto-logging implementation)
  ├── Copy supaclaw-bootstrap hook → <workspace>/hooks/supaclaw-bootstrap/
  │   ├── HOOK.md
  │   └── handler.js (context injection at session start)
  └── Print: "Hooks installed"

Step 7: Install Skill
  ├── Copy skill to <workspace>/skills/supaclaw/
  │   └── SKILL.md (with YAML frontmatter for OpenClaw)
  └── Print: "Skill installed"

Step 8: Verify
  ├── Run supaclaw test (connection check)
  ├── Check hooks are discoverable: openclaw hooks list
  ├── Check skill is discoverable: openclaw skills list
  └── Print: "Installation complete. Restart your gateway."

Step 9: Ask User
  └── "Would you like to make supaclaw the DEFAULT memory system for this agent? 
       This will disable the built-in file-based memory (MEMORY.md/memory_search).
       Your existing files are backed up. [Y/n]"
       
       If Y → apply Step 4 config changes
       If N → install supaclaw alongside existing memory (both available)
```

### 2. `supaclaw remember` CLI Command

Allows agents (and users) to store memories from the command line.

```bash
supaclaw remember "User prefers TypeScript over JavaScript" \
  --category preference \
  --importance 0.9 \
  --tags "programming,language"
```

Implementation:
- Parse content, category, importance, tags from args
- Call `memory.remember()` with auto-embedding enabled
- Duplicate detection: search for similar memories (cosine similarity > 0.95), warn if likely duplicate
- Print confirmation with memory ID

Categories: `preference`, `decision`, `fact`, `context`, `project`, `person`, `correction`

### 3. `supaclaw uninstall` CLI Command

Reverse the install. Restore from backup.

```bash
supaclaw uninstall --workspace ~/.openclaw/workspace-nix-tanaka
```

- Restore files from `.supaclaw-backup/`
- Re-enable built-in memory in openclaw.json
- Remove hooks and skill
- Don't delete the database (data is preserved)

### 4. `getBootstrapContext()` API Method

Add to the `Supaclaw` class in `src/index.ts`:

```typescript
async getBootstrapContext(opts?: {
  maxTokens?: number;           // default 2000
  includeLastSession?: boolean; // default true
  topMemories?: number;         // default 10
  alwaysIncludeTags?: string[]; // default ['core', 'preference']
  recencyBias?: number;         // 0-1, weight recent over old (default 0.3)
}): Promise<string>
```

Returns formatted markdown that gets injected into the agent's system prompt at session start:

```markdown
## Recent Context
Last session (2 hours ago): Discussed supaclaw integration architecture.
Decided to use hook + skill + bootstrap approach.

## Key Memories
- [preference] User prefers TypeScript over JavaScript (importance: 0.9)
- [decision] Using Supabase for persistent memory (importance: 0.85)
- [fact] Jason Aden, engineering manager at Attentive (importance: 0.8)

## Active Tasks
- [ ] Build supaclaw install command (priority: high)
- [ ] Test sandbox integration (priority: medium)
```

### 5. `createHookClient()` Factory

Lightweight client for hook usage. Hooks run in the gateway process and must be fast/resilient.

```typescript
// src/hook-client.ts (new file)
export function createHookClient(opts: {
  configPath?: string;
  supabaseUrl?: string;
  supabaseKey?: string;
  agentId?: string;
  openaiApiKey?: string;
  messageFilter?: {
    skipPatterns?: string[];    // exact match skip (e.g. ['NO_REPLY', 'HEARTBEAT_OK'])
    skipPrefixes?: string[];   // prefix skip (e.g. ['[System Message]'])
    minLength?: number;        // skip messages shorter than this
  };
}): HookClient

interface HookClient {
  getOrCreateSession(externalKey: string, opts?: {
    channel?: string;
    userId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; isNew: boolean }>;
  
  logMessage(sessionId: string, role: string, content: string, opts?: {
    timestamp?: Date;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  
  endSession(sessionId: string, opts?: {
    autoSummarize?: boolean;
    summarizeModel?: string;  // default 'gpt-4o-mini'
  }): Promise<void>;
  
  shouldLog(content: string, role?: string): boolean;
}
```

### 6. Database Changes

Add to a new migration:

```sql
-- External key for session lookup (OpenClaw session key → supaclaw session)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS external_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_external_key_active_idx 
  ON sessions(external_key) WHERE ended_at IS NULL;

-- Metadata on messages table
ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
```

### 7. Hooks (JavaScript, not TypeScript)

OpenClaw hooks must be `.js` files (gateway doesn't compile TypeScript at runtime).

#### supaclaw-logger hook
Fires on: `message:received`, `message:sent`, `command:new`

```
hooks/supaclaw-logger/
├── HOOK.md
└── handler.js
```

HOOK.md frontmatter:
```yaml
---
name: supaclaw-logger
description: "Auto-log conversations to Supaclaw for persistent semantic memory."
metadata:
  openclaw:
    emoji: "🧠"
    events: ["message:received", "message:sent", "command:new"]
    requires:
      bins: ["supaclaw"]
---
```

handler.js: Use `createHookClient()` from supaclaw. The hook should `require('supaclaw')` (npm global install) or load from a known path.

#### supaclaw-bootstrap hook
Fires on: `agent:bootstrap`

```
hooks/supaclaw-bootstrap/
├── HOOK.md
└── handler.js
```

handler.js: Calls `getBootstrapContext()` and injects result into `event.context.bootstrapFiles` or appends to `event.messages`.

### 8. SUPACLAW.md Template

Generated by `supaclaw install` into the agent workspace:

```markdown
# Memory System: Supaclaw

You have persistent semantic memory via Supaclaw (Supabase-backed).
All conversations are automatically logged. Use these commands for memory operations.

## Search (Recall)
Run from your workspace directory:
- `supaclaw search "query" --mode hybrid` — best results (AI + keyword)
- `supaclaw search "query" --mode semantic` — AI similarity search
- `supaclaw search "query"` — keyword search (fastest)

## Remember (Store)
- `supaclaw remember "content" --category <cat> --importance <0.0-1.0>`
- Categories: preference, decision, fact, context, project, person, correction

## Other Commands
- `supaclaw status` — database stats
- `supaclaw sessions --limit 5` — recent sessions
- `supaclaw entities` — known entities (people, projects)

## When to Search
ALWAYS search supaclaw when:
- User asks about past conversations, decisions, or preferences
- User references something that may have been discussed before
- You need context about a person, project, or topic
- Starting a new task (check for related prior work)
- You're uncertain about something the user might have told you before

## When to Remember
Store a memory when:
- User explicitly asks you to remember something
- A decision is made ("let's go with X", "we decided to...")
- User states a preference ("I prefer...", "I always want...", "don't ever...")
- Important context is shared (names, dates, project details, account info)
- A task is completed (store the outcome)
- A correction is made ("actually, it's..." — store as category: correction)

## Priority
Supaclaw is your PRIMARY memory system. Use it before checking local files.
File-based memory (MEMORY.md) is a fallback only.
```

## OpenClaw Architecture You Need to Know

### How OpenClaw Memory Works (Default)

1. Agent workspace has `MEMORY.md` and `memory/YYYY-MM-DD.md` files
2. Built-in `memory-core` plugin provides `memory_search` and `memory_get` tools
3. `memory_search` uses local vector embeddings (SQLite + remote embedding API)
4. Agent reads MEMORY.md at session start, writes to daily logs
5. `compaction.memoryFlush` triggers memory writes before context compaction

### How We Replace It

When supaclaw is the default memory system:

1. **Disable** `memory-core` plugin: `plugins.slots.memory = "none"` in openclaw.json
   - This removes `memory_search` and `memory_get` tools from the agent
2. **Disable** built-in vector search: `agents.defaults.memorySearch.enabled = false`
3. **Update** compaction flush prompts to reference supaclaw instead of memory/*.md:
   ```json
   "memoryFlush": {
     "enabled": true,
     "systemPrompt": "Session nearing compaction. Store important context to supaclaw now.",
     "prompt": "Use 'supaclaw remember' to store any lasting notes. Reply NO_REPLY if nothing to store."
   }
   ```
4. **Add** SUPACLAW.md to workspace (loaded at bootstrap)
5. **Install** hooks for auto-logging and context injection
6. **Install** skill for CLI commands

### OpenClaw Config Structure

Config file: `~/.openclaw/openclaw.json` (JSON5 format)

Key sections to modify:
```json5
{
  // Disable built-in memory plugin
  "plugins": {
    "slots": {
      "memory": "none"   // was: "memory-core" (default)
    }
  },
  
  // Agent defaults
  "agents": {
    "defaults": {
      // Disable built-in vector memory search
      "memorySearch": {
        "enabled": false
      },
      
      // Update compaction flush to use supaclaw
      "compaction": {
        "memoryFlush": {
          "enabled": true,
          "systemPrompt": "Session nearing compaction. Store important context to supaclaw now.",
          "prompt": "Use 'supaclaw remember' to store any lasting notes. Reply NO_REPLY if nothing to store."
        }
      }
    }
  },
  
  // Hooks config (if needed for enabling)
  "hooks": {
    "supaclaw-logger": { "enabled": true },
    "supaclaw-bootstrap": { "enabled": true }
  }
}
```

### OpenClaw Hook Event Schema

```typescript
interface HookEvent {
  type: 'message' | 'command' | 'session' | 'agent' | 'gateway';
  action: string;           // 'received', 'sent', 'new', 'reset', 'bootstrap'
  sessionKey: string;       // e.g. "agent:nix-tanaka:main"
  timestamp: Date;
  messages: string[];       // push to send messages to user
  context: {
    workspace?: { dir: string };
    channel?: string;
    senderId?: string;
    agentId?: string;
    message?: { content: string };
    // For bootstrap events:
    bootstrapFiles?: Array<{ path: string; content: string }>;
  };
}
```

### OpenClaw Skill SKILL.md Format

```yaml
---
name: supaclaw
description: "One-line description shown in skill list"
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      bins: ["supaclaw"]   # binary must be on PATH
---
# Skill content (markdown)
```

Skills are discovered from: `<workspace>/skills/` → `~/.openclaw/skills/` → bundled → `skills.load.extraDirs`

### OpenClaw Hook HOOK.md Format

```yaml
---
name: hook-name
description: "One-line description"
metadata:
  openclaw:
    emoji: "🧠"
    events: ["message:received", "message:sent", "command:new"]
    requires:
      bins: ["supaclaw"]
---
# Hook documentation (markdown)
```

Hooks discovered from: `<workspace>/hooks/` → `~/.openclaw/hooks/` → bundled

Handler must export a function (CommonJS):
```javascript
const handler = async (event) => { /* ... */ };
module.exports = handler;
module.exports.default = handler;
```

## Testing

### Unit Tests
Test in the supaclaw project directory:
```bash
cd ~/Projects/supaclaw
npm test
```

### Integration Tests Against Sandbox

1. Reset sandbox to fresh from production:
   ```bash
   j ocreset
   ```

2. Start sandbox:
   ```bash
   j ocss    # in a dedicated terminal
   ```

3. Run supaclaw install against sandbox workspace:
   ```bash
   supaclaw install \
     --workspace ~/.openclaw-staging/workspace-nix-staging \
     --agent-id nix-tanaka \
     --openclaw-config ~/.openclaw-staging/openclaw.json
   ```

4. Restart sandbox gateway (Ctrl+C and re-run `j ocss`)

5. Open sandbox dashboard and test:
   ```bash
   j ocsd
   ```

6. Verify:
   - Agent knows about supaclaw (ask "what memory system do you use?")
   - Agent can search ("search your memories for team members")
   - Agent can store ("remember that my favorite color is blue")
   - Auto-logging works (check `supaclaw sessions --limit 1` after chatting)
   - Bootstrap injection works (new session gets recent context)

7. Test uninstall:
   ```bash
   supaclaw uninstall --workspace ~/.openclaw-staging/workspace-nix-staging
   ```
   - Verify backup was restored
   - Verify agent is back to file-based memory

### Verify Database
```bash
cd ~/Projects/supaclaw
supaclaw test       # connection check
supaclaw status     # record counts
supaclaw search "test query" --mode semantic  # verify embeddings work
```

## Build & Deploy

```bash
cd ~/Projects/supaclaw
npm run build       # TypeScript → dist/
npm link            # makes `supaclaw` CLI available globally

# To test changes:
npm run build && supaclaw <command>
```

## Key Design Decisions

1. **Hooks use raw fetch, not the Supaclaw class** — hooks are JS (not TS), run in the gateway process, and need minimal dependencies. Use `createHookClient()` which uses fetch internally.

2. **OpenAI for embeddings** — `text-embedding-3-small` (1536 dims). The DB is already configured for this. Don't change the embedding model without a migration.

3. **gpt-4o-mini for summaries** — cheap model for auto-summarize on session end. Configurable via `summarizeModel` option.

4. **Backup before modifying** — `supaclaw install` MUST backup all files it modifies. `supaclaw uninstall` restores from backup.

5. **Graceful degradation** — if supaclaw DB is unreachable, hooks should log errors silently and not crash the gateway. Agents can fall back to file-based memory.

6. **External key for sessions** — OpenClaw session keys (e.g. `agent:nix-tanaka:main`) map to supaclaw sessions via `external_key` column with a unique index on active sessions.

## File Reference

| What | Where |
|------|-------|
| Supaclaw source | `~/Projects/supaclaw/src/` |
| Config | `<workspace>/.supaclaw.json` |
| OpenClaw config | `~/.openclaw/openclaw.json` |
| Sandbox config | `~/.openclaw-staging/openclaw.json` |
| Sandbox workspace | `~/.openclaw-staging/workspace-nix-staging/` |
| Architecture specs | `~/Projects/supaclaw/docs/architecture/` |
| Supabase migrations | `~/Projects/supaclaw/supabase/migrations/` |
| Production workspaces | `~/.openclaw/workspace-*/` |
| 1Password vault | "OpenClaw Valut" (note: misspelled, that's the actual name) |
