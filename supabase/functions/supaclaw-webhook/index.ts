import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const MAX_BODY_SIZE = 100 * 1024; // 100KB

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function hashSecretWeb(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyWebhookSecret(
  authHeader: string | null
): Promise<{ valid: boolean; agentId?: string; sourceId?: string; allowedActions?: string[] }> {
  if (!authHeader?.startsWith('Bearer whsec_')) {
    return { valid: false };
  }

  const secret = authHeader.replace('Bearer ', '');
  const secretHash = await hashSecretWeb(secret);

  const { data, error } = await supabase
    .from('webhook_sources')
    .select('id, agent_id, allowed_actions')
    .eq('secret_hash', secretHash)
    .eq('enabled', true)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return { valid: false };
  }

  return {
    valid: true,
    agentId: data.agent_id,
    sourceId: data.id,
    allowedActions: data.allowed_actions,
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// ============ Action Handlers ============

async function handleGetOrCreateSession(
  agentId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const externalKey = body.external_key as string;
  if (!externalKey) {
    return errorResponse('external_key is required');
  }

  // Look up active session
  const { data: existing, error: lookupError } = await supabase
    .from('sessions')
    .select()
    .eq('external_key', externalKey)
    .eq('agent_id', agentId)
    .is('ended_at', null)
    .maybeSingle();

  if (lookupError) {
    return errorResponse('Lookup failed: ' + lookupError.message, 500);
  }

  if (existing) {
    return jsonResponse({ session_id: existing.id, is_new: false });
  }

  // Create new session
  const { data: created, error: createError } = await supabase
    .from('sessions')
    .insert({
      agent_id: agentId,
      external_key: externalKey,
      user_id: (body.user_id as string) || undefined,
      channel: (body.channel as string) || undefined,
      metadata: (body.metadata as Record<string, unknown>) || {},
    })
    .select()
    .single();

  if (createError) {
    return errorResponse('Create failed: ' + createError.message, 500);
  }

  return jsonResponse({ session_id: created.id, is_new: true }, 201);
}

async function handleLogMessage(
  agentId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const sessionId = body.session_id as string;
  const role = body.role as string;
  const content = body.content as string;

  if (!sessionId || !role || !content) {
    return errorResponse('session_id, role, and content are required');
  }

  // Verify session exists and is active
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('id, agent_id, ended_at')
    .eq('id', sessionId)
    .eq('agent_id', agentId)
    .maybeSingle();

  if (sessionError || !session) {
    return errorResponse('Session not found', 404);
  }

  if (session.ended_at) {
    return errorResponse('Session already ended', 409);
  }

  const { data, error } = await supabase
    .from('messages')
    .insert({
      session_id: sessionId,
      role,
      content,
      metadata: (body.metadata as Record<string, unknown>) || {},
    })
    .select()
    .single();

  if (error) {
    return errorResponse('Insert failed: ' + error.message, 500);
  }

  return jsonResponse({ message_id: data.id }, 201);
}

async function handleEndSession(
  agentId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const sessionId = body.session_id as string;
  if (!sessionId) {
    return errorResponse('session_id is required');
  }

  // Check session state (idempotent)
  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('id, agent_id, ended_at')
    .eq('id', sessionId)
    .eq('agent_id', agentId)
    .maybeSingle();

  if (sessionError || !session) {
    return errorResponse('Session not found', 404);
  }

  if (session.ended_at) {
    return jsonResponse({ session_id: sessionId, already_ended: true });
  }

  const updatePayload: Record<string, unknown> = {
    ended_at: new Date().toISOString(),
  };

  if (body.summary) {
    updatePayload.summary = body.summary;
  }

  const { error } = await supabase
    .from('sessions')
    .update(updatePayload)
    .eq('id', sessionId);

  if (error) {
    return errorResponse('Update failed: ' + error.message, 500);
  }

  return jsonResponse({ session_id: sessionId, ended: true });
}

// ============ Main Handler ============

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  // Enforce body size limit
  const contentLength = req.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return errorResponse('Request body too large', 413);
  }

  // Verify webhook secret
  const auth = await verifyWebhookSecret(req.headers.get('authorization'));
  if (!auth.valid || !auth.agentId) {
    return errorResponse('Unauthorized', 401);
  }

  // Parse action from URL path
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter(Boolean);
  // Path: /supaclaw-webhook/<action>
  const action = pathParts[pathParts.length - 1];

  // Check allowed actions
  const actionMap: Record<string, string> = {
    'get-or-create-session': 'get_or_create_session',
    'log-message': 'log_message',
    'end-session': 'end_session',
  };

  const normalizedAction = actionMap[action];
  if (!normalizedAction) {
    return errorResponse('Unknown action: ' + action, 404);
  }

  if (auth.allowedActions && !auth.allowedActions.includes(normalizedAction)) {
    return errorResponse('Action not allowed for this source', 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body');
  }

  switch (action) {
    case 'get-or-create-session':
      return handleGetOrCreateSession(auth.agentId, body);
    case 'log-message':
      return handleLogMessage(auth.agentId, body);
    case 'end-session':
      return handleEndSession(auth.agentId, body);
    default:
      return errorResponse('Unknown action', 404);
  }
});
