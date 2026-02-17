# Phase 7: Entity Relationship System ✅ COMPLETE

**Focus:** Entity relationships, graph traversal, and network analysis

## Completed Features (Steps 61-70)

### Core Implementation

1. **Entity Relationships Table** (Steps 61-62)
   - New `entity_relationships` table with foreign keys to entities
   - Tracks source entity, target entity, and relationship type
   - Confidence scoring (0-1) for relationship strength
   - Mention counting to track relationship frequency
   - Properties JSONB for additional context

2. **Relationship Types** (Step 63)
   - Common types: `works_at`, `knows`, `created`, `located_in`, `part_of`, `owns`, `manages`, `reports_to`, `collaborates_with`, `mentioned_in`
   - Custom types supported through flexible string field
   - Directional relationships (source → target)

3. **Graph Traversal** (Steps 64-66)
   - Recursive SQL function for multi-hop entity discovery
   - Configurable max depth (default: 2 hops)
   - Minimum confidence threshold filtering
   - Confidence decay calculation (product of path confidences)
   - Cycle prevention in graph traversal

4. **Entity Deduplication** (Steps 67-68)
   - Merge duplicate relationships on creation
   - Auto-increment mention count for repeated observations
   - Confidence boosting with each mention (max 1.0)
   - Properties merge (keeps both old and new properties)

5. **Network Statistics** (Step 69)
   - Total entities and relationships count
   - Average connections per entity
   - Most connected entity identification
   - SQL function for efficient stats calculation

6. **AI-Powered Extraction** (Step 70)
   - Extract entities AND relationships from text in one call
   - OpenAI GPT-4o-mini for extraction
   - Automatic relationship creation between extracted entities
   - Confidence scoring based on extraction quality

## New Database Objects

### Table: `entity_relationships`

```sql
CREATE TABLE entity_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  source_entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  properties JSONB DEFAULT '{}',
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  mention_count INT DEFAULT 1,
  confidence FLOAT DEFAULT 0.5,
  source_session_id UUID REFERENCES sessions(id),
  metadata JSONB DEFAULT '{}'
);
```

### Indexes

- `entity_relationships_source_idx` - Fast lookups by source entity
- `entity_relationships_target_idx` - Fast lookups by target entity  
- `entity_relationships_type_idx` - Filter by relationship type
- `entity_relationships_unique_idx` - Prevent duplicate relationships

### SQL Functions

1. **increment_relationship_mentions(rel_id)** - Bump mention count and update timestamp
2. **find_related_entities(entity_id, max_depth, min_confidence)** - Graph traversal
3. **get_entity_network_stats(agent)** - Network statistics

## API Additions to Supaclaw

### New Methods

```typescript
// Create or update a relationship
async createEntityRelationship(rel: {
  sourceEntityId: string;
  targetEntityId: string;
  relationshipType: string;
  properties?: Record<string, unknown>;
  confidence?: number;
  sessionId?: string;
}): Promise<EntityRelationship>

// Get relationships for an entity
async getEntityRelationships(entityId: string, opts?: {
  direction?: 'outgoing' | 'incoming' | 'both';
  relationshipType?: string;
  minConfidence?: number;
  limit?: number;
}): Promise<Array<{
  relationship: EntityRelationship;
  relatedEntity: Entity;
  direction: 'outgoing' | 'incoming';
}>>

// Find related entities through graph traversal (multi-hop)
async findRelatedEntities(entityId: string, opts?: {
  maxDepth?: number;
  minConfidence?: number;
}): Promise<Array<{
  entityId: string;
  entityName: string;
  entityType: string;
  relationshipPath: string[];
  totalConfidence: number;
  depth: number;
}>>

// Get network statistics
async getEntityNetworkStats(): Promise<{
  totalEntities: number;
  totalRelationships: number;
  avgConnectionsPerEntity: number;
  mostConnectedEntity?: {
    id: string;
    name: string;
    connectionCount: number;
  };
}>

// Extract entities AND relationships from text
async extractEntitiesWithRelationships(text: string, opts?: {
  sessionId?: string;
}): Promise<{
  entities: Entity[];
  relationships: EntityRelationship[];
}>

// Delete a relationship
async deleteEntityRelationship(relationshipId: string): Promise<void>

// Search relationships
async searchRelationships(opts?: {
  relationshipType?: string;
  minConfidence?: number;
  limit?: number;
}): Promise<EntityRelationship[]>
```

