# Supaclaw-OpenClaw Full Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Integrate supaclaw as the primary memory system for OpenClaw agents via a hybrid approach — memory plugin for native search/recall, hooks for auto-logging and bootstrap, skill for explicit CLI.

**Architecture:** Idempotent `supaclaw install` state machine orchestrates: backup existing memory, import all memories into Supabase with embeddings, install a memory plugin (providing `memory_search`/`memory_get`), copy hooks for auto-logging and bootstrap context injection, and generate workspace instructions. Provider-agnostic summarization supports OpenAI, Anthropic, and Gemini.

**Tech Stack:** TypeScript (strict), Supabase/pgvector, Commander CLI, vitest, CommonJS hooks (JS)

**Design doc:** `docs/plans/2026-02-21-supaclaw-openclaw-full-integration-design.md`

**Security note:** Use `execFileSync`/`spawnSync` (not `execSync`) for subprocess calls to prevent shell injection. Never interpolate user input into shell strings.

---

## Task 1: `supaclaw remember` CLI Command

The simplest deliverable — gets us a working `remember` command before tackling the install flow.

**Files:**
- Modify: `src/cli.ts:2046-2048` (add command before webhook section)
- Test: `tests/remember-cli.test.ts` (create)

**Step 1: Write the failing test**

Create `tests/remember-cli.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Supaclaw } from '../src/index';

// Mock Supabase
function createMockSupabase() {
  const mockChain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    limit: vi.fn().mockReturnThis(),
  };
  return {
    from: vi.fn().mockReturnValue(mockChain),
    rpc: vi.fn(),
    _chain: mockChain,
  };
}

describe('supaclaw remember', () => {
  let mockSupabase: ReturnType<typeof createMockSupabase>;
  let supaclaw: Supaclaw;

  beforeEach(() => {
    mockSupabase = createMockSupabase();
    supaclaw = new Supaclaw({
      supabaseUrl: 'http://localhost:54321',
      supabaseKey: 'test-key',
      agentId: 'test-agent',
    });
    (supaclaw as any).supabase = mockSupabase;
  });

  it('should store a memory with default importance and category', async () => {
    const memoryData = {
      id: 'mem-1',
      agent_id: 'test-agent',
      content: 'User prefers TypeScript',
      category: 'context',
      importance: 0.5,
      metadata: {},
    };
    mockSupabase._chain.single.mockResolvedValue({ data: memoryData, error: null });

    const result = await supaclaw.remember({
      content: 'User prefers TypeScript',
    });

    expect(result).toEqual(memoryData);
    expect(mockSupabase.from).toHaveBeenCalledWith('memories');
  });

  it('should store a memory with explicit category and importance', async () => {
    const memoryData = {
      id: 'mem-2',
      agent_id: 'test-agent',
      content: 'User prefers TypeScript',
      category: 'preference',
      importance: 0.9,
      metadata: {},
    };
    mockSupabase._chain.single.mockResolvedValue({ data: memoryData, error: null });

    const result = await supaclaw.remember({
      content: 'User prefers TypeScript',
      category: 'preference',
      importance: 0.9,
    });

    expect(result.category).toBe('preference');
    expect(result.importance).toBe(0.9);
  });
});
```

**Step 2: Run test to verify it passes (these test existing `remember()` behavior)**

Run: `npx vitest run tests/remember-cli.test.ts`
Expected: PASS (these test existing Supaclaw.remember which already works)

**Step 3: Add the `remember` CLI command**

In `src/cli.ts`, before the `// ============ WEBHOOK COMMANDS ============` section (line ~2047), add:

```typescript
program
  .command('remember <content>')
  .description('Store a memory with auto-embedding')
  .option('--category <category>', 'Memory category (preference, decision, fact, context, project, person, correction)', 'context')
  .option('--importance <number>', 'Importance score 0.0-1.0', '0.5')
  .option('--tags <tags>', 'Comma-separated tags')
  .action(async (content: string, options: { category: string; importance: string; tags?: string }) => {
    const config = loadConfig();
    if (!config) {
      console.error('No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    const { Supaclaw } = await import('./index');
    const supaclaw = new Supaclaw({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      agentId: config.agentId,
      embeddingProvider: config.embeddingProvider,
      openaiApiKey: config.openaiApiKey,
      geminiApiKey: config.geminiApiKey,
      embeddingModel: config.embeddingModel,
    });

    const importance = parseFloat(options.importance);
    if (isNaN(importance) || importance < 0 || importance > 1) {
      console.error('Importance must be a number between 0.0 and 1.0');
      process.exit(1);
    }

    const validCategories = ['preference', 'decision', 'fact', 'context', 'project', 'person', 'correction'];
    if (!validCategories.includes(options.category)) {
      console.error(`Invalid category. Must be one of: ${validCategories.join(', ')}`);
      process.exit(1);
    }

    const memory = await supaclaw.remember({
      content,
      category: options.category,
      importance,
    });

    // Tag if requested
    if (options.tags) {
      const tags = options.tags.split(',').map(t => t.trim()).filter(Boolean);
      if (tags.length > 0) {
        await supaclaw.tagMemory(memory.id, tags);
      }
    }

    console.log(`Stored memory ${memory.id} [${options.category}] (importance: ${importance})`);
  });
```

