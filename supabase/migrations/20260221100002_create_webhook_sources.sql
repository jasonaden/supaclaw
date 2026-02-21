-- Webhook sources: authorized external integrations
CREATE TABLE IF NOT EXISTS webhook_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  allowed_actions TEXT[] DEFAULT ARRAY['log_message', 'end_session', 'get_or_create_session'],
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_sources_agent_id_idx ON webhook_sources(agent_id);
CREATE INDEX IF NOT EXISTS webhook_sources_enabled_idx ON webhook_sources(enabled) WHERE enabled = true;
