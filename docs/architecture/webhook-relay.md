# Supabase Webhook Relay & Agent Coordination for OpenClaw

## Overview

Dual-purpose architecture that provides:
1. **Webhook Relay** - Secure external webhook ingestion while keeping OpenClaw gateway private
2. **Agent Task Queue** - Cross-agent coordination and task delegation (solves webchat pairing limitations)

### Webhook Flow

```
External Services (GitHub, Stripe)
         │ HTTPS POST
         ▼
Supabase Edge Function
  - Validate signature
  - Rate limit
  - Write to webhook_events
         │ INSERT
         ▼
PostgreSQL (webhook_events)
  - Realtime enabled
         │ Realtime subscription
         ▼
OpenClaw Hook (any agent)
  - Process webhook
  - Route to appropriate agent
  - Update status
```

### Agent Coordination Flow

```
Agent A (Zak - webchat)
         │ Write task
         ▼
PostgreSQL (agent_tasks)
  - Task queue with priority
  - Realtime enabled
         │ Realtime subscription (filter: to_agent)
         ▼
Agent B (Riley - any instance)
  - Pick up task
  - Process & respond
  - Write result back
         │
         ▼
Agent A polls or subscribes for completion
```

---

## Database Schema

### webhook_events table

```sql
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Source identification
  source TEXT NOT NULL,              -- 'github', 'stripe', 'custom', etc.
  event_type TEXT NOT NULL,          -- 'push', 'pull_request', 'payment.succeeded'
  
  -- Webhook payload
  headers JSONB NOT NULL,            -- Request headers
  body JSONB NOT NULL,               -- Request body
  signature TEXT,                    -- HMAC signature if provided
  
  -- Processing state
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'processing', 'completed', 'failed'
  processed_at TIMESTAMPTZ,
  error TEXT,
  
  -- OpenClaw routing
  target_agent TEXT,                 -- Optional: specific agent to handle
  target_session TEXT,               -- Optional: specific session
  response JSONB,                    -- Agent response/result
  
  -- Security/audit
  source_ip TEXT,
  user_agent TEXT,
  signature_valid BOOLEAN
);

-- Indexes
CREATE INDEX idx_webhook_events_status ON webhook_events(status);
CREATE INDEX idx_webhook_events_source ON webhook_events(source);
CREATE INDEX idx_webhook_events_created ON webhook_events(created_at DESC);
CREATE INDEX idx_webhook_events_pending ON webhook_events(status, created_at) 
  WHERE status = 'pending';

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE webhook_events;

-- Row Level Security
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;

-- Policy: Service role can do everything
CREATE POLICY "Service role has full access" ON webhook_events
  FOR ALL USING (auth.role() = 'service_role');

-- Policy: Anon role can only insert (webhook receiver)
CREATE POLICY "Anon can insert webhooks" ON webhook_events
  FOR INSERT WITH CHECK (true);

-- Function to update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_webhook_events_updated_at 
  BEFORE UPDATE ON webhook_events
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();
```

### webhook_sources table (optional rate limiting)

```sql
CREATE TABLE webhook_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT UNIQUE NOT NULL,
  secret TEXT NOT NULL,              -- HMAC secret for validation
  rate_limit_per_minute INTEGER DEFAULT 60,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed common sources
INSERT INTO webhook_sources (source, secret, rate_limit_per_minute) VALUES
  ('github', 'your-github-webhook-secret', 100),
  ('stripe', 'your-stripe-webhook-secret', 60);
```

### agent_tasks table (Agent-to-Agent Communication)