**Step 4: Build and manually verify**

Run: `npm run build && npx supaclaw remember --help`
Expected: Shows help for the remember command with options

**Step 5: Commit**

```bash
git add src/cli.ts tests/remember-cli.test.ts
git commit -m "feat: add supaclaw remember CLI command"
```

---

## Task 2: Provider-Agnostic Summarization

Currently `generateSessionSummary()` only supports OpenAI. Add Anthropic and Gemini support.

**Files:**
- Modify: `src/index.ts:118-133` (constructor — add Anthropic/Gemini client setup)
- Modify: `src/index.ts:14-22` (SupaclawConfig interface — add summarize fields)
- Modify: `src/index.ts:333-360` (generateSessionSummary — multi-provider)
- Test: `tests/summarization.test.ts` (create)

**Step 1: Write the failing test**

Create `tests/summarization.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Supaclaw } from '../src/index';

function createMockSupabase() {
  const mockChain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
  };
  return {
    from: vi.fn().mockReturnValue(mockChain),
    rpc: vi.fn(),
    _chain: mockChain,
  };
}

describe('generateSessionSummary', () => {
  it('should use Anthropic when summarizeProvider is anthropic', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Summary from Anthropic' }],
      }), { status: 200 })
    );

    const mockSupabase = createMockSupabase();
    const supaclaw = new Supaclaw({
      supabaseUrl: 'http://localhost:54321',
      supabaseKey: 'test-key',
      agentId: 'test-agent',
      summarizeProvider: 'anthropic',
      summarizeModel: 'claude-haiku-4-5-20251001',
      summarizeApiKey: 'sk-ant-test',
    });
    (supaclaw as any).supabase = mockSupabase;

    // Mock getMessages to return some messages
    mockSupabase._chain.range.mockResolvedValue({
      data: [
        { role: 'user', content: 'Hello', created_at: '2026-02-21T00:00:00Z' },
        { role: 'assistant', content: 'Hi there', created_at: '2026-02-21T00:01:00Z' },
      ],
      error: null,
    });

    const summary = await supaclaw.generateSessionSummary('session-1');
    expect(summary).toBe('Summary from Anthropic');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
      })
    );

    fetchSpy.mockRestore();
  });

  it('should use Gemini when summarizeProvider is gemini', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Summary from Gemini' }] } }],
      }), { status: 200 })
    );

    const mockSupabase = createMockSupabase();
    const supaclaw = new Supaclaw({
      supabaseUrl: 'http://localhost:54321',
      supabaseKey: 'test-key',
      agentId: 'test-agent',
      summarizeProvider: 'gemini',
      summarizeModel: 'gemini-2.0-flash',
      summarizeApiKey: 'gemini-test-key',
    });
    (supaclaw as any).supabase = mockSupabase;

    mockSupabase._chain.range.mockResolvedValue({
      data: [
        { role: 'user', content: 'Hello', created_at: '2026-02-21T00:00:00Z' },
      ],
      error: null,
    });

    const summary = await supaclaw.generateSessionSummary('session-1');
    expect(summary).toBe('Summary from Gemini');

    fetchSpy.mockRestore();
  });

  it('should fall back to OpenAI when no summarizeProvider set', async () => {
    const mockSupabase = createMockSupabase();
    const supaclaw = new Supaclaw({
      supabaseUrl: 'http://localhost:54321',
      supabaseKey: 'test-key',
      agentId: 'test-agent',
      openaiApiKey: 'sk-test',
    });
    (supaclaw as any).supabase = mockSupabase;

    // This tests that the existing OpenAI path still works
    // (We won't actually call OpenAI — just verify the method exists)
    expect(typeof supaclaw.generateSessionSummary).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/summarization.test.ts`
Expected: FAIL — `summarizeProvider` not a valid config property yet

**Step 3: Update `SupaclawConfig` interface**

In `src/index.ts:14-22`, add to the `SupaclawConfig` interface:

```typescript
export interface SupaclawConfig {
  supabaseUrl: string;
  supabaseKey: string;
  agentId: string;
  embeddingProvider?: 'openai' | 'gemini' | 'voyage' | 'none';
  openaiApiKey?: string;
  geminiApiKey?: string;
  embeddingModel?: string;
  // Summarization (provider-agnostic)
  summarizeProvider?: 'openai' | 'anthropic' | 'gemini';
  summarizeModel?: string;
  summarizeApiKey?: string;
}
```

**Step 4: Update `generateSessionSummary` for multi-provider**

Replace `src/index.ts:333-360` with a method that dispatches to the right provider:

