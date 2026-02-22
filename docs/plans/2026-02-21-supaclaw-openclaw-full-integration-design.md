# Supaclaw-OpenClaw Full Integration Design

## Overview

Integrate supaclaw as the primary memory system for OpenClaw agents using a hybrid approach: a proper memory plugin for search/recall tools, hooks for auto-logging and bootstrap context injection, and a skill for explicit CLI operations.

The goal is human-like memory — agents proactively store things they'd otherwise forget, recall feels natural, and conversations feel continuous across sessions.

## Design Decisions

1. **Hybrid integration** — memory plugin for `memory_search`/`memory_get` tools (native OpenClaw), hooks for auto-logging + bootstrap injection, skill for explicit `remember`/`search` CLI
2. **Always replace** — install always makes supaclaw the primary memory system (disables built-in `memory-core`)
3. **Idempotent install** — state machine with progress tracked in `.supaclaw-install.json`, resumable from any step
4. **No duplicate detection on remember** — duplicates are harmless (two search results reinforce each other)
5. **Provider-agnostic summarization** — OpenAI, Anthropic (Haiku), or Gemini for session summaries; separate from embedding provider
6. **Bootstrap context excludes tasks** — task system is being redesigned; `getBootstrapContext()` only assembles sessions + memories
7. **Full memory migration** — import all existing file-based memories, daily logs, TODOs, learnings, and generate embeddings for everything
8. **npm link for hooks** — hooks `require('supaclaw')` assuming global link; install command handles this

## Architecture

### Layer Overview

| Layer | What it does | How it integrates |
|-------|-------------|-------------------|
| **Memory Plugin** (`memory-supaclaw`) | Provides `memory_search` and `memory_get` tools backed by Supabase/pgvector | OpenClaw plugin slot system |
| **Hook: supaclaw-logger** | Auto-logs all messages to sessions/messages tables | OpenClaw hook: `message:received`, `message:sent`, `command:new` |
| **Hook: supaclaw-bootstrap** | Injects recent context into agent system prompt at session start | OpenClaw hook: `agent:bootstrap` |
| **Skill: supaclaw** | Teaches agent `supaclaw remember`, `supaclaw search`, and when to use them | OpenClaw skill discovery |
| **SUPACLAW.md** | Agent instructions — when to store, when to search, memory philosophy | Workspace bootstrap file |
| **Memory Flush config** | Tells agent to store durable memories to supaclaw before compaction | OpenClaw compaction config |

### Data Flow

```
User sends message
  -> gateway fires message:received
  -> supaclaw-logger hook: getOrCreateSession() + logMessage()

Agent needs context
  -> agent calls memory_search (provided by memory-supaclaw plugin)
  -> plugin calls hybridRecall() against Supabase
  -> returns snippets to agent

Agent learns something important
  -> agent runs `supaclaw remember "..."` (taught by skill + SUPACLAW.md)
  -> CLI calls remember() with auto-embedding

Session starts
  -> supaclaw-bootstrap hook fires
  -> calls getBootstrapContext()
  -> injects recent session summary + top memories into system prompt

Context nearing compaction
  -> OpenClaw fires memoryFlush
  -> agent stores durable notes via `supaclaw remember`
  -> compaction happens, but important context is persisted
```

### Human Memory Principle

Three triggers for storing memories:

1. **Explicit** — user says "remember this" -> store immediately
2. **Implicit** — agent recognizes a decision, preference, correction, or important fact -> store proactively
3. **Defensive** — context nearing compaction -> memoryFlush prompt triggers the agent to persist anything it would lose

Bootstrap injection means the agent never starts cold — it always has recent context.

## Deliverables

### 1. Memory Plugin (`memory-supaclaw/`)

```
memory-supaclaw/
├── openclaw.plugin.json    # manifest: kind "memory", config schema
├── index.ts                # register(api) — provides memory_search, memory_get
└── package.json            # depends on supaclaw
```

**`openclaw.plugin.json`:**
```json
{
  "id": "memory-supaclaw",
  "name": "Supaclaw Memory",
  "kind": "memory",
  "configSchema": {
    "type": "object",
    "properties": {
      "supabaseUrl": { "type": "string" },
      "supabaseKey": { "type": "string" },
      "agentId": { "type": "string" },
      "embeddingProvider": { "type": "string", "enum": ["openai", "gemini"] },
      "embeddingModel": { "type": "string" },
      "openaiApiKey": { "type": "string" },
      "geminiApiKey": { "type": "string" }
    },
    "required": ["supabaseUrl", "supabaseKey", "agentId"]
  },
  "uiHints": {
    "supabaseKey": { "label": "Supabase Service Key", "sensitive": true },
    "openaiApiKey": { "label": "OpenAI API Key", "sensitive": true },
    "geminiApiKey": { "label": "Gemini API Key", "sensitive": true }
  }
}
```