```sql
CREATE TABLE agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  -- Routing
  from_agent TEXT NOT NULL,           -- 'zak-sterling'
  to_agent TEXT NOT NULL,             -- 'riley-chase', 'nix-tanaka', etc.
  
  -- Task details
  task TEXT NOT NULL,                 -- The actual request/message
  context JSONB,                      -- Optional structured data
  label TEXT,                         -- Optional task label/type
  
  -- Processing state
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'processing', 'completed', 'failed'
  picked_up_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result TEXT,                        -- Agent response/output
  error TEXT,                         -- Error message if failed
  
  -- Priority & timeout
  priority INTEGER DEFAULT 5,         -- 1=urgent, 5=normal, 10=low
  timeout_seconds INTEGER DEFAULT 600,
  expires_at TIMESTAMPTZ DEFAULT (now() + interval '1 hour')
);

-- Indexes
CREATE INDEX idx_agent_tasks_to_agent_status ON agent_tasks(to_agent, status, priority, created_at);
CREATE INDEX idx_agent_tasks_from_agent ON agent_tasks(from_agent, created_at DESC);
CREATE INDEX idx_agent_tasks_expires ON agent_tasks(expires_at) WHERE status = 'pending';

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE agent_tasks;

-- Row Level Security
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role has full access" ON agent_tasks
  FOR ALL USING (auth.role() = 'service_role');

-- Auto-update trigger
CREATE TRIGGER update_agent_tasks_updated_at 
  BEFORE UPDATE ON agent_tasks
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();

-- Cleanup expired tasks
CREATE OR REPLACE FUNCTION cleanup_expired_agent_tasks()
RETURNS void AS $$
BEGIN
  DELETE FROM agent_tasks 
  WHERE status = 'pending' 
    AND expires_at < now();
END;
$$ LANGUAGE plpgsql;

-- Run cleanup daily via pg_cron or Edge Function
```

**Use Cases:**
- Zak routes tasks to Riley (product specs) or Nix (engineering)
- Cross-agent coordination without direct RPC (webchat limitation workaround)
- Async task delegation with priority queuing
- Audit trail of agent collaboration

---

## Supabase Edge Function