### New Types

```typescript
export interface EntityRelationship {
  id: string;
  agent_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  properties: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
  mention_count: number;
  confidence: number;
  source_session_id?: string;
  metadata: Record<string, unknown>;
}
```

## CLI Commands

### New Commands

```bash
# List entities
supaclaw entities [--type <type>] [--limit <number>]

# Show entity relationship graph
supaclaw entity-graph <entityId> \
  [--depth <number>] \
  [--min-confidence <number>]

# Network statistics
supaclaw entity-stats

# Extract entities and relationships from text
supaclaw extract-entities "<text>" \
  [--openai-key <key>]
```

### Examples

```bash
# List all person entities
supaclaw entities --type person

# Show Han's relationship graph (2 hops deep)
supaclaw entity-graph abc-123 --depth 2

# Extract from conversation
supaclaw extract-entities "Alice works at TechCorp in San Francisco"

# View network stats
supaclaw entity-stats
```

## Migration File

**`migrations/003_entity_relationships.sql`**

Creates:
- `entity_relationships` table
- 4 indexes for performance
- 3 SQL functions (increment mentions, graph traversal, network stats)
- Comments for documentation

Run migration:
```bash
npx supaclaw migrate
# Copy and run 003_entity_relationships.sql in Supabase SQL Editor
```

## Testing

**`tests/entity-relationships.test.ts`**

Comprehensive test coverage:
- ✅ Create relationships
- ✅ Update existing relationships (deduplication)
- ✅ Get outgoing/incoming relationships
- ✅ Filter by type and confidence
- ✅ Graph traversal (1-hop, 2-hop, n-hop)
- ✅ Respect depth limits
- ✅ Confidence thresholds
- ✅ Network statistics
- ✅ AI extraction (entities + relationships)
- ✅ Search relationships
- ✅ Lifecycle (mention counts, confidence boost)
- ✅ Integration scenarios
- ✅ Confidence scoring for multi-hop paths

Run tests:
```bash
npm test -- entity-relationships
```

## Use Cases

### 1. Knowledge Graph Construction

```typescript
const text = `
  Alice works at TechCorp as a Full Stack Engineer.
  TechCorp is located in San Francisco.
  Alice knows Sarah, who also works at TechCorp.
`;

const { entities, relationships } = await memory.extractEntitiesWithRelationships(text);

// Creates:
// - Entities: Han, TechCorp, San Francisco, Sarah
// - Relationships:
//   - Han → works_at → TechCorp
//   - TechCorp → located_in → San Francisco
//   - Han → knows → Sarah
//   - Sarah → works_at → TechCorp
```

### 2. Entity Discovery

```typescript
// Find entities related to Han within 2 hops
const related = await memory.findRelatedEntities(hanId, { maxDepth: 2 });

// Returns:
// 1. TechCorp (works_at) - 1 hop, confidence 0.9
// 2. San Francisco (works_at → located_in) - 2 hops, confidence 0.72
// 3. Sarah (knows) - 1 hop, confidence 0.8
```

### 3. Relationship Queries

```typescript
// Get all "works_at" relationships
const workRelationships = await memory.getEntityRelationships(hanId, {
  direction: 'outgoing',
  relationshipType: 'works_at'
});

// Get entities that know Han
const whoKnowsHan = await memory.getEntityRelationships(hanId, {
  direction: 'incoming',
  relationshipType: 'knows'
});
```

### 4. Network Analysis

```typescript
const stats = await memory.getEntityNetworkStats();

console.log(`
  Total entities: ${stats.totalEntities}
  Total relationships: ${stats.totalRelationships}
  Avg connections: ${stats.avgConnectionsPerEntity}
  Hub: ${stats.mostConnectedEntity?.name} (${stats.mostConnectedEntity?.connectionCount} connections)
