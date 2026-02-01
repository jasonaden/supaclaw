# Phase 6: Memory Lifecycle Management ✅

**Status:** COMPLETE  
**Duration:** 10-minute session  
**Date:** February 1, 2026

## Overview

Phase 6 adds comprehensive lifecycle management features to OpenClaw Memory:
- **Importance Decay:** Automatically reduce importance of old memories
- **Consolidation:** Merge similar/duplicate memories
- **Versioning:** Track historical changes to memories
- **Tagging:** Organize memories with flexible tags
- **Auto-Cleanup:** Archive or delete old sessions
- **Monitoring:** Statistics and health checks

## Features Implemented

### 1. Importance Decay (`decayMemoryImportance`)

Automatically reduces importance scores over time to prevent old memories from dominating.

**Features:**
- Configurable decay rate (default 10%)
- Minimum importance threshold
- Age-based filtering (only decay memories older than X days)
- Tracks decay history in metadata

**Usage:**
```typescript
const result = await memory.decayMemoryImportance({
  decayRate: 0.1,        // 10% decay
  minImportance: 0.1,    // Don't go below 0.1
  olderThanDays: 7       // Only memories older than 7 days
});

console.log(`Updated ${result.updated} memories`);
console.log(`Average decay: ${result.avgDecay}`);
```

**CLI:**
```bash
openclaw-memory decay --days 7 --rate 0.1 --min 0.1
```

### 2. Memory Consolidation (`consolidateMemories`)

Merges similar or duplicate memories to reduce clutter.

**Features:**
- Vector similarity matching
- Configurable similarity threshold
- Category filtering
- Preserves metadata from both memories
- Tracks merge history

**Usage:**
```typescript
const result = await memory.consolidateMemories({
  similarityThreshold: 0.9,  // 90% similar
  category: 'preferences',   // Optional filter
  limit: 100                 // Max pairs to check
});

console.log(`Merged ${result.merged} memories`);
console.log(`Kept ${result.kept} unique memories`);
```

**CLI:**
```bash
openclaw-memory consolidate --threshold 0.9 --limit 100
```

### 3. Memory Versioning

Track historical changes to memories with automatic versioning.

**Features:**
- Create version snapshots
- Retrieve version history
- Restore previous versions
- Track version metadata

**Usage:**
```typescript
// Create version snapshot
const { versionId } = await memory.versionMemory('mem-123');

// Get version history
const versions = await memory.getMemoryVersions('mem-123');
versions.forEach(v => {
  console.log(`${v.version} - ${v.timestamp}`);
  console.log(`Content: ${v.content}`);
});
```

### 4. Memory Tagging

Organize memories with flexible, multi-valued tags.

**Features:**
- Add/remove tags
- Search by tags (match ANY or ALL)
- Tag-based filtering
- Tag deduplication

**Usage:**
```typescript
// Add tags
await memory.tagMemory('mem-123', ['important', 'work']);

// Remove tags
await memory.untagMemory('mem-123', ['work']);

// Search by tags (match ANY)
const results = await memory.searchMemoriesByTags(['work', 'urgent'], {
  matchAll: false,  // Match ANY tag
  limit: 50
});

// Search by tags (match ALL)
const precise = await memory.searchMemoriesByTags(['work', 'urgent'], {
  matchAll: true    // Must have BOTH tags
});
```

**CLI:**
```bash
# Add tags
openclaw-memory tag mem-123 important work

# Remove tags
openclaw-memory untag mem-123 work

# Search tags (match ANY)
openclaw-memory search-tags work urgent

# Search tags (match ALL)
openclaw-memory search-tags work urgent --all
```

### 5. Auto-Cleanup (`cleanupOldSessions`)

Automatically archive or delete old sessions to manage database size.

**Features:**
- Archive or delete modes
- Age-based filtering
- Keep sessions with summaries (optional)
- User-specific cleanup
- Batch processing

**Usage:**
```typescript
// Archive old sessions
const archived = await memory.cleanupOldSessions({
  olderThanDays: 90,
  action: 'archive',
  keepSummaries: true
});

// Delete very old sessions
const deleted = await memory.cleanupOldSessions({
  olderThanDays: 180,
  action: 'delete',
  keepSummaries: false
});
```

**CLI:**
```bash
# Archive sessions older than 90 days
openclaw-memory cleanup --days 90

# Delete sessions older than 180 days
openclaw-memory cleanup --days 180 --delete

# Get cleanup statistics
openclaw-memory cleanup-stats
```

### 6. Cleanup Statistics (`getCleanupStats`)

Monitor database health and identify cleanup opportunities.

**Features:**
- Total session count
- Archived session count
- Old session detection
- Message statistics
- Orphaned message detection

