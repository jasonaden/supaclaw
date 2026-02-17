-- Supaclaw - Vector Search Functions
-- Run this in your Supabase SQL editor after 001_initial.sql

-- Function: Vector similarity search for memories
-- Returns memories ranked by cosine similarity to the query embedding
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding VECTOR(1536),
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10,
  p_agent_id TEXT DEFAULT NULL,
  p_user_id TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_min_importance FLOAT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  agent_id TEXT,
  user_id TEXT,
  category TEXT,
  content TEXT,
  importance FLOAT,
  source_session_id UUID,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  embedding VECTOR(1536),
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.agent_id,
    m.user_id,
    m.category,
    m.content,
    m.importance,
    m.source_session_id,
    m.created_at,
    m.updated_at,
    m.expires_at,
    m.embedding,
    m.metadata,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE 
    (p_agent_id IS NULL OR m.agent_id = p_agent_id)
    AND (p_user_id IS NULL OR m.user_id = p_user_id OR m.user_id IS NULL)
    AND (p_category IS NULL OR m.category = p_category)
    AND (p_min_importance IS NULL OR m.importance >= p_min_importance)
    AND (m.expires_at IS NULL OR m.expires_at > NOW())
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Function: Hybrid search combining vector similarity and keyword matching
-- Returns memories ranked by weighted combination of semantic similarity and keyword relevance
CREATE OR REPLACE FUNCTION hybrid_search_memories(
  query_embedding VECTOR(1536),
  query_text TEXT,
  vector_weight FLOAT DEFAULT 0.7,
  keyword_weight FLOAT DEFAULT 0.3,
  match_count INT DEFAULT 10,
  p_agent_id TEXT DEFAULT NULL,
  p_user_id TEXT DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_min_importance FLOAT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  agent_id TEXT,
  user_id TEXT,
  category TEXT,
  content TEXT,
  importance FLOAT,
  source_session_id UUID,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  embedding VECTOR(1536),
  metadata JSONB,
  score FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH vector_scores AS (
    SELECT
      m.id,
      1 - (m.embedding <=> query_embedding) AS vector_similarity
    FROM memories m
    WHERE 
      (p_agent_id IS NULL OR m.agent_id = p_agent_id)
      AND (p_user_id IS NULL OR m.user_id = p_user_id OR m.user_id IS NULL)
      AND (p_category IS NULL OR m.category = p_category)
      AND (p_min_importance IS NULL OR m.importance >= p_min_importance)
      AND (m.expires_at IS NULL OR m.expires_at > NOW())
      AND m.embedding IS NOT NULL
  ),
  keyword_scores AS (
    SELECT
      m.id,
      ts_rank(to_tsvector('english', m.content), plainto_tsquery('english', query_text)) AS keyword_relevance
    FROM memories m
    WHERE 
      (p_agent_id IS NULL OR m.agent_id = p_agent_id)
      AND (p_user_id IS NULL OR m.user_id = p_user_id OR m.user_id IS NULL)
      AND (p_category IS NULL OR m.category = p_category)
      AND (p_min_importance IS NULL OR m.importance >= p_min_importance)
      AND (m.expires_at IS NULL OR m.expires_at > NOW())
      AND to_tsvector('english', m.content) @@ plainto_tsquery('english', query_text)
  ),
  combined_scores AS (
    SELECT
      COALESCE(v.id, k.id) AS memory_id,
      (COALESCE(v.vector_similarity, 0) * vector_weight + 
       COALESCE(k.keyword_relevance, 0) * keyword_weight) AS combined_score
    FROM vector_scores v
    FULL OUTER JOIN keyword_scores k ON v.id = k.id
  )
  SELECT
    m.id,
    m.agent_id,
    m.user_id,
    m.category,
    m.content,
    m.importance,
    m.source_session_id,
    m.created_at,
    m.updated_at,
    m.expires_at,
    m.embedding,
    m.metadata,
    cs.combined_score AS score
  FROM memories m
  JOIN combined_scores cs ON m.id = cs.memory_id
  ORDER BY cs.combined_score DESC
  LIMIT match_count;
END;
$$;

-- Function: Find similar memories based on an existing memory
-- Useful for finding related context or detecting duplicates
CREATE OR REPLACE FUNCTION find_similar_memories(
  memory_id UUID,
  match_threshold FLOAT DEFAULT 0.8,
  match_count INT DEFAULT 5
)
RETURNS TABLE (
  id UUID,
  agent_id TEXT,
  user_id TEXT,
  category TEXT,
  content TEXT,
  importance FLOAT,
  source_session_id UUID,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  embedding VECTOR(1536),
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
DECLARE
  source_embedding VECTOR(1536);
  source_agent_id TEXT;
BEGIN
  -- Get the embedding of the source memory
  SELECT m.embedding, m.agent_id INTO source_embedding, source_agent_id
  FROM memories m
  WHERE m.id = memory_id;

  IF source_embedding IS NULL THEN
    RAISE EXCEPTION 'Memory not found or has no embedding';
  END IF;

  RETURN QUERY
  SELECT
    m.id,
    m.agent_id,
    m.user_id,
    m.category,
    m.content,
    m.importance,
    m.source_session_id,
    m.created_at,
    m.updated_at,
    m.expires_at,
    m.embedding,
    m.metadata,
    1 - (m.embedding <=> source_embedding) AS similarity
  FROM memories m
  WHERE 
    m.id != memory_id
    AND m.agent_id = source_agent_id
    AND m.embedding IS NOT NULL
    AND 1 - (m.embedding <=> source_embedding) > match_threshold
  ORDER BY m.embedding <=> source_embedding
  LIMIT match_count;
END;
$$;

-- Create full-text search index for keyword search optimization
CREATE INDEX IF NOT EXISTS memories_content_fts_idx ON memories 
  USING GIN (to_tsvector('english', content));

-- Comments for documentation
COMMENT ON FUNCTION match_memories IS 'Performs semantic search on memories using vector similarity (cosine distance)';
COMMENT ON FUNCTION hybrid_search_memories IS 'Combines vector similarity and keyword matching with configurable weights';
COMMENT ON FUNCTION find_similar_memories IS 'Finds memories similar to a given memory, useful for deduplication and context expansion';