```typescript
async generateSessionSummary(sessionId: string, model?: string): Promise<string> {
  const messages = await this.getMessages(sessionId);
  if (messages.length === 0) {
    return 'Empty session';
  }

  const conversation = messages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  const systemPrompt = 'Summarize this conversation in 2-3 sentences. Focus on key topics, decisions, and outcomes.';
  const provider = this.config.summarizeProvider || (this.openai ? 'openai' : undefined);

  if (provider === 'anthropic') {
    return this.summarizeWithAnthropic(conversation, systemPrompt, model);
  } else if (provider === 'gemini') {
    return this.summarizeWithGemini(conversation, systemPrompt, model);
  } else if (provider === 'openai' || this.openai) {
    return this.summarizeWithOpenAI(conversation, systemPrompt, model);
  }

  throw new Error('No summarization provider configured. Set summarizeProvider or provide openaiApiKey.');
}

private async summarizeWithOpenAI(conversation: string, systemPrompt: string, model?: string): Promise<string> {
  if (!this.openai) {
    throw new Error('OpenAI API key required for OpenAI summarization');
  }
  const response = await this.openai.chat.completions.create({
    model: model || this.config.summarizeModel || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: conversation },
    ],
    max_tokens: 200,
  });
  return response.choices[0]?.message?.content || 'Unable to generate summary';
}

private async summarizeWithAnthropic(conversation: string, systemPrompt: string, model?: string): Promise<string> {
  const apiKey = this.config.summarizeApiKey;
  if (!apiKey) throw new Error('summarizeApiKey required for Anthropic summarization');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || this.config.summarizeModel || 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: conversation }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic summarization failed: ${response.status} ${err}`);
  }

  const data = await response.json() as { content: Array<{ type: string; text: string }> };
  return data.content?.[0]?.text || 'Unable to generate summary';
}

private async summarizeWithGemini(conversation: string, systemPrompt: string, model?: string): Promise<string> {
  const apiKey = this.config.summarizeApiKey || this.config.geminiApiKey;
  if (!apiKey) throw new Error('summarizeApiKey or geminiApiKey required for Gemini summarization');

  const modelName = model || this.config.summarizeModel || 'gemini-2.0-flash';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: conversation }] }],
        generationConfig: { maxOutputTokens: 200 },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini summarization failed: ${response.status} ${err}`);
  }

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text || 'Unable to generate summary';
}
```

**Step 5: Run tests**

Run: `npx vitest run tests/summarization.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `npm test -- --run`
Expected: All existing tests still pass

**Step 7: Commit**

```bash
git add src/index.ts tests/summarization.test.ts
git commit -m "feat: provider-agnostic summarization (OpenAI, Anthropic, Gemini)"
```

---

## Task 3: `getBootstrapContext()` API Method

Add to the `Supaclaw` class. Returns formatted markdown for injection into agent system prompt.

**Files:**
- Modify: `src/index.ts` (add method to Supaclaw class, before the closing `}` at line ~3014)
- Test: `tests/bootstrap-context.test.ts` (create)

**Step 1: Write the failing test**

Create `tests/bootstrap-context.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Supaclaw } from '../src/index';

function createMockSupabase() {
  const mockChain = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    limit: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    range: vi.fn().mockReturnThis(),
    contains: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
  };
  return {
    from: vi.fn().mockReturnValue(mockChain),
    rpc: vi.fn(),
    _chain: mockChain,
  };
}

function createTestSupaclaw(mockSupabase: ReturnType<typeof createMockSupabase>) {
  const supaclaw = new Supaclaw({
    supabaseUrl: 'http://localhost:54321',
    supabaseKey: 'test-key',
    agentId: 'test-agent',
  });
  (supaclaw as any).supabase = mockSupabase;
  return supaclaw;
}

