-- Fix: revert to 1536 dims for OpenAI text-embedding-3-small
-- Drop old 768-dim functions from the gemini migration attempt
DROP FUNCTION IF EXISTS match_memories(VECTOR(768), FLOAT, INT, TEXT);
DROP FUNCTION IF EXISTS hybrid_search_memories(TEXT, VECTOR(768), FLOAT, FLOAT, INT, TEXT);

-- Drop indexes
DROP INDEX IF EXISTS memories_embedding_idx;
DROP INDEX IF EXISTS entities_embedding_idx;

-- Revert columns to 1536
ALTER TABLE memories ALTER COLUMN embedding TYPE VECTOR(1536);
ALTER TABLE entities ALTER COLUMN embedding TYPE VECTOR(1536);

-- Recreate ivfflat indexes (1536 is within limit)
CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS entities_embedding_idx ON entities
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Recreate match_memories with 1536 dims
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  p_agent_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  agent_id TEXT,
  user_id TEXT,
  category TEXT,
  content TEXT,
  importance FLOAT,
  tags TEXT[],
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.agent_id, m.user_id, m.category, m.content,
    m.importance::FLOAT, m.tags, m.embedding, m.created_at, m.updated_at,
    (1 - (m.embedding <=> query_embedding))::FLOAT AS similarity
  FROM memories m
  WHERE
    (p_agent_id IS NULL OR m.agent_id = p_agent_id)
    AND m.embedding IS NOT NULL
    AND (1 - (m.embedding <=> query_embedding)) > match_threshold
    AND m.archived_at IS NULL
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Recreate hybrid_search_memories with 1536 dims
CREATE OR REPLACE FUNCTION hybrid_search_memories(
  query_text TEXT,
  query_embedding VECTOR(1536),
  vector_weight FLOAT DEFAULT 0.7,
  keyword_weight FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 10,
  p_agent_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  agent_id TEXT,
  user_id TEXT,
  category TEXT,
  content TEXT,
  importance FLOAT,
  tags TEXT[],
  embedding VECTOR(1536),
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  combined_score FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH vector_scores AS (
    SELECT m.id,
      1 - (m.embedding <=> query_embedding) AS vector_similarity
    FROM memories m
    WHERE (p_agent_id IS NULL OR m.agent_id = p_agent_id)
      AND m.embedding IS NOT NULL
      AND m.archived_at IS NULL
  ),
  keyword_scores AS (
    SELECT m.id,
      ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', query_text)) AS keyword_relevance
    FROM memories m
    WHERE (p_agent_id IS NULL OR m.agent_id = p_agent_id)
      AND m.archived_at IS NULL
      AND to_tsvector('english', m.content) @@ plainto_tsquery('english', query_text)
  )
  SELECT m.id, m.agent_id, m.user_id, m.category, m.content,
    m.importance::FLOAT, m.tags, m.embedding, m.created_at, m.updated_at,
    (COALESCE(v.vector_similarity, 0) * vector_weight +
     COALESCE(k.keyword_relevance, 0) * keyword_weight)::FLOAT AS combined_score
  FROM memories m
  LEFT JOIN vector_scores v ON v.id = m.id
  LEFT JOIN keyword_scores k ON k.id = m.id
  WHERE (p_agent_id IS NULL OR m.agent_id = p_agent_id)
    AND m.archived_at IS NULL
    AND (v.vector_similarity IS NOT NULL OR k.keyword_relevance IS NOT NULL)
  ORDER BY combined_score DESC
  LIMIT match_count;
END;
$$;
