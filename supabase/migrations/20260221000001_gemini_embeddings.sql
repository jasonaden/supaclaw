-- Migration: Switch from VECTOR(1536) to VECTOR(768) for Gemini embeddings
-- Gemini embedding-001 outputs 768 dimensions vs OpenAI's 1536

-- Drop existing indexes that reference the old vector size
DROP INDEX IF EXISTS memories_embedding_idx;
DROP INDEX IF EXISTS entities_embedding_idx;

-- Alter columns (only tables that have embedding columns)
ALTER TABLE memories ALTER COLUMN embedding TYPE VECTOR(768);
ALTER TABLE entities ALTER COLUMN embedding TYPE VECTOR(768);

-- Recreate indexes
CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS entities_embedding_idx ON entities
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Update match_memories function
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding VECTOR(768),
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
  embedding VECTOR(768),
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

-- Update hybrid_search_memories function
CREATE OR REPLACE FUNCTION hybrid_search_memories(
  query_text TEXT,
  query_embedding VECTOR(768),
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
  embedding VECTOR(768),
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
