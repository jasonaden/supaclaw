-- Supaclaw - Initial Schema
-- Run this in your Supabase SQL editor

-- Enable vector extension for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- Sessions: Every conversation gets a session
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  user_id TEXT,
  channel TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  summary TEXT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS sessions_agent_id_idx ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_started_at_idx ON sessions(started_at DESC);

-- Messages: Every message in every session
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  token_count INT,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages(session_id);
CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);

-- Memories: Long-term memories extracted from sessions
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  user_id TEXT,
  category TEXT,
  content TEXT NOT NULL,
  importance FLOAT DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  source_session_id UUID REFERENCES sessions(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  embedding VECTOR(1536),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS memories_agent_id_idx ON memories(agent_id);
CREATE INDEX IF NOT EXISTS memories_user_id_idx ON memories(user_id);
CREATE INDEX IF NOT EXISTS memories_category_idx ON memories(category);
CREATE INDEX IF NOT EXISTS memories_importance_idx ON memories(importance DESC);
CREATE INDEX IF NOT EXISTS memories_created_at_idx ON memories(created_at DESC);

-- Vector similarity index (for semantic search)
CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories 
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Entities: People, places, things the agent knows about
CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT[],
  description TEXT,
  properties JSONB DEFAULT '{}',
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  mention_count INT DEFAULT 1,
  embedding VECTOR(1536),
  
  UNIQUE(agent_id, entity_type, name)
);

CREATE INDEX IF NOT EXISTS entities_agent_id_idx ON entities(agent_id);
CREATE INDEX IF NOT EXISTS entities_type_idx ON entities(entity_type);
CREATE INDEX IF NOT EXISTS entities_name_idx ON entities(name);

-- Tasks: Persistent task tracking
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  user_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'blocked', 'done')),
  priority INT DEFAULT 0,
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  source_session_id UUID REFERENCES sessions(id),
  parent_task_id UUID REFERENCES tasks(id),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tasks_agent_id_idx ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS tasks_user_id_idx ON tasks(user_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_priority_idx ON tasks(priority DESC);
CREATE INDEX IF NOT EXISTS tasks_due_at_idx ON tasks(due_at);

-- Learnings: Self-improvement records
CREATE TABLE IF NOT EXISTS learnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('error', 'correction', 'improvement', 'capability_gap')),
  trigger TEXT NOT NULL,
  lesson TEXT NOT NULL,
  action TEXT,
  severity TEXT DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  source_session_id UUID REFERENCES sessions(id),
  applied_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS learnings_agent_id_idx ON learnings(agent_id);
CREATE INDEX IF NOT EXISTS learnings_category_idx ON learnings(category);
CREATE INDEX IF NOT EXISTS learnings_severity_idx ON learnings(severity);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER memories_updated_at
  BEFORE UPDATE ON memories
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Row Level Security (optional - enable if using Supabase auth)
-- ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE learnings ENABLE ROW LEVEL SECURITY;
