# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Supaclaw is an npm library (`supaclaw`) that provides persistent memory for AI agents using Supabase (Postgres). It replaces file-based memory (MEMORY.md, daily logs) with structured database storage including semantic search via pgvector, entity relationships, context window management, and session tracking.

## Commands

```bash
npm run build          # TypeScript compile (tsc) → dist/
npm run dev            # TypeScript watch mode
npm test               # Run all tests with vitest
npx vitest run tests/parsers.test.ts  # Run a single test file
```

The CLI is at `dist/cli.js` (bin: `supaclaw`). Test CLI commands via `npx supaclaw <command>`.

## Architecture

### Facade (`src/index.ts`)
The `Supaclaw` class is a thin facade (~650 lines) that delegates to domain-specific managers. It supports two constructor modes:
- **Config mode** — `new Supaclaw({ supabaseUrl, supabaseKey, agentId, ... })` creates its own Supabase/OpenAI clients
- **DI mode** — `new Supaclaw({ supabase, agentId, config })` accepts pre-built clients (used in tests)

All managers are exposed as readonly properties: `sessions`, `memories`, `entities`, `tasks`, `learnings`, `maintenance`. The facade re-exports delegate methods for backward compatibility (e.g., `memory.remember()` calls `memory.memories.remember()`). Context-building methods (`getSmartContext`, `buildOptimizedContext`, etc.) live on the facade.

### Domain Modules
- **`src/sessions.ts`** — `SessionManager`: conversation lifecycle (start, add messages, end with optional AI summary, resume, export/import)
- **`src/memories.ts`** — `MemoryManager`: long-term storage with importance scores, semantic search (`recall`/`hybridRecall`), tagging, versioning, decay, consolidation
- **`src/entities.ts`** — `EntityManager`: named entity extraction/storage with relationship graph (multi-hop traversal via `findRelatedEntities`)
- **`src/tasks.ts`** — `TaskManager`: hierarchical task tracking with dependencies, templates, reminders
- **`src/learnings.ts`** — `LearningManager`: self-improvement records with pattern detection and similarity search
- **`src/maintenance.ts`** — `MaintenanceManager`: session cleanup, cleanup stats
- **`src/types.ts`** — All shared interfaces and the `SupaclawDeps` DI interface
- **`src/utils.ts`** — `sanitizeFilterInput()` for PostgREST injection prevention

### Supporting Modules
- **`src/context-manager.ts`** — Token budgeting, lost-in-middle mitigation, adaptive budget allocation. Exports `createContextBudget`, `buildContextWindow`, `formatContextWindow`.
- **`src/clawdbot-integration.ts`** — `ClawdbotMemoryIntegration` class wrapping Supaclaw for chatbot use (auto-logging, session management, context injection).
- **`src/parsers.ts`** — Parsers for importing Clawdbot file-based memory (MEMORY.md, daily logs, TODO.md, LEARNINGS.md) into database format.
- **`src/error-handling.ts`** — Custom error hierarchy (`SupaclawError` → `DatabaseError`/`EmbeddingError`/`ValidationError`/`RateLimitError`), retry with exponential backoff, circuit breaker pattern. Domain modules use `wrapDatabaseOperation()` and `wrapEmbeddingOperation()` wrappers.
- **`src/cli.ts`** — Commander-based CLI with 30+ commands. Config stored in `.supaclaw.json`.

### Database Schema
Six tables in Supabase/Postgres: `sessions`, `messages`, `memories`, `entities`, `entity_relationships`, `tasks`, `learnings`. Migrations in `migrations/`. Embeddings use pgvector (`VECTOR(1536)`) with IVFFlat index.

## Key Patterns

- All Supabase operations are scoped by `agent_id` — always filter on it
- Embeddings are optional; when `embeddingProvider` is set to `'openai'`, the OpenAI client generates embeddings for memories/entities. Without it, search falls back to keyword matching
- The `remember()` method auto-generates embeddings if a provider is configured
- Entity relationships use `source_entity_id`/`target_entity_id` with confidence scores and `mention_count` that increments on duplicate creation
- Domain managers accept `SupaclawDeps` (defined in `src/types.ts`) — use DI constructor in tests to inject mock Supabase clients
- User-supplied filter values must go through `sanitizeFilterInput()` from `src/utils.ts` before use in `.or()` or `.ilike()` PostgREST calls
- Tests use vitest with `globals: true` (configured in `vitest.config.ts`); integration tests that need real Supabase use `describe.skipIf(!hasSupabase)` guards

## TypeScript

- Strict mode with `noUncheckedIndexedAccess` and `noPropertyAccessFromIndexSignature` enabled
- Target ES2022, CommonJS output
- Source in `src/`, tests in `tests/`, output to `dist/`
- Package exports subpaths: `.` (main), `./errors`, `./context`
- Use bracket notation for `process.env` and `Record<string, unknown>` access