describe('getBootstrapContext', () => {
  it('should return empty string when no data exists', async () => {
    const mockSupabase = createMockSupabase();
    const supaclaw = createTestSupaclaw(mockSupabase);

    // Mock: no sessions, no memories
    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'sessions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              not: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'memories') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({ data: [], error: null }),
              }),
            }),
          }),
        };
      }
      return mockSupabase._chain;
    });

    const context = await supaclaw.getBootstrapContext();
    expect(context).toBe('');
  });

  it('should include last session summary when available', async () => {
    const mockSupabase = createMockSupabase();
    const supaclaw = createTestSupaclaw(mockSupabase);

    mockSupabase.from.mockImplementation((table: string) => {
      if (table === 'sessions') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              not: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [{
                      id: 'session-1',
                      summary: 'Discussed integration architecture.',
                      ended_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
                      started_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
                    }],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'memories') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              order: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue({
                  data: [{
                    content: 'User prefers TypeScript',
                    category: 'preference',
                    importance: 0.9,
                    created_at: new Date().toISOString(),
                    metadata: { tags: ['core'] },
                  }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return mockSupabase._chain;
    });

    const context = await supaclaw.getBootstrapContext();
    expect(context).toContain('## Recent Context');
    expect(context).toContain('Discussed integration architecture');
    expect(context).toContain('## Key Memories');
    expect(context).toContain('[preference]');
    expect(context).toContain('User prefers TypeScript');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bootstrap-context.test.ts`
Expected: FAIL — `getBootstrapContext` is not a function

**Step 3: Implement `getBootstrapContext`**

Add to `src/index.ts` inside the `Supaclaw` class (before the closing `}` around line 3014):

```typescript
/**
 * Get bootstrap context for agent system prompt injection.
 * Returns formatted markdown with recent session summary and top memories.
 */
async getBootstrapContext(opts?: {
  maxTokens?: number;
  includeLastSession?: boolean;
  topMemories?: number;
  alwaysIncludeTags?: string[];
  recencyBias?: number;
}): Promise<string> {
  const maxTokens = opts?.maxTokens ?? 2000;
  const includeLastSession = opts?.includeLastSession ?? true;
  const topMemories = opts?.topMemories ?? 10;
  const alwaysIncludeTags = opts?.alwaysIncludeTags ?? ['core', 'preference'];
  const recencyBias = opts?.recencyBias ?? 0.3;

  const maxChars = maxTokens * 4; // rough token estimate
  const sections: string[] = [];
  let charsUsed = 0;

  // Section 1: Last session summary
  if (includeLastSession) {
    const { data: recentSessions } = await this.supabase
      .from('sessions')
      .select()
      .eq('agent_id', this.agentId)
      .not('ended_at', 'is', null)
      .order('ended_at', { ascending: false })
      .limit(1);

    if (recentSessions && recentSessions.length > 0) {
      const lastSession = recentSessions[0];
      const endedAt = new Date(lastSession.ended_at);
      const ago = formatTimeAgo(endedAt);

      let sessionText: string;
      if (lastSession.summary) {
        sessionText = lastSession.summary;
      } else {
        // Fall back to last 3 messages
        const messages = await this.getMessages(lastSession.id, { limit: 3 });
        sessionText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
      }

      const section = `## Recent Context\nLast session (${ago}): ${sessionText}`;
      if (charsUsed + section.length <= maxChars) {
        sections.push(section);
        charsUsed += section.length;
      }
    }
  }

  // Section 2: Top memories by importance (with recency weighting)
  const { data: memories } = await this.supabase
    .from('memories')
    .select()
    .eq('agent_id', this.agentId)
    .order('importance', { ascending: false })
    .limit(topMemories * 2); // fetch extra for scoring

  if (memories && memories.length > 0) {
    const now = Date.now();
    const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
    const scored = memories.map(m => {
      const age = now - new Date(m.created_at).getTime();
      const recencyScore = Math.max(0, 1 - age / maxAge);
      const score = m.importance * (1 - recencyBias) + recencyScore * recencyBias;
      const tags = (m.metadata?.tags as string[]) || [];
      const isAlwaysInclude = alwaysIncludeTags.some(t => tags.includes(t));
      return { ...m, score, isAlwaysInclude };
    });

    scored.sort((a, b) => {
      if (a.isAlwaysInclude && !b.isAlwaysInclude) return -1;
      if (!a.isAlwaysInclude && b.isAlwaysInclude) return 1;
      return b.score - a.score;
    });

    const topN = scored.slice(0, topMemories);
    const lines = topN.map(m => {
      const cat = m.category || 'general';
      return `- [${cat}] ${m.content} (importance: ${m.importance})`;
    });

    const section = `## Key Memories\n${lines.join('\n')}`;
    if (charsUsed + section.length <= maxChars) {
      sections.push(section);
    } else {
      // Fit as many lines as possible within budget
      const header = '## Key Memories\n';
      let fitted = header;
      for (const line of lines) {
        if (charsUsed + fitted.length + line.length + 1 <= maxChars) {
          fitted += line + '\n';
        } else break;
      }
      if (fitted.length > header.length) {
        sections.push(fitted.trimEnd());
      }
    }
  }

  return sections.join('\n\n');
}
```

Also add the `formatTimeAgo` helper function outside the class (before exports):

```typescript
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/bootstrap-context.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `npm test -- --run`
Expected: All pass

**Step 6: Commit**

```bash
git add src/index.ts tests/bootstrap-context.test.ts
git commit -m "feat: add getBootstrapContext() for agent system prompt injection"
```

---

## Task 4: Hook JS Files

Create the two OpenClaw hooks as CommonJS JavaScript files. These live in the supaclaw repo and get copied to the workspace by the install command.

**Files:**
- Create: `hooks/supaclaw-logger/HOOK.md`
- Create: `hooks/supaclaw-logger/handler.js`
- Create: `hooks/supaclaw-bootstrap/HOOK.md`
- Create: `hooks/supaclaw-bootstrap/handler.js`

**Step 1: Create supaclaw-logger HOOK.md**

Create `hooks/supaclaw-logger/HOOK.md`:

```markdown
---
name: supaclaw-logger
description: "Auto-log conversations to Supaclaw for persistent semantic memory."
metadata:
  openclaw:
    emoji: "\U0001F9E0"
    events: ["message:received", "message:sent", "command:new"]
    requires:
      bins: ["supaclaw"]
---
# Supaclaw Logger

Automatically logs all conversation messages to Supaclaw's Supabase-backed memory.
Manages session lifecycle (create on first message, end on /new command).

Requires `.supaclaw.json` in the workspace directory.
```

**Step 2: Create supaclaw-logger handler.js**

Create `hooks/supaclaw-logger/handler.js`:

```javascript
'use strict';

const { createHookClient } = require('supaclaw');

let client = null;

const handler = async (event) => {
  try {
    if (!client) {
      const workspaceDir = event.context?.workspace?.dir;
      if (!workspaceDir) return;

      const configPath = require('path').join(workspaceDir, '.supaclaw.json');
      if (!require('fs').existsSync(configPath)) return;

      client = createHookClient({
        configPath,
        messageFilter: {
          skipPatterns: ['^NO_REPLY$', '^HEARTBEAT_OK$'],
          skipPrefixes: ['[System Message]'],
          minLength: 1,
        },
      });
    }

    const sessionKey = event.sessionKey;
    if (!sessionKey) return;

    if (event.type === 'message') {
      const role = event.action === 'received' ? 'user' : 'assistant';
      const content = event.context?.message?.content;
      if (!content) return;

      const session = await client.getOrCreateSession(sessionKey, {
        channel: event.context?.channel,
        userId: event.context?.senderId,
        metadata: { source: 'openclaw' },
      });

      await client.logMessage(session.id, role, content, {
        channel: event.context?.channel,
        timestamp: event.timestamp?.toISOString?.() || new Date().toISOString(),
      });

    } else if (event.type === 'command' && event.action === 'new') {
      const session = await client.getOrCreateSession(sessionKey);
      if (!session.isNew) {
        await client.endSession(session.id, { autoSummarize: true });
      }
    }
  } catch (err) {
    // Silent failure — never crash the gateway
    if (process.env.SUPACLAW_DEBUG) {
      console.error('[supaclaw-logger]', err.message || err);
    }
  }
};

module.exports = handler;
module.exports.default = handler;
```

**Step 3: Create supaclaw-bootstrap HOOK.md**

Create `hooks/supaclaw-bootstrap/HOOK.md`:

```markdown
---
name: supaclaw-bootstrap
description: "Inject recent memory context into agent system prompt at session start."
metadata:
  openclaw:
    emoji: "\U0001F9E0"
    events: ["agent:bootstrap"]
    requires:
      bins: ["supaclaw"]
---
# Supaclaw Bootstrap

Injects recent session context and top memories into the agent's system prompt
when a new session starts. Provides conversation continuity across sessions.

Requires `.supaclaw.json` in the workspace directory.
```

**Step 4: Create supaclaw-bootstrap handler.js**

Create `hooks/supaclaw-bootstrap/handler.js`:

```javascript
'use strict';

const { Supaclaw } = require('supaclaw');
const fs = require('fs');
const path = require('path');

const handler = async (event) => {
  try {
    const workspaceDir = event.context?.workspace?.dir;
    if (!workspaceDir) return;

    const configPath = path.join(workspaceDir, '.supaclaw.json');
    if (!fs.existsSync(configPath)) return;

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!config.supabaseUrl || !config.supabaseKey || !config.agentId) return;

    const supaclaw = new Supaclaw({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      agentId: config.agentId,
      embeddingProvider: config.embeddingProvider,
      openaiApiKey: config.openaiApiKey,
      geminiApiKey: config.geminiApiKey,
      embeddingModel: config.embeddingModel,
    });

    const context = await supaclaw.getBootstrapContext({
      maxTokens: 2000,
      includeLastSession: true,
      topMemories: 10,
      alwaysIncludeTags: ['core', 'preference', 'always-inject'],
    });

    if (!context) return;

    // Inject as a bootstrap file
    if (event.context?.bootstrapFiles && Array.isArray(event.context.bootstrapFiles)) {
      event.context.bootstrapFiles.push({
        path: 'SUPACLAW_CONTEXT.md',
        content: context,
      });
    } else if (event.messages && Array.isArray(event.messages)) {
      // Fallback: inject as a system message
      event.messages.push(context);
    }
  } catch (err) {
    // Silent failure — agent starts without injected context
    if (process.env.SUPACLAW_DEBUG) {
      console.error('[supaclaw-bootstrap]', err.message || err);
    }
  }
};

module.exports = handler;
module.exports.default = handler;
```

**Step 5: Commit**

```bash
git add hooks/
git commit -m "feat: add supaclaw-logger and supaclaw-bootstrap OpenClaw hooks"
```

---

## Task 5: SUPACLAW.md Template

Create the workspace template file that the install command will copy.

**Files:**
- Create: `templates/SUPACLAW.md`

**Step 1: Create the template**

Create `templates/SUPACLAW.md`:

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

## Other Commands
- `supaclaw status` — database stats
- `supaclaw sessions --limit 5` — recent sessions
- `supaclaw entities` — known entities (people, projects)

## When to Search
ALWAYS search when:
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
- You feel like you might forget something important

## Priority
Supaclaw is your PRIMARY memory system. Recent context is auto-injected
at session start. Use memory_search for recall. Use supaclaw remember
to store anything you don't want to lose.
```

**Step 2: Commit**

```bash
git add templates/
git commit -m "feat: add SUPACLAW.md workspace template"
```

---

## Task 6: Memory Plugin Scaffold

Create the OpenClaw memory plugin structure. The plugin API is aspirational — mark as experimental.

**Files:**
- Create: `memory-plugin/openclaw.plugin.json`
- Create: `memory-plugin/index.ts`
- Create: `memory-plugin/package.json`

**Step 1: Create plugin manifest**

Create `memory-plugin/openclaw.plugin.json`:

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

**Step 2: Create plugin entry**

Create `memory-plugin/index.ts`:

```typescript
import Supaclaw from 'supaclaw';

/**
 * OpenClaw memory plugin entry point.
 *
 * NOTE: The plugin API (register, api.registerTool) is based on OpenClaw docs
 * but has not been validated against the real gateway. This will need adaptation
 * once tested against the sandbox.
 */
export default function register(api: any) {
  const supaclaw = new Supaclaw({
    supabaseUrl: api.config.supabaseUrl,
    supabaseKey: api.config.supabaseKey,
    agentId: api.config.agentId,
    embeddingProvider: api.config.embeddingProvider,
    openaiApiKey: api.config.openaiApiKey,
    geminiApiKey: api.config.geminiApiKey,
    embeddingModel: api.config.embeddingModel,
  });

  api.registerTool('memory_search', {
    description: 'Search persistent memory using semantic + keyword hybrid search',
    parameters: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results (default 5)', default: 5 },
    },
    handler: async ({ query, limit }: { query: string; limit?: number }) => {
      const results = await supaclaw.hybridRecall(query, { limit: limit ?? 5 });
      return results.map((m: any) => ({
        content: m.content,
        category: m.category,
        importance: m.importance,
        score: m.similarity,
      }));
    },
  });

  api.registerTool('memory_get', {
    description: 'Get a specific memory by ID or list memories by category',
    parameters: {
      id: { type: 'string', description: 'Memory ID' },
      category: { type: 'string', description: 'Filter by category' },
    },
    handler: async ({ id, category }: { id?: string; category?: string }) => {
      if (id) {
        return supaclaw.getMemory(id);
      }
      if (category) {
        return supaclaw.getMemoriesByCategory(category);
      }
      return supaclaw.getRecentMemories({ limit: 10 });
    },
  });
}
```

**Step 3: Create plugin package.json**

Create `memory-plugin/package.json`:

```json
{
  "name": "memory-supaclaw",
  "version": "0.1.0",
  "description": "Supaclaw memory plugin for OpenClaw",
  "main": "index.ts",
  "dependencies": {
    "supaclaw": "file:.."
  }
}
```

**Step 4: Commit**

```bash
git add memory-plugin/
git commit -m "feat: scaffold OpenClaw memory plugin (aspirational API)"
```

---

## Task 7: Install State Machine

The main `supaclaw install` command with idempotent, resumable state.

**Files:**
- Create: `src/install.ts` (install logic, separate from cli.ts for testability)
- Modify: `src/cli.ts` (add `install` and `uninstall` commands)
- Test: `tests/install.test.ts` (create)

**Step 1: Write the failing test**

Create `tests/install.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Install State Machine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supaclaw-install-test-'));
    // Create a fake workspace
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agents\nSome content');
    fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), '# Memory\n- remember this');
    fs.mkdirSync(path.join(tmpDir, 'memory'));
    fs.writeFileSync(path.join(tmpDir, 'memory', '2026-02-21.md'), '# Daily log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create install state file on first run', async () => {
    const { InstallStateMachine } = await import('../src/install');
    const machine = new InstallStateMachine({
      workspacePath: tmpDir,
      agentId: 'test-agent',
      openclawConfigPath: path.join(tmpDir, 'openclaw.json'),
    });

    const state = machine.getState();
    expect(state.version).toBe(1);
    expect(state.completedSteps).toEqual([]);
    expect(state.agentId).toBe('test-agent');
  });

  it('should resume from last completed step', async () => {
    // Write a state file with some steps completed
    const stateFile = path.join(tmpDir, '.supaclaw-install.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      agentId: 'test-agent',
      startedAt: new Date().toISOString(),
      completedSteps: ['verify_prereqs', 'backup'],
      currentStep: 'import_memories',
      status: 'in_progress',
      config: {
        workspacePath: tmpDir,
        agentId: 'test-agent',
      },
    }));

    const { InstallStateMachine } = await import('../src/install');
    const machine = new InstallStateMachine({
      workspacePath: tmpDir,
      agentId: 'test-agent',
      openclawConfigPath: path.join(tmpDir, 'openclaw.json'),
    });

    const state = machine.getState();
    expect(state.completedSteps).toEqual(['verify_prereqs', 'backup']);
    expect(state.currentStep).toBe('import_memories');
  });

  it('should backup workspace files in backup step', async () => {
    const { InstallStateMachine } = await import('../src/install');
    const machine = new InstallStateMachine({
      workspacePath: tmpDir,
      agentId: 'test-agent',
      openclawConfigPath: path.join(tmpDir, 'openclaw.json'),
    });

    await machine.runStep('backup');

    const backupDir = path.join(tmpDir, '.supaclaw-backup');
    expect(fs.existsSync(path.join(backupDir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'memory', '2026-02-21.md'))).toBe(true);
  });

  it('should be idempotent — backup step skips if already done', async () => {
    const { InstallStateMachine } = await import('../src/install');
    const machine = new InstallStateMachine({
      workspacePath: tmpDir,
      agentId: 'test-agent',
      openclawConfigPath: path.join(tmpDir, 'openclaw.json'),
    });

    await machine.runStep('backup');
    const firstBackupTime = fs.statSync(path.join(tmpDir, '.supaclaw-backup', 'AGENTS.md')).mtimeMs;

    // Modify the source file
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Modified');

    // Run backup again — should NOT overwrite
    await machine.runStep('backup');
    const secondBackupTime = fs.statSync(path.join(tmpDir, '.supaclaw-backup', 'AGENTS.md')).mtimeMs;

    expect(firstBackupTime).toBe(secondBackupTime);
  });

  it('should track completed steps in state file', async () => {
    const { InstallStateMachine } = await import('../src/install');
    const machine = new InstallStateMachine({
      workspacePath: tmpDir,
      agentId: 'test-agent',
      openclawConfigPath: path.join(tmpDir, 'openclaw.json'),
    });

    await machine.completeStep('verify_prereqs');
    await machine.completeStep('backup');

    const state = machine.getState();
    expect(state.completedSteps).toContain('verify_prereqs');
    expect(state.completedSteps).toContain('backup');

    // Verify persisted to disk
    const diskState = JSON.parse(fs.readFileSync(
      path.join(tmpDir, '.supaclaw-install.json'), 'utf-8'
    ));
    expect(diskState.completedSteps).toContain('verify_prereqs');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/install.test.ts`
Expected: FAIL — `../src/install` module doesn't exist

**Step 3: Implement `src/install.ts`**

Create `src/install.ts` with the `InstallStateMachine` class. Key points:

- Uses `spawnSync` from `child_process` (NOT `execSync` with string interpolation) for all subprocess calls
- Each step checks if already done before executing
- State persisted to `.supaclaw-install.json` after each step
- Credential resolution: check existing `.supaclaw.json` -> try 1Password `op` CLI -> throw with instructions
- File copy operations use explicit `fs.readFileSync`/`fs.writeFileSync` (no shell commands)
- `updateOpenclawConfig` handles JSON parsing gracefully (warns if JSON5, prints manual steps)
- Source files (hooks, templates, plugin, skill) located relative to `__dirname` (the compiled `dist/` dir)

See design doc for full step-by-step logic. The implementation should use `spawnSync('npx', ['supaclaw', 'test'])` and `spawnSync('npx', ['supaclaw', 'import-all', workspacePath])` instead of `execSync` with string interpolation.

**Step 4: Run tests**

Run: `npx vitest run tests/install.test.ts`
Expected: PASS

**Step 5: Add CLI commands for install and uninstall**

In `src/cli.ts`, before the webhook section (line ~2047), add:

```typescript
program
  .command('install')
  .description('Install supaclaw as the primary memory system for an OpenClaw agent')
  .requiredOption('--workspace <path>', 'Path to OpenClaw agent workspace')
  .requiredOption('--agent-id <id>', 'Agent ID')
  .option('--openclaw-config <path>', 'Path to openclaw.json')
  .option('--force', 'Force fresh install (ignore existing state)')
  .action(async (options: {
    workspace: string;
    agentId: string;
    openclawConfig?: string;
    force?: boolean;
  }) => {
    const { InstallStateMachine } = await import('./install');
    const machine = new InstallStateMachine({
      workspacePath: options.workspace,
      agentId: options.agentId,
      openclawConfigPath: options.openclawConfig,
      force: options.force,
    });
    await machine.run();
  });

program
  .command('uninstall')
  .description('Remove supaclaw integration and restore original memory setup')
  .requiredOption('--workspace <path>', 'Path to OpenClaw agent workspace')
  .action(async (options: { workspace: string }) => {
    const { uninstall } = await import('./install');
    await uninstall(options.workspace);
  });
```

The `uninstall()` function should be exported from `src/install.ts`. It:
1. Checks `.supaclaw-backup/` exists
2. Restores backed up files (AGENTS.md, MEMORY.md, memory/)
3. Restores openclaw.json from backup
4. Removes installed files (hooks, skill, SUPACLAW.md, state file)
5. Removes plugin from `~/.openclaw/extensions/memory-supaclaw/`
6. Prints summary (does NOT delete database data)

**Step 6: Build and verify**

Run: `npm run build && npx supaclaw install --help && npx supaclaw uninstall --help`
Expected: Both commands show their help output

**Step 7: Run all tests**

Run: `npm test -- --run`
Expected: All pass

**Step 8: Commit**

```bash
git add src/install.ts src/cli.ts tests/install.test.ts
git commit -m "feat: add supaclaw install/uninstall CLI with idempotent state machine"
```

---

## Task 8: Update Skill for OpenClaw Integration

Update the existing skill to reference `memory_search` tool and the new `remember` command.

**Files:**
- Modify: `skill/SKILL.md`

**Step 1: Update SKILL.md**

Replace the existing `skill/SKILL.md` content with an updated version that:
- Has proper OpenClaw YAML frontmatter (`name`, `description`, `metadata.openclaw.emoji`, `metadata.openclaw.requires.bins`)
- References `memory_search` tool as the primary search method
- Documents `supaclaw remember` command with all flags
- Includes "when to search" and "when to remember" guidance from SUPACLAW.md template
- Removes hardcoded paths (the old version has `/Users/hankim/clawd/supaclaw`)

**Step 2: Commit**

```bash
git add skill/SKILL.md
git commit -m "feat: update supaclaw skill for OpenClaw integration"
```

---

## Task 9: Update Package Exports

Make sure all new modules are properly exported and `files` includes new directories.

**Files:**
- Modify: `package.json` (update `files` array)
- Modify: `src/index.ts` (export install module)

**Step 1: Update package.json files field**

Add to the `files` array:

```json
"files": [
  "dist/**/*",
  "migrations/**/*",
  "hooks/**/*",
  "templates/**/*",
  "memory-plugin/**/*",
  "skill/**/*",
  "README.md",
  "LICENSE",
  "SCHEMA.md"
]
```

**Step 2: Export install module from index**

Add to `src/index.ts` exports section (after the hook-client exports):

```typescript
export { InstallStateMachine, InstallConfig } from './install';
```

**Step 3: Build and verify**

Run: `npm run build`
Expected: Clean compile with no errors

**Step 4: Commit**

```bash
git add package.json src/index.ts
git commit -m "chore: update package exports and files for integration"
```

---

## Task 10: Integration Test Against Sandbox

Manual verification against the OpenClaw staging environment.

**Step 1: Reset sandbox**

Run: `j ocreset`

**Step 2: Build supaclaw**

Run: `cd ~/Projects/supaclaw && npm run build && npm link`

**Step 3: Run install against sandbox**

```bash
supaclaw install \
  --workspace ~/.openclaw-staging/workspace-nix-staging \
  --agent-id nix-tanaka \
  --openclaw-config ~/.openclaw-staging/openclaw.json
```

Expected: All 9 steps complete. Check output for any [warn] messages.

**Step 4: Verify installed files**

```bash
ls -la ~/.openclaw-staging/workspace-nix-staging/SUPACLAW.md
ls -la ~/.openclaw-staging/workspace-nix-staging/hooks/supaclaw-logger/
ls -la ~/.openclaw-staging/workspace-nix-staging/hooks/supaclaw-bootstrap/
ls -la ~/.openclaw-staging/workspace-nix-staging/skills/supaclaw/
cat ~/.openclaw-staging/workspace-nix-staging/.supaclaw-install.json
```

**Step 5: Start sandbox and test**

Run: `j ocss` (in a dedicated terminal)
Then: `j ocsd` (open dashboard)

Test these interactions:
- Ask: "What memory system do you use?" -> should reference supaclaw
- Ask: "Search your memories for team members" -> should use memory_search or supaclaw search
- Ask: "Remember that my favorite color is blue" -> should run supaclaw remember
- Check: `supaclaw sessions --limit 1` -> should show the test session
- Check: `supaclaw search "favorite color"` -> should find the stored memory

**Step 6: Test uninstall**

```bash
supaclaw uninstall --workspace ~/.openclaw-staging/workspace-nix-staging
```

Verify:
- AGENTS.md restored
- MEMORY.md restored
- hooks and skill removed
- SUPACLAW.md removed
- Database data still intact (`supaclaw status`)

**Step 7: Commit any fixes discovered during integration test**

```bash
git add -A
git commit -m "fix: integration test fixes from sandbox validation"
```