`);
```

## Graph Features

### Confidence Scoring

Relationships have confidence scores (0-1):
- Initial confidence: 0.5 (default) or specified
- Increases with mentions: +0.1 per mention (max 1.0)
- Multi-hop confidence: product of path confidences
  - Direct: 0.9
  - 2-hop: 0.9 × 0.8 = 0.72
  - 3-hop: 0.9 × 0.8 × 0.7 = 0.504

### Cycle Prevention

Graph traversal prevents infinite loops:
```sql
WHERE NOT e.id = ANY(SELECT unnest(eg.relationship_path::UUID[]))
```

### Directional Relationships

All relationships are directed (source → target):
- `Han → works_at → TechCorp` ≠ `TechCorp → works_at → Han`
- Query both directions with `direction: 'both'`

## Performance

### Time Complexity

- Create relationship: O(1) with unique index lookup
- Get relationships: O(n) where n = relationship count
- Graph traversal: O(n^d) where d = depth (limited by max_depth)
- Network stats: O(n + r) where n = entities, r = relationships

### Space Complexity

- Each relationship: ~500 bytes (with indexes)
- 1000 relationships: ~500KB
- Graph traversal result: O(n) for n related entities

### Optimizations

- Unique index prevents duplicate relationship inserts
- Separate indexes on source/target for fast lookups
- Relationship type index for filtering
- Mention count increments avoid full updates

## Integration Examples

### With Session Processing

```typescript
// After each message, extract entities and relationships
async function processMessage(sessionId: string, content: string) {
  const { entities, relationships } = await memory.extractEntitiesWithRelationships(
    content,
    { sessionId }
  );
  
  console.log(`Extracted ${entities.length} entities, ${relationships.length} relationships`);
}
```

### With Context Building

```typescript
// Include entity context in prompts
const contextEntities = await memory.searchEntities({ query: userQuery });

const relatedInfo = [];
for (const entity of contextEntities) {
  const rels = await memory.getEntityRelationships(entity.id, { limit: 3 });
  rels.forEach(r => {
    relatedInfo.push(`${entity.name} ${r.relationship.relationship_type} ${r.relatedEntity.name}`);
  });
}

const context = `Relevant entities:\n${relatedInfo.join('\n')}`;
```

## Future Enhancements

Potential Phase 8+ features:

1. **Relationship Properties**
   - Date ranges (worked_at: since 2020)
   - Strength/importance scoring
   - Source attribution (from which sessions)

2. **Bidirectional Relationships**
   - Symmetric types (knows, married_to)
   - Inverse relationships (employs ↔ works_at)

3. **Relationship Inference**
   - Derive implicit relationships
   - "Friend of friend" patterns
   - Transitive properties

4. **Graph Visualization**
   - Export to DOT/GraphML
   - D3.js visualization
   - Relationship clustering

5. **Advanced Queries**
   - Shortest path between entities
   - Common connections
   - Community detection
   - Centrality metrics

## Files Modified/Created

### Created
- `migrations/003_entity_relationships.sql` (5KB)
- `tests/entity-relationships.test.ts` (14KB)
- `PHASE7_COMPLETE.md` (this file)

### Modified
- `src/index.ts` - Added EntityRelationship interface and 8 new methods
- `src/cli.ts` - Added 4 new commands (entities, entity-graph, entity-stats, extract-entities)

### Total
- ~700 lines of production code
- ~400 lines of test code
- ~200 lines of SQL
- ~300 lines of documentation

---

**Status**: ✅ All 10 steps (61-70) complete  
**Files**: 1 migration, 1 test file, 1 doc, 2 modified  
**Lines**: ~1,600 total (code + tests + SQL + docs)  
**Ready**: Production-ready, tested with comprehensive examples

## Next Steps

Phase 7 completes the entity relationship system. Suggested next phases:

1. **Phase 8: Clawdbot Integration** - Build skill to use Supaclaw
2. **Phase 9: Advanced Features** - Multi-agent sharing, real-time updates
3. **Phase 10: Production Polish** - Integration tests, performance optimization

The entity relationship graph is now fully functional and ready for use!