### File: `supabase/functions/webhook-relay/index.ts`

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // Extract webhook metadata
    const url = new URL(req.url)
    const source = url.searchParams.get('source') || 'unknown'
    const headers = Object.fromEntries(req.headers.entries())
    const body = await req.json()
    
    // Get source config for validation
    const { data: sourceConfig } = await supabase
      .from('webhook_sources')
      .select('*')
      .eq('source', source)
      .single()

    if (sourceConfig && !sourceConfig.enabled) {
      return new Response(
        JSON.stringify({ error: 'Source disabled' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate signature (example for GitHub)
    let signatureValid = false
    if (source === 'github' && sourceConfig?.secret) {
      const signature = headers['x-hub-signature-256']
      if (signature) {
        const key = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(sourceConfig.secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign']
        )
        const expectedSig = await crypto.subtle.sign(
          'HMAC',
          key,
          new TextEncoder().encode(JSON.stringify(body))
        )
        const expectedHex = 'sha256=' + Array.from(new Uint8Array(expectedSig))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
        signatureValid = signature === expectedHex
      }
    }

    // Rate limiting check (simple window)
    if (sourceConfig?.rate_limit_per_minute) {
      const { count } = await supabase
        .from('webhook_events')
        .select('*', { count: 'exact', head: true })
        .eq('source', source)
        .gte('created_at', new Date(Date.now() - 60000).toISOString())

      if (count && count >= sourceConfig.rate_limit_per_minute) {
        return new Response(
          JSON.stringify({ error: 'Rate limit exceeded' }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
    }

    // Insert webhook event
    const { data: event, error } = await supabase
      .from('webhook_events')
      .insert({
        source,
        event_type: headers['x-github-event'] || body.type || 'unknown',
        headers,
        body,
        signature: headers['x-hub-signature-256'] || headers['stripe-signature'],
        signature_valid: signatureValid,
        source_ip: headers['x-forwarded-for'] || 'unknown',
        user_agent: headers['user-agent'],
      })
      .select()
      .single()

    if (error) {
      throw error
    }

    return new Response(
      JSON.stringify({ success: true, event_id: event.id }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200 
      }
    )

  } catch (error) {
    console.error('Webhook processing error:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500 
      }
    )
  }
})
```

---

## OpenClaw Integration

### Option A: Realtime Subscription Hook (Recommended)

Create a hook file: `~/.openclaw/hooks/webhook-listener.ts`

```typescript
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

let subscription: any = null

export async function on_gateway_ready(ctx: any) {
  const supabase = createClient(supabaseUrl, supabaseKey)
  
  console.log('[webhook-listener] Starting Realtime subscription...')
  
  subscription = supabase
    .channel('webhook_events')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'webhook_events'
      },
      async (payload) => {
        console.log('[webhook-listener] New webhook:', payload.new)
        
        const event = payload.new
        
        // Mark as processing
        await supabase
          .from('webhook_events')
          .update({ status: 'processing', processed_at: new Date().toISOString() })
          .eq('id', event.id)
        
        try {
          // Route to appropriate agent
          const targetAgent = event.target_agent || 'zak-sterling'
          const message = formatWebhookMessage(event)
          
          // Send to agent via OpenClaw gateway
          const response = await ctx.gateway.agent.request({
            agentId: targetAgent,
            message,
            waitForResponse: true,
            timeoutMs: 30000
          })
          
          // Mark as completed
          await supabase
            .from('webhook_events')
            .update({ 
              status: 'completed',
              response: { text: response.text }
            })
            .eq('id', event.id)
          
        } catch (error) {
          console.error('[webhook-listener] Processing error:', error)
          
          // Mark as failed
          await supabase
            .from('webhook_events')
            .update({ 
              status: 'failed',
              error: error.message
            })
            .eq('id', event.id)
        }
      }
    )
    .subscribe()
}

export async function on_gateway_close() {
  if (subscription) {
    subscription.unsubscribe()
    console.log('[webhook-listener] Realtime subscription closed')
  }
}

function formatWebhookMessage(event: any): string {
  const { source, event_type, body } = event
  
  if (source === 'github') {
    if (event_type === 'push') {
      const { repository, pusher, commits } = body
      return `GitHub push to ${repository.full_name} by ${pusher.name}: ${commits.length} commits`
    }
    if (event_type === 'pull_request') {
      const { action, pull_request } = body
      return `GitHub PR ${action}: ${pull_request.title} (#${pull_request.number})`
    }
  }
  
  // Generic fallback
  return `Webhook from ${source}: ${event_type}\n\nPayload:\n${JSON.stringify(body, null, 2)}`
}
```

### Environment variables

Add to `~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": ["~/.openclaw/hooks/webhook-listener.ts"]
    }
  },
  "env": {
    "SUPABASE_URL": "https://your-project.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "your-service-role-key"
  }
}
```

### Agent Task Queue Listener

Create a second hook for agent-to-agent coordination: `~/.openclaw/hooks/agent-task-listener.ts`

```typescript
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL!
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const agentId = process.env.OPENCLAW_AGENT_ID || 'zak-sterling'

let subscription: any = null

export async function on_gateway_ready(ctx: any) {
  const supabase = createClient(supabaseUrl, supabaseKey)
  
  console.log(`[agent-tasks] Agent ${agentId} listening for tasks...`)
  
  subscription = supabase
    .channel('agent_tasks')
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'agent_tasks',
        filter: `to_agent=eq.${agentId}`
      },
      async (payload) => {
        const task = payload.new
        console.log(`[agent-tasks] New task from ${task.from_agent}:`, task.task)
        
        // Mark as processing
        await supabase
          .from('agent_tasks')
          .update({ 
            status: 'processing', 
            picked_up_at: new Date().toISOString() 
          })
          .eq('id', task.id)
        
        try {
          // Execute task via local agent
          const response = await ctx.agent.run({
            message: task.task,
            context: task.context
          })
          
          // Mark as completed
          await supabase
            .from('agent_tasks')
            .update({ 
              status: 'completed',
              completed_at: new Date().toISOString(),
              result: response.text
            })
            .eq('id', task.id)
          
        } catch (error) {
          console.error('[agent-tasks] Task failed:', error)
          
          await supabase
            .from('agent_tasks')
            .update({ 
              status: 'failed',
              completed_at: new Date().toISOString(),
              error: error.message
            })
            .eq('id', task.id)
        }
      }
    )
    .subscribe()
}

