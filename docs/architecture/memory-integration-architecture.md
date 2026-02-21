# Memory Integration Architecture

## Problem

When supaclaw is installed, agents need to:
1. **Auto-recall** relevant memories when a conversation starts or context shifts
2. **Search** supaclaw when the user references past decisions, preferences, or context
3. **Store** new memories when the user says something worth remembering
4. **Prefer** supaclaw over file-based memory (MEMORY.md) for recall

The agent shouldn't need manual workspace edits to know about supaclaw. Installation should "just work."

## Architecture Options

### Option A: Skill Only
The skill SKILL.md teaches the agent CLI commands. Agent decides when to use them.

**Pros:** Simple, no code changes to OpenClaw or supaclaw
**Cons:** Agent has to "remember to remember." Relies on the agent reading the skill and choosing to use it. Inconsistent behavior. Doesn't solve auto-recall at session start.

### Option B: Hook Only  
Hooks handle everything — logging, recall injection, memory extraction.

**Pros:** Zero agent involvement, deterministic behavior
**Cons:** Hooks run in the gateway, not in the agent's reasoning loop. A hook can inject context at bootstrap, but can't make the agent store new memories mid-conversation. Limited to event-driven triggers.

### Option C: Hook + Skill + Bootstrap Injection (Recommended)
Combine all three mechanisms, each doing what it's best at:

| Layer | What it does | When it runs |
|-------|-------------|-------------|
| **Hook: supaclaw-logger** | Auto-logs all messages to DB | Every message (fire-and-forget) |
| **Hook: supaclaw-bootstrap** | Injects recent memories into system prompt at session start | `agent:bootstrap` event |
| **Skill: supaclaw** | Teaches agent CLI commands for search, remember, tasks | When agent needs to recall or store |
| **Bootstrap file** | Adds memory instructions to agent's startup context | Session init |

## Recommended Architecture (Option C)

### Layer 1: Auto-Logging Hook (`supaclaw-logger`)
**Already built.** Fires on `message:received` and `message:sent`. Logs everything to sessions/messages tables. Agent doesn't know about this.

### Layer 2: Bootstrap Context Hook (`supaclaw-bootstrap`) — NEW

A new hook that fires on `agent:bootstrap`. It:
1. Reads the last N messages from the most recent session (continuity)
2. Pulls high-importance memories (preferences, decisions, key facts)
3. Formats them and injects into the agent's bootstrap context

```
Event: agent:bootstrap
→ Query supaclaw for:
  - Last session summary (if resuming)
  - Top 10 memories by importance (agent-scoped)
  - Any memories tagged "always-inject"
→ Format as markdown
→ Inject via event.context.bootstrapFiles or event.messages
```

This means every time the agent starts a session, it already has relevant context — no agent action required.

**What supaclaw needs to expose:**
```typescript
// Get bootstrap context for an agent
const context = await client.getBootstrapContext(agentId, {
  maxTokens: 2000,          // budget for injected context
  includeLastSession: true,  // summary of previous session
  topMemories: 10,           // highest importance memories
  alwaysIncludeTags: ['core', 'preference', 'always-inject'],
});
// Returns: formatted markdown string ready for injection
```

### Layer 3: Skill (`supaclaw`)
**Already built.** Teaches the agent the CLI commands. But needs better guidance on WHEN to use them.

The skill SKILL.md should include decision logic:

```markdown
## When to Search Supaclaw

ALWAYS search supaclaw when:
- User asks about past conversations ("what did we discuss...", "remember when...")
- User references a decision, preference, or prior context
- You need context about a person, project, or topic
- You're unsure about something that might have been discussed before
- Starting a new task (check for related context)

## When to Store in Supaclaw

Store a memory when:
- User explicitly says to remember something
- A decision is made ("let's go with X")
- User states a preference ("I prefer...", "I always want...")
- Important context is shared (names, dates, project details)
- A task is completed (store the outcome)

Use: supaclaw remember "content" --category <category> --importance <0.0-1.0>
Categories: preference, decision, fact, context, project, person
```

### Layer 4: Bootstrap File (auto-generated on install)

When supaclaw is installed, it should auto-generate a bootstrap file that gets loaded into the agent's workspace. This is the "instruction manual" that's always in context.

**File:** `<workspace>/SUPACLAW.md` (or injected via bootstrap-extra-files hook)

```markdown
# Memory System: Supaclaw

You have persistent memory via Supaclaw (Supabase-backed semantic search).

## Your Memory Capabilities
- **Search:** `supaclaw search "query" --mode hybrid` (semantic + keyword)
- **Remember:** `supaclaw remember "content" --category <cat> --importance <0-1>`
- **Status:** `supaclaw status`

## Rules
1. When the user asks about anything from the past → search supaclaw FIRST
2. When something important is said → store it in supaclaw
3. Don't rely solely on file-based MEMORY.md — supaclaw is your primary memory
4. Recent context is auto-injected at session start (you'll see it below)

## Categories for Storing
- `preference` — user likes/dislikes, workflow preferences
- `decision` — choices made ("we went with Postgres over Mongo")
- `fact` — key information (birthdays, account IDs, addresses)
- `project` — project context, architecture decisions
- `person` — info about people
- `context` — general context worth remembering
```