**`index.ts`** provides:
- `memory_search` — wraps `supaclaw.hybridRecall()` for semantic + keyword search
- `memory_get` — wraps memory retrieval by ID or category

**Caveat:** The plugin API (`register(api)`, `api.registerTool`) is aspirational. Structure follows the OpenClaw memory plugin doc but needs validation against the real gateway.

### 2. `supaclaw remember` CLI Command

```bash
supaclaw remember "User prefers TypeScript over JavaScript" \
  --category preference \
  --importance 0.9 \
  --tags "programming,language"
```

- Positional arg: content (required)
- `--category`: preference, decision, fact, context, project, person, correction (default: context)
- `--importance`: float 0.0-1.0 (default: 0.5)
- `--tags`: comma-separated
- Auto-generates embedding if embeddingProvider is configured
- Prints: `Stored memory <id> [category] (importance: 0.9)`

### 3. `getBootstrapContext()` API Method

Added to `Supaclaw` class in `src/index.ts`:

```typescript
async getBootstrapContext(opts?: {
  maxTokens?: number;           // default 2000
  includeLastSession?: boolean; // default true
  topMemories?: number;         // default 10
  alwaysIncludeTags?: string[]; // default ['core', 'preference']
  recencyBias?: number;         // 0-1 (default 0.3)
}): Promise<string>
```

Assembles (in priority order, within token budget):
1. **Last session summary** — most recent ended session's summary, or last 3 messages as snippet
2. **Top memories** — sorted by `importance * (1 - recencyBias) + recency_score * recencyBias`, always including memories with `alwaysIncludeTags`

Token budgeting: 4 chars ~= 1 token. Fills sections in priority order, stops when budget hit.

Output format:
```markdown
## Recent Context
Last session (2 hours ago): Discussed supaclaw integration architecture.

## Key Memories
- [preference] User prefers TypeScript over JavaScript (importance: 0.9)
- [decision] Using Supabase for persistent memory (importance: 0.85)
```

### 4. Hooks (JavaScript, CommonJS)

#### supaclaw-logger

Fires on: `message:received`, `message:sent`, `command:new`

- Uses `createHookClient()` from supaclaw (already built)
- On message events: `getOrCreateSession()` + `logMessage()`
- On `command:new`: `endSession(autoSummarize: true)`
- Fire-and-forget, error-tolerant (logs errors silently, never crashes gateway)

#### supaclaw-bootstrap

Fires on: `agent:bootstrap`

- Calls `getBootstrapContext()` on the Supaclaw instance
- Injects result into `event.context.bootstrapFiles` or `event.messages`
- Error-tolerant (if supaclaw is unreachable, agent starts without injected context)

### 5. Summarization Provider Config

Provider-agnostic session summarization:

```json
{
  "summarizeProvider": "anthropic",
  "summarizeModel": "claude-haiku-4-5-20251001",
  "summarizeApiKey": "sk-ant-..."
}
```

Supported: `openai` (gpt-4o-mini), `anthropic` (haiku), `gemini` (gemini-flash).

Install command explains clearly:
- **Embeddings** — convert text to vectors for semantic search (must stay consistent)
- **Summarization** — auto-summarize sessions when they end (can change anytime)

### 6. `supaclaw install` CLI Command

Idempotent state machine. Progress tracked in `<workspace>/.supaclaw-install.json`:

```json
{
  "version": 1,
  "agentId": "nix-tanaka",
  "startedAt": "2026-02-21T...",
  "completedSteps": ["verify_prereqs", "backup"],
  "currentStep": "import_memories",
  "config": { "workspacePath": "...", "openclawConfigPath": "...", "agentId": "..." }
}
```

Re-run behavior: skip completed steps, resume from `currentStep`. `--force` starts fresh.

#### Steps

**Step 1: verify_prereqs**
- Check Supabase connection (`supaclaw test`)
- Resolve credentials: `.supaclaw.json` -> 1Password (`op read`) -> interactive prompt
- Verify embedding provider key
- Check supaclaw is linked globally

**Step 2: backup**
- Copy AGENTS.md, MEMORY.md, memory/, openclaw.json snapshot to `.supaclaw-backup/`
- Record backup manifest in state file