**Usage:**
```typescript
const stats = await memory.getCleanupStats();

console.log('Sessions:');
console.log(`  Total: ${stats.totalSessions}`);
console.log(`  Archived: ${stats.archivedSessions}`);
console.log(`  Old (>90 days): ${stats.oldSessions}`);

console.log('Messages:');
console.log(`  Total: ${stats.totalMessages}`);
console.log(`  Orphaned: ${stats.orphanedMessages}`);
```

**CLI:**
```bash
openclaw-memory cleanup-stats
```

## Testing

Comprehensive test suite in `tests/lifecycle.test.ts`:

```bash
npm test tests/lifecycle.test.ts
```

**Test Coverage:**
- ✅ Importance decay (multiple scenarios)
- ✅ Memory consolidation (similarity matching)
- ✅ Memory versioning (snapshots & history)
- ✅ Tag management (add/remove/search)
- ✅ Session cleanup (archive/delete)
- ✅ Cleanup statistics
- ✅ Integration tests

## CLI Commands Added

| Command | Description |
|---------|-------------|
| `decay` | Apply importance decay to old memories |
| `consolidate` | Merge similar memories |
| `tag` | Add tags to a memory |
| `untag` | Remove tags from a memory |
| `search-tags` | Search memories by tags |
| `cleanup` | Archive/delete old sessions |
| `cleanup-stats` | Show cleanup statistics |

## Use Cases

### 1. Automated Maintenance (Cron Job)
```bash
#!/bin/bash
# Run weekly maintenance

# Decay old memories
openclaw-memory decay --days 7

# Consolidate duplicates
openclaw-memory consolidate --threshold 0.95

# Archive old sessions
openclaw-memory cleanup --days 90

# Report stats
openclaw-memory cleanup-stats
```

### 2. Smart Memory Management
```typescript
// Progressive importance decay
async function maintainMemories() {
  // Recent memories: minimal decay
  await memory.decayMemoryImportance({
    olderThanDays: 7,
    decayRate: 0.05
  });

  // Medium-age memories: moderate decay
  await memory.decayMemoryImportance({
    olderThanDays: 30,
    decayRate: 0.15
  });

  // Old memories: aggressive decay
  await memory.decayMemoryImportance({
    olderThanDays: 90,
    decayRate: 0.30
  });
}
```

### 3. Tag-Based Organization
```typescript
// Organize project memories
await memory.tagMemory(memId, ['project-alpha', 'high-priority']);

// Find all project-related memories
const projectMems = await memory.searchMemoriesByTags(['project-alpha']);

// Find urgent project items
const urgent = await memory.searchMemoriesByTags(
  ['project-alpha', 'high-priority'], 
  { matchAll: true }
);
```

## Performance Considerations

### Decay
- Processes memories in batches
- Filters by age before loading
- Updates in bulk when possible
- **Expected:** ~100-500ms for 1000 memories

### Consolidation
- Uses vector similarity (requires embeddings)
- Limited scope via `limit` parameter
- Quadratic complexity: O(n²)
- **Recommendation:** Process in batches of 100-200

### Cleanup
- Efficient date-based filtering
- Cascading deletes for messages
- Archive-first strategy (safer)
- **Expected:** ~50-200ms per 100 sessions

## Future Enhancements

Potential additions for Phase 9+:
- [ ] Scheduled auto-maintenance (cron integration)
- [ ] Memory compression (old memories → summaries)
- [ ] Decay curve customization (exponential, linear, stepped)
- [ ] Smart consolidation (LLM-assisted merging)
- [ ] Tag suggestions (auto-tagging based on content)
- [ ] Cleanup policies (retention rules)
- [ ] Version diffing (show changes between versions)
- [ ] Audit trail (track all lifecycle events)

## Migration Notes

No database schema changes required. All features use existing tables and metadata fields.

**Metadata fields added:**
- `metadata.tags` (string[])
- `metadata.versions` (array of version snapshots)
- `metadata.current_version` (string)
- `metadata.last_decay` (ISO timestamp)
- `metadata.decay_count` (number)
- `metadata.merged_from` (string[])
- `metadata.merge_count` (number)
- `metadata.last_merged` (ISO timestamp)
- `metadata.archived` (boolean)
- `metadata.archived_at` (ISO timestamp)

## Documentation

Updated files:
- ✅ `README.md` (API reference)
- ✅ `TODO.md` (mark Phase 6 complete)
- ✅ `PHASE6_COMPLETE.md` (this file)
- ✅ Test suite with examples

## Next Steps

**Phase 7:** Migration Tools
- Parse MEMORY.md → memories
- Parse daily logs → sessions
- Parse TODO.md → tasks
- Markdown export utilities

**Phase 8:** Clawdbot Integration
- Create openclaw-memory skill
- Hook into session lifecycle
- Replace memory_search/memory_get
- Auto-log messages

---

**Phase 6 Status:** ✅ COMPLETE  
**Commits:** Lifecycle management, CLI commands, tests, docs  
**Time:** ~10 minutes  
**Lines Added:** ~800 (implementation + tests + docs)