## Installation Flow

When a user installs supaclaw for an agent, the setup should:

```
1. supaclaw install --agent <agent-id>
   ├── Create/verify .supaclaw.json in workspace
   ├── Generate <workspace>/SUPACLAW.md (bootstrap instructions)
   ├── Install supaclaw-logger hook (auto-log messages)
   ├── Install supaclaw-bootstrap hook (inject context on session start)
   ├── Register supaclaw skill (CLI reference)
   └── Run initial memory import (if MEMORY.md exists)

2. Restart gateway to pick up hooks

3. Agent automatically:
   ├── Gets SUPACLAW.md in bootstrap context
   ├── Gets recent memories injected at session start
   ├── Knows to search supaclaw for recall
   ├── Knows to store important things
   └── All messages are auto-logged
```

## What Supaclaw Needs to Build

### CLI: `supaclaw install`
New command that handles the full integration setup:

```bash
supaclaw install \
  --workspace ~/.openclaw/workspace-nix-tanaka \
  --hooks-dir ~/.openclaw/hooks \
  --agent-id nix-tanaka
```

What it does:
1. Writes `.supaclaw.json` to workspace (prompts for credentials if needed)
2. Generates `SUPACLAW.md` in workspace
3. Copies hook files to hooks directory
4. Registers skill (or symlinks)
5. Imports existing MEMORY.md if present
6. Prints "restart your gateway to activate"

### CLI: `supaclaw remember`
New command for the agent to store memories from the CLI:

```bash
supaclaw remember "User prefers TypeScript over JavaScript" \
  --category preference \
  --importance 0.9 \
  --tags "programming,language"
```

This wraps `memory.remember()` with auto-embedding.

### API: `getBootstrapContext(agentId, opts)`
Returns formatted markdown for injection into agent bootstrap:

```typescript
async getBootstrapContext(agentId: string, opts?: {
  maxTokens?: number;        // default 2000
  includeLastSession?: boolean;  // default true
  topMemories?: number;      // default 10
  alwaysIncludeTags?: string[];  // default ['core', 'preference']
  recencyBias?: number;      // 0-1, weight recent memories higher
}): Promise<string>
```

Returns something like:
```markdown
## Recent Context (from last session)
Last session (2 hours ago): Discussed supaclaw integration architecture.
Decided to use hook + skill + bootstrap approach.

## Key Memories
- [preference] User prefers TypeScript over JavaScript (importance: 0.9)
- [decision] Using Supabase for persistent memory (importance: 0.85)
- [fact] Jason Aden, engineering manager at Attentive (importance: 0.8)
- [project] Supaclaw: semantic memory for AI agents (importance: 0.8)
```

### API: `remember(content, opts)` — enhancement
Already exists but needs:
- Auto-embedding on store (already works with embeddingProvider)
- `--tags` support from CLI
- Duplicate detection (don't store "user prefers TS" if it already exists)

### Hook: `supaclaw-bootstrap` — NEW
Fires on `agent:bootstrap`, calls `getBootstrapContext()`, injects result.

## Migration Path

For existing agents with file-based memory:

```bash
# Import existing memories (already works)
supaclaw import-all ~/.openclaw/workspace-nix-tanaka --user-id jason

# Full install (new)
supaclaw install --workspace ~/.openclaw/workspace-nix-tanaka --agent-id nix-tanaka

# Restart gateway
openclaw gateway restart
```

File-based memory (MEMORY.md, memory/*.md) continues to work alongside supaclaw. The bootstrap file tells the agent to prefer supaclaw but doesn't break anything if supaclaw is down.

## Priority

1. **`supaclaw remember` CLI** — agents need to store memories
2. **`supaclaw install` CLI** — one-command setup
3. **`getBootstrapContext()` API** — context injection at session start
4. **`supaclaw-bootstrap` hook** — auto-inject on bootstrap
5. **Duplicate detection** — don't store the same memory twice
6. **`SUPACLAW.md` template** — generated on install

## Testing

All testing should happen in the sandbox first:
- Sandbox gateway: `j ocss` (port 19001)
- Sandbox dashboard: `j ocsd`
- Sandbox workspace: `~/.openclaw-staging/workspace-nix-staging/`
- Supaclaw config: `~/.openclaw-staging/workspace-nix-staging/.supaclaw.json`
- Reset sandbox: `j ocreset` (fresh copy from production)