export async function on_gateway_close() {
  if (subscription) {
    subscription.unsubscribe()
    console.log('[agent-tasks] Task subscription closed')
  }
}
```

**To use from any agent:**

```typescript
// In agent code or another hook
async function delegateToAgent(toAgent: string, task: string, context?: any) {
  const { data, error } = await supabase
    .from('agent_tasks')
    .insert({
      from_agent: agentId,
      to_agent: toAgent,
      task,
      context,
      priority: 5
    })
    .select()
    .single()
  
  if (error) throw error
  return data.id
}

// Example: Zak routes to Riley
await delegateToAgent(
  'riley-chase', 
  'Design a Supabase webhook relay spec',
  { deadline: '2026-02-22', format: 'markdown' }
)
```

**Update handlers list:**

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        "~/.openclaw/hooks/webhook-listener.ts",
        "~/.openclaw/hooks/agent-task-listener.ts"
      ]
    }
  }
}
```

---

### Option B: Cron Polling (Fallback)

If Realtime doesn't work:

```bash
openclaw cron add \
  --schedule "*/30 * * * * *" \
  --label "webhook-poller" \
  --delivery.mode webhook \
  --delivery.webhook "https://your-function-url/process-webhooks"
```

Handler function to poll pending webhooks.

---

## Security Checklist

- [ ] **Webhook secrets configured** - Store in `webhook_sources` table, never in code
- [ ] **Signature validation** - Verify HMAC signatures for all sources
- [ ] **Rate limiting** - Enforce per-source rate limits
- [ ] **Row-level security** - Anon role can only INSERT, service role for reads
- [ ] **IP allowlisting** (optional) - Add source IP validation for known providers
- [ ] **HTTPS only** - Edge function enforces HTTPS
- [ ] **OpenClaw gateway stays private** - Never expose localhost:18789
- [ ] **Service role key protected** - Store in OpenClaw env, not in code
- [ ] **Error handling** - Failed webhooks logged with status='failed'
- [ ] **Audit trail** - All events logged with headers, IP, timestamp
- [ ] **Payload size limits** - Add Edge Function size validation (max 1MB)

---

## Implementation Steps

### 1. Set up Supabase tables

```bash
# In your Supabase SQL editor:
# - Copy webhook_events schema above
# - Copy webhook_sources schema above
# - Copy agent_tasks schema above
# - Run all CREATE TABLE statements
```

### 2. Deploy Edge Function

```bash
cd your-supabase-project
supabase functions new webhook-relay
# Copy the index.ts code above
supabase functions deploy webhook-relay
```

### 3. Configure webhook sources

```sql
-- Add your webhook secrets
INSERT INTO webhook_sources (source, secret, rate_limit_per_minute) VALUES
  ('github', 'your-github-secret-here', 100);
```

### 4. Install OpenClaw dependencies

```bash
cd ~/.openclaw
npm install @supabase/supabase-js
```

### 5. Create the hooks

```bash
# Copy both hook files to:
~/.openclaw/hooks/webhook-listener.ts
~/.openclaw/hooks/agent-task-listener.ts

# Set agent ID environment variable
export OPENCLAW_AGENT_ID="zak-sterling"  # Or whichever agent this is
```

### 6. Update OpenClaw config

```bash
openclaw config set hooks.internal.enabled true
openclaw config set hooks.internal.handlers '["~/.openclaw/hooks/webhook-listener.ts","~/.openclaw/hooks/agent-task-listener.ts"]'
openclaw config set env.SUPABASE_URL "https://your-project.supabase.co"
openclaw config set env.SUPABASE_SERVICE_ROLE_KEY "your-service-role-key"
openclaw config set env.OPENCLAW_AGENT_ID "zak-sterling"
```

### 7. Restart gateway

```bash
openclaw gateway restart
```

### 8. Test webhook delivery

```bash
# Get your Edge Function URL
curl -X POST "https://your-project.supabase.co/functions/v1/webhook-relay?source=test" \
  -H "Content-Type: application/json" \
  -d '{"test": "hello from webhook"}'

# Check logs
openclaw logs --follow
```