**Step 3: import_memories**
- 3a: MEMORY.md -> memories table (existing `import-memory-md`)
- 3b: memory/*.md daily logs -> sessions + messages (existing `import-daily-logs`)
- 3c: SQLite index session transcripts -> messages (NEW, best-effort)
- 3d: TODO.md -> tasks table (existing `import-todo-md`)
- 3e: LEARNINGS.md -> learnings table (existing `import-learnings-md`)
- 3f: Batch generate embeddings for all imported content without embeddings
- 3g: Print summary ("Imported: 47 memories, 12 sessions, 3 tasks, 5 learnings")

Each sub-step checks for existing data before inserting (content hash + agent_id).

**Step 4: install_plugin**
- Copy `memory-supaclaw/` plugin to `~/.openclaw/extensions/memory-supaclaw/`
- Update openclaw.json:
  - `plugins.slots.memory = "memory-supaclaw"`
  - `plugins.entries.memory-supaclaw = { enabled: true, config: {...} }`
  - `agents.defaults.memorySearch.enabled = false`
- Write `.supaclaw.json` to workspace

**Step 5: configure_flush**
- Update openclaw.json `compaction.memoryFlush`:
  - systemPrompt -> reference supaclaw
  - prompt -> "Use supaclaw remember to store lasting notes"
- Configure summarization provider

**Step 6: workspace_files**
- Generate SUPACLAW.md (memory philosophy + commands)
- Update AGENTS.md memory section (if exists)

**Step 7: install_hooks**
- Copy supaclaw-logger -> `<workspace>/hooks/supaclaw-logger/` (HOOK.md + handler.js)
- Copy supaclaw-bootstrap -> `<workspace>/hooks/supaclaw-bootstrap/` (HOOK.md + handler.js)

**Step 8: install_skill**
- Copy skill to `<workspace>/skills/supaclaw/`

**Step 9: verify**
- `supaclaw test` (DB connection)
- Check plugin exists at expected path
- Check hooks exist at expected paths
- Print: "Installation complete. Restart your gateway."
- Mark state file as `"status": "complete"`

### 7. `supaclaw uninstall` CLI Command

```bash
supaclaw uninstall --workspace ~/.openclaw/workspace-nix-tanaka
```

- Restore files from `.supaclaw-backup/`
- Remove memory-supaclaw plugin from `~/.openclaw/extensions/`
- Reset `plugins.slots.memory` to `"memory-core"` in openclaw.json
- Re-enable `agents.defaults.memorySearch.enabled = true`
- Restore original memoryFlush config
- Remove hooks and skill from workspace
- Don't delete database data (preserved for potential re-install)

### 8. SUPACLAW.md Template

Generated by install into workspace. Teaches the agent memory philosophy:

```markdown
# Memory System: Supaclaw

You have persistent semantic memory via Supaclaw (Supabase-backed).
All conversations are automatically logged. Your memory_search tool
queries this database. Use these commands for explicit memory operations.

## Search (Recall)
- memory_search tool — use this for semantic recall (preferred)
- `supaclaw search "query" --mode hybrid` — CLI fallback

## Remember (Store)
- `supaclaw remember "content" --category <cat> --importance <0.0-1.0>`
- Categories: preference, decision, fact, context, project, person, correction

## When to Search
ALWAYS search when:
- User asks about past conversations, decisions, or preferences
- User references something that may have been discussed before
- You need context about a person, project, or topic
- Starting a new task (check for related prior work)

## When to Remember
Store a memory when:
- User explicitly asks you to remember something
- A decision is made ("let's go with X", "we decided to...")
- User states a preference ("I prefer...", "I always want...", "don't ever...")
- Important context is shared (names, dates, project details)
- A correction is made ("actually, it's...")
- You feel like you might forget something important

## Priority
Supaclaw is your PRIMARY memory system. Recent context is auto-injected
at session start. Use memory_search for recall. Use supaclaw remember
to store anything you don't want to lose.
```

## What Already Exists

- `SupaclawHookClient` + `createHookClient()` factory (`src/hook-client.ts`)
- `getOrCreateSession()` on Supaclaw class (`src/index.ts`)
- `getRelevantContext()` on hook client
- Message filtering, batch mode, auto-remember
- Webhook receiver + admin Edge Functions
- Webhook CLI commands (register, list, revoke)
- DB migrations for external_key, metadata, webhook_sources
- Import commands: import-memory-md, import-daily-logs, import-todo-md, import-learnings-md, import-all
- Existing skill at `skill/SKILL.md`

## What Needs to Be Built

- Memory plugin (`memory-supaclaw/` directory with manifest + entry)
- `supaclaw remember` CLI command
- `supaclaw install` CLI command (state machine, 9 steps)
- `supaclaw uninstall` CLI command
- `getBootstrapContext()` on Supaclaw class
- Provider-agnostic summarization (Anthropic + Gemini support)
- Hook JS files (supaclaw-logger/handler.js, supaclaw-bootstrap/handler.js)
- Hook HOOK.md files
- SUPACLAW.md template
- OpenClaw config modification logic
