-- Migration 003: Entity Relationships
-- Tracks connections between entities (e.g., "Han works_at MetalBear")

-- Create entity_relationships table
CREATE TABLE IF NOT EXISTS entity_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  source_entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,     -- 'works_at', 'knows', 'created', 'located_in', etc.
  properties JSONB DEFAULT '{}',       -- Additional context (since, strength, etc.)
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  mention_count INT DEFAULT 1,
  confidence FLOAT DEFAULT 0.5,        -- 0-1 confidence in this relationship
  source_session_id UUID REFERENCES sessions(id),
  metadata JSONB DEFAULT '{}'
);

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS entity_relationships_source_idx 
  ON entity_relationships(source_entity_id);
  
CREATE INDEX IF NOT EXISTS entity_relationships_target_idx 
  ON entity_relationships(target_entity_id);
  
CREATE INDEX IF NOT EXISTS entity_relationships_type_idx 
  ON entity_relationships(relationship_type);

-- Prevent duplicate relationships
CREATE UNIQUE INDEX IF NOT EXISTS entity_relationships_unique_idx 
  ON entity_relationships(agent_id, source_entity_id, target_entity_id, relationship_type);

-- Function to increment relationship mention count
CREATE OR REPLACE FUNCTION increment_relationship_mentions(rel_id UUID)
RETURNS entity_relationships AS $$
DECLARE
  result entity_relationships;
BEGIN
  UPDATE entity_relationships
  SET mention_count = mention_count + 1,
      last_seen_at = NOW()
  WHERE id = rel_id
  RETURNING * INTO result;
  
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Function to find related entities (graph traversal)
CREATE OR REPLACE FUNCTION find_related_entities(
  entity_id UUID,
  max_depth INT DEFAULT 2,
  min_confidence FLOAT DEFAULT 0.5
)
RETURNS TABLE (
  entity_id UUID,
  entity_name TEXT,
  entity_type TEXT,
  relationship_path TEXT[],
  total_confidence FLOAT,
  depth INT
) AS $$
WITH RECURSIVE entity_graph AS (
  -- Base case: direct relationships
  SELECT 
    e.id as entity_id,
    e.name as entity_name,
    e.entity_type,
    ARRAY[r.relationship_type] as relationship_path,
    r.confidence as total_confidence,
    1 as depth
  FROM entity_relationships r
  JOIN entities e ON e.id = r.target_entity_id
  WHERE r.source_entity_id = entity_id
    AND r.confidence >= min_confidence
  
  UNION
  
  -- Recursive case: indirect relationships
  SELECT 
    e.id,
    e.name,
    e.entity_type,
    eg.relationship_path || r.relationship_type,
    eg.total_confidence * r.confidence,
    eg.depth + 1
  FROM entity_graph eg
  JOIN entity_relationships r ON r.source_entity_id = eg.entity_id
  JOIN entities e ON e.id = r.target_entity_id
  WHERE eg.depth < max_depth
    AND r.confidence >= min_confidence
    AND NOT e.id = ANY(SELECT unnest(eg.relationship_path::UUID[]))  -- Prevent cycles
)
SELECT * FROM entity_graph
ORDER BY total_confidence DESC, depth ASC;
$$ LANGUAGE sql;

-- Function to get entity network stats
CREATE OR REPLACE FUNCTION get_entity_network_stats(agent TEXT)
RETURNS TABLE (
  total_entities BIGINT,
  total_relationships BIGINT,
  avg_connections_per_entity FLOAT,
  most_connected_entity_id UUID,
  most_connected_entity_name TEXT,
  connection_count BIGINT
) AS $$
WITH entity_connections AS (
  SELECT 
    source_entity_id as entity_id,
    COUNT(*) as outgoing_count
  FROM entity_relationships
  WHERE agent_id = agent
  GROUP BY source_entity_id
),
most_connected AS (
  SELECT 
    ec.entity_id,
    e.name,
    ec.outgoing_count
  FROM entity_connections ec
  JOIN entities e ON e.id = ec.entity_id
  ORDER BY ec.outgoing_count DESC
  LIMIT 1
)
SELECT 
  (SELECT COUNT(*) FROM entities WHERE agent_id = agent)::BIGINT as total_entities,
  (SELECT COUNT(*) FROM entity_relationships WHERE agent_id = agent)::BIGINT as total_relationships,
  (SELECT AVG(outgoing_count) FROM entity_connections)::FLOAT as avg_connections_per_entity,
  mc.entity_id as most_connected_entity_id,
  mc.name as most_connected_entity_name,
  mc.outgoing_count::BIGINT as connection_count
FROM most_connected mc;
$$ LANGUAGE sql;

-- Comments for documentation
COMMENT ON TABLE entity_relationships IS 'Tracks relationships between entities (people, places, things)';
COMMENT ON COLUMN entity_relationships.relationship_type IS 'Type of relationship: works_at, knows, created, located_in, etc.';
COMMENT ON COLUMN entity_relationships.confidence IS 'Confidence score (0-1) in this relationship';
COMMENT ON FUNCTION increment_relationship_mentions IS 'Increments mention count and updates last_seen_at for a relationship';
COMMENT ON FUNCTION find_related_entities IS 'Graph traversal to find entities connected through relationships';
COMMENT ON FUNCTION get_entity_network_stats IS 'Statistics about the entity relationship network';