### 9. Configure external services

**GitHub:**
- Go to repo Settings > Webhooks > Add webhook
- Payload URL: `https://your-project.supabase.co/functions/v1/webhook-relay?source=github`
- Content type: `application/json`
- Secret: (your github secret from webhook_sources)
- Events: Choose events (push, pull_request, etc.)

**Stripe:**
- Dashboard > Developers > Webhooks
- Add endpoint: `https://your-project.supabase.co/functions/v1/webhook-relay?source=stripe`
- Copy signing secret to webhook_sources table

---

## Example Flow: GitHub Push Webhook

1. **Developer pushes code** → GitHub sends webhook
2. **Edge Function receives** → Validates signature, checks rate limit
3. **Event inserted** → `webhook_events` table with status='pending'
4. **Realtime triggers** → OpenClaw hook receives INSERT event
5. **Hook routes to Zak** → Formats message, sends to agent
6. **Zak processes** → Reads commit details, decides action
7. **Zak can dispatch** → Route to Nix for CI check, or notify Jason
8. **Status updated** → `webhook_events.status = 'completed'`

---

## Advanced: Multi-agent Routing

Add routing logic to the hook:

```typescript
function routeWebhook(event: any): string {
  const { source, event_type, body } = event
  
  // GitHub PRs → Riley (product review)
  if (source === 'github' && event_type === 'pull_request') {
    return 'riley-chase'
  }
  
  // GitHub CI failures → Nix (engineering)
  if (source === 'github' && event_type === 'check_run' && body.check_run.conclusion === 'failure') {
    return 'nix-tanaka'
  }
  
  // Stripe payments → Leo (personal assistant)
  if (source === 'stripe' && event_type.startsWith('payment')) {
    return 'leo-vance'
  }
  
  // Everything else → Zak (router)
  return 'zak-sterling'
}
```

---

## Agent-to-Agent Coordination Examples

### Example 1: Zak Routes Architecture Work to Riley

**Zak's code (in workspace or hook):**

```typescript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Zak delegates to Riley
const { data: task } = await supabase
  .from('agent_tasks')
  .insert({
    from_agent: 'zak-sterling',
    to_agent: 'riley-chase',
    task: 'Design a Supabase webhook relay spec for OpenClaw integration',
    context: {
      requirements: [
        'Keep gateway localhost-only',
        'Support external webhooks',
        'Enable agent task queue'
      ],
      deadline: '2026-02-22'
    },
    priority: 3  // Higher priority
  })
  .select()
  .single()

console.log(`Task delegated to Riley: ${task.id}`)
```

**Riley's instance automatically picks it up via Realtime subscription, processes it, and writes the result back.**

---

### Example 2: Check Task Status

```typescript
// Poll for completion (if not using Realtime)
async function waitForTaskCompletion(taskId: string, timeoutMs = 60000) {
  const start = Date.now()
  
  while (Date.now() - start < timeoutMs) {
    const { data: task } = await supabase
      .from('agent_tasks')
      .select('*')
      .eq('id', taskId)
      .single()
    
    if (task.status === 'completed') {
      return task.result
    }
    
    if (task.status === 'failed') {
      throw new Error(task.error)
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  
  throw new Error('Task timeout')
}

// Use it
const result = await waitForTaskCompletion(task.id)
console.log('Riley completed:', result)
```

---

### Example 3: Nix Handles Engineering Tasks

**Agent task listener in Nix's workspace** automatically processes:
- GitHub CI failures
- Code review requests
- Deployment coordination

```typescript
// Nix-specific task handling
if (task.label === 'ci-failure') {
  const { repo, run_id } = task.context
  
  // Nix investigates logs, files issue, suggests fix
  const analysis = await analyzeCIFailure(repo, run_id)
  
  return {
    status: 'completed',
    result: analysis
  }
}
```

---

### Example 4: Priority Queue for Urgent Tasks

