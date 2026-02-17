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

### Core Module (`src/index.ts`)
The `OpenClawMemory` class (~2500 lines) is the main API surface. It wraps a Supabase client and optional OpenAI client for embeddings. All database tables are scoped by `agent_id`. Key domains:
- **Sessions/Messages** — conversation lifecycle (start, add messages, end with optional AI summary)
- **Memories** — long-term storage with importance scores, semantic search (`recall`/`hybridRecall`), tagging, versioning, decay, and consolidation
- **Entities** — named entity extraction/storage with relationship graph (multi-hop traversal via `findRelatedEntities`)
- **Tasks** — hierarchical task tracking with dependencies, templates, and reminders
- **Learnings** — self-improvement records with pattern detection and similarity search
- **Context building** — `getSmartContext`/`buildOptimizedContext` combine all data types with token budgeting

### Supporting Modules
- **`src/context-manager.ts`** — Token budgeting, lost-in-middle mitigation, adaptive budget allocation. Exports `createContextBudget`, `buildContextWindow`, `formatContextWindow`.
- **`src/clawdbot-integration.ts`** — `ClawdbotMemoryIntegration` class wrapping OpenClawMemory for chatbot use (auto-logging, session management, context injection).
- **`src/parsers.ts`** — Parsers for importing Clawdbot file-based memory (MEMORY.md, daily logs, TODO.md, LEARNINGS.md) into database format.
- **`src/error-handling.ts`** — Custom error hierarchy (`OpenClawError` → `DatabaseError`/`EmbeddingError`/`ValidationError`/`RateLimitError`), retry with exponential backoff, circuit breaker pattern.
- **`src/cli.ts`** — Commander-based CLI with 30+ commands. Config stored in `.openclaw-memory.json`.

### Database Schema
Six tables in Supabase/Postgres: `sessions`, `messages`, `memories`, `entities`, `entity_relationships`, `tasks`, `learnings`. Migrations in `migrations/`. Embeddings use pgvector (`VECTOR(1536)`) with IVFFlat index.

## Key Patterns

- All Supabase operations are scoped by `agent_id` — always filter on it
- Embeddings are optional; when `embeddingProvider` is set to `'openai'`, the OpenAI client generates embeddings for memories/entities. Without it, search falls back to keyword matching
- The `remember()` method auto-generates embeddings if a provider is configured
- Entity relationships use `source_entity_id`/`target_entity_id` with confidence scores and `mention_count` that increments on duplicate creation
- Tests use vitest with `beforeEach`/`afterEach` for temp file setup/teardown; integration tests mock Supabase responses

## TypeScript

- Strict mode enabled, target ES2022, CommonJS output
- Source in `src/`, tests in `tests/`, output to `dist/`
- The package exports from `dist/index.js` with type declarations