```typescript
// Zak marks urgent task
await supabase.from('agent_tasks').insert({
  from_agent: 'zak-sterling',
  to_agent: 'leo-vance',
  task: 'Book emergency flight for Jason - laptop left at airport',
  priority: 1,  // Urgent
  timeout_seconds: 300
})
```

Agents process tasks in priority order (1 = highest).

---

### Example 5: Broadcast Task to Multiple Agents

```typescript
// Ask all agents for input
const agents = ['riley-chase', 'nix-tanaka', 'leo-vance']

const tasks = await Promise.all(
  agents.map(agent =>
    supabase.from('agent_tasks').insert({
      from_agent: 'zak-sterling',
      to_agent: agent,
      task: 'Review Q1 planning doc and provide feedback',
      priority: 5
    }).select().single()
  )
)

// Wait for all responses
const results = await Promise.all(
  tasks.map(t => waitForTaskCompletion(t.data.id))
)

console.log('All agent feedback:', results)
```

---

### Example 6: WebChat Workaround

Since webchat sessions can't use `sessions_send`, Zak writes to the task queue instead:

```typescript
// Instead of sessions_send (which fails from webchat)
async function routeToAgent(agent: string, message: string) {
  const { data } = await supabase
    .from('agent_tasks')
    .insert({
      from_agent: 'zak-sterling',
      to_agent: agent,
      task: message,
      priority: 5
    })
    .select()
    .single()
  
  return data.id
}

// Works from any OpenClaw instance
await routeToAgent('riley-chase', 'Design webhook relay spec')
```

---

## Monitoring & Debugging

### View pending webhooks

```sql
SELECT id, source, event_type, created_at, status 
FROM webhook_events 
WHERE status = 'pending' 
ORDER BY created_at DESC;
```

### View failed webhooks

```sql
SELECT id, source, event_type, error, created_at 
FROM webhook_events 
WHERE status = 'failed' 
ORDER BY created_at DESC;
```

### Reprocess a failed webhook

```sql
UPDATE webhook_events 
SET status = 'pending', error = NULL 
WHERE id = 'failed-event-id-here';
```

### OpenClaw logs

```bash
openclaw logs --follow | grep webhook
```

### View pending agent tasks

```sql
SELECT id, from_agent, to_agent, task, priority, created_at, status
FROM agent_tasks
WHERE status = 'pending'
ORDER BY priority ASC, created_at ASC;
```

### View agent task history

```sql
SELECT 
  from_agent,
  to_agent,
  COUNT(*) as total_tasks,
  COUNT(*) FILTER (WHERE status = 'completed') as completed,
  COUNT(*) FILTER (WHERE status = 'failed') as failed,
  AVG(EXTRACT(EPOCH FROM (completed_at - created_at))) as avg_completion_seconds
FROM agent_tasks
WHERE created_at > now() - interval '7 days'
GROUP BY from_agent, to_agent
ORDER BY total_tasks DESC;
```

### Retry failed agent task

```sql
UPDATE agent_tasks 
SET 
  status = 'pending', 
  error = NULL,
  picked_up_at = NULL,
  expires_at = now() + interval '1 hour'
WHERE id = 'failed-task-id-here';
```

### Agent task dashboard

```sql
-- Current agent workload
SELECT 
  to_agent,
  COUNT(*) FILTER (WHERE status = 'pending') as pending,
  COUNT(*) FILTER (WHERE status = 'processing') as processing,
  COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '1 hour') as completed_last_hour
FROM agent_tasks
GROUP BY to_agent
ORDER BY pending DESC;
```

---

## Cost Considerations

- **Supabase Edge Functions**: 500K invocations/month free
- **Supabase Database**: 500MB free (plenty for webhook logs)
- **Realtime**: Included in free tier (200 concurrent connections)
- **Bandwidth**: 2GB free egress/month

For production: Archive old webhooks after 30 days to manage storage.

```sql
-- Archive old completed webhooks
DELETE FROM webhook_events 
WHERE status = 'completed' 
  AND created_at < now() - interval '30 days';
```

---

**Ready to implement?** Let me know if you need clarification on any section.
