import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============ Crypto Helpers ============

async function hashSecretWeb(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `whsec_${base64}`;
}

// ============ Auth ============

async function verifyJwt(authHeader: string | null): Promise<{ valid: boolean; userId?: string }> {
  if (!authHeader?.startsWith('Bearer ')) {
    return { valid: false };
  }

  const token = authHeader.replace('Bearer ', '');
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error } = await userClient.auth.getUser(token);
  if (error || !user) {
    return { valid: false };
  }

  return { valid: true, userId: user.id };
}

// ============ Helpers ============

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

// ============ API Handlers ============

async function handleListSources(): Promise<Response> {
  const { data, error } = await adminClient
    .from('webhook_sources')
    .select('id, agent_id, name, enabled, allowed_actions, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    return errorResponse('Failed to list sources: ' + error.message, 500);
  }

  return jsonResponse({ sources: data || [] });
}

async function handleRegisterSource(body: Record<string, unknown>): Promise<Response> {
  const name = body.name as string;
  const agentId = body.agent_id as string;

  if (!name || !agentId) {
    return errorResponse('name and agent_id are required');
  }

  const secret = generateWebhookSecret();
  const secretHash = await hashSecretWeb(secret);

  const { error } = await adminClient.from('webhook_sources').insert({
    agent_id: agentId,
    name,
    secret_hash: secretHash,
  });

  if (error) {
    return errorResponse('Failed to register: ' + error.message, 500);
  }

  return jsonResponse({ ok: true, secret }, 201);
}

async function handleToggleSource(id: string, body: Record<string, unknown>): Promise<Response> {
  const enabled = body.enabled as boolean;
  if (typeof enabled !== 'boolean') {
    return errorResponse('enabled (boolean) is required');
  }

  const { error } = await adminClient
    .from('webhook_sources')
    .update({ enabled })
    .eq('id', id);

  if (error) {
    return errorResponse('Failed to update: ' + error.message, 500);
  }

  return jsonResponse({ ok: true, id, enabled });
}

async function handleRevokeSource(id: string): Promise<Response> {
  const { error } = await adminClient
    .from('webhook_sources')
    .update({ enabled: false })
    .eq('id', id);

  if (error) {
    return errorResponse('Failed to revoke: ' + error.message, 500);
  }

  return jsonResponse({ ok: true, id, revoked: true });
}

// ============ Admin HTML Page ============
// Uses safe DOM manipulation (createElement + textContent) throughout.
// No innerHTML with user data — all dynamic content is set via textContent.

function getAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Supaclaw Webhook Admin</title>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f8f9fa; }
    h1 { margin-bottom: 20px; color: #1a1a2e; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .form-row { display: flex; gap: 8px; margin-bottom: 12px; }
    input, button { padding: 8px 12px; border: 1px solid #ddd; border-radius: 4px; font-size: 14px; }
    input { flex: 1; }
    button { cursor: pointer; background: #4361ee; color: white; border: none; }
    button:hover { background: #3a56d4; }
    button.danger { background: #e63946; }
    button.danger:hover { background: #c1121f; }
    button.toggle { background: #6c757d; }
    .source { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee; }
    .source:last-child { border-bottom: none; }
    .source-info { flex: 1; }
    .source-name { font-weight: 600; }
    .source-meta { font-size: 12px; color: #666; margin-top: 4px; }
    .source-actions { display: flex; gap: 8px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .badge-enabled { background: #d4edda; color: #155724; }
    .badge-disabled { background: #f8d7da; color: #721c24; }
    .secret-display { background: #fff3cd; border: 1px solid #ffc107; padding: 12px; border-radius: 4px; margin-top: 12px; font-family: monospace; word-break: break-all; }
    #login-section, #admin-section { display: none; }
    .login-form { max-width: 400px; margin: 100px auto; }
    .login-form input { width: 100%; margin-bottom: 8px; }
    .login-form button { width: 100%; }
    .msg { padding: 8px; margin: 8px 0; border-radius: 4px; font-size: 13px; }
    .msg-info { background: #d1ecf1; color: #0c5460; }
  </style>
</head>
<body>
  <div id="login-section">
    <div class="login-form card">
      <h1>Supaclaw Admin</h1>
      <p style="margin-bottom: 16px; color: #666;">Sign in with your Supabase account</p>
      <input type="email" id="email" placeholder="Email address">
      <button onclick="sendMagicLink()">Send Magic Link</button>
      <div id="login-msg"></div>
    </div>
  </div>

  <div id="admin-section">
    <h1>Webhook Sources</h1>

    <div class="card">
      <h3 style="margin-bottom: 12px;">Register New Source</h3>
      <div class="form-row">
        <input type="text" id="new-name" placeholder="Source name (e.g. telegram-bot)">
        <input type="text" id="new-agent" placeholder="Agent ID">
        <button onclick="registerSource()">Register</button>
      </div>
      <div id="register-result"></div>
    </div>

    <div class="card">
      <h3 style="margin-bottom: 12px;">Registered Sources</h3>
      <div id="sources-list">Loading...</div>
    </div>
  </div>

  <script>
    const SUPABASE_URL = '${SUPABASE_URL}';
    const SUPABASE_ANON_KEY = '${SUPABASE_ANON_KEY}';
    const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    let accessToken = null;

    function clearChildren(el) {
      while (el.firstChild) el.removeChild(el.firstChild);
    }

    async function init() {
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        accessToken = session.access_token;
        showAdmin();
      } else {
        document.getElementById('login-section').style.display = 'block';
      }

      sb.auth.onAuthStateChange(function(event, session) {
        if (session) {
          accessToken = session.access_token;
          showAdmin();
        }
      });
    }

    async function sendMagicLink() {
      var email = document.getElementById('email').value;
      var result = await sb.auth.signInWithOtp({ email: email });
      var msgEl = document.getElementById('login-msg');
      clearChildren(msgEl);
      var el = document.createElement('div');
      el.className = 'msg msg-info';
      if (result.error) {
        el.textContent = 'Error: ' + result.error.message;
      } else {
        el.textContent = 'Check your email for the magic link!';
      }
      msgEl.appendChild(el);
    }

    function showAdmin() {
      document.getElementById('login-section').style.display = 'none';
      document.getElementById('admin-section').style.display = 'block';
      loadSources();
    }

    async function apiCall(method, path, body) {
      var opts = {
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
        },
      };
      if (body) opts.body = JSON.stringify(body);
      var res = await fetch(SUPABASE_URL + '/functions/v1/webhook-admin' + path, opts);
      return res.json();
    }

    async function loadSources() {
      var data = await apiCall('GET', '/sources');
      var list = document.getElementById('sources-list');
      clearChildren(list);

      if (!data.sources || data.sources.length === 0) {
        list.textContent = 'No webhook sources registered.';
        return;
      }

      data.sources.forEach(function(src) {
        var div = document.createElement('div');
        div.className = 'source';

        var info = document.createElement('div');
        info.className = 'source-info';

        var nameEl = document.createElement('span');
        nameEl.className = 'source-name';
        nameEl.textContent = src.name;

        var badge = document.createElement('span');
        badge.className = 'badge ' + (src.enabled ? 'badge-enabled' : 'badge-disabled');
        badge.textContent = src.enabled ? 'enabled' : 'disabled';

        var meta = document.createElement('div');
        meta.className = 'source-meta';
        meta.textContent = 'Agent: ' + src.agent_id + ' | ID: ' + src.id;

        info.appendChild(nameEl);
        info.appendChild(document.createTextNode(' '));
        info.appendChild(badge);
        info.appendChild(meta);

        var actions = document.createElement('div');
        actions.className = 'source-actions';

        var toggleBtn = document.createElement('button');
        toggleBtn.className = 'toggle';
        toggleBtn.textContent = src.enabled ? 'Disable' : 'Enable';
        toggleBtn.onclick = function() { toggleSource(src.id, !src.enabled); };

        var revokeBtn = document.createElement('button');
        revokeBtn.className = 'danger';
        revokeBtn.textContent = 'Revoke';
        revokeBtn.onclick = function() { revokeSource(src.id); };

        actions.appendChild(toggleBtn);
        actions.appendChild(revokeBtn);

        div.appendChild(info);
        div.appendChild(actions);
        list.appendChild(div);
      });
    }

    async function registerSource() {
      var name = document.getElementById('new-name').value;
      var agentId = document.getElementById('new-agent').value;
      if (!name || !agentId) return alert('Name and Agent ID are required');

      var data = await apiCall('POST', '/sources', { name: name, agent_id: agentId });
      var resultEl = document.getElementById('register-result');
      clearChildren(resultEl);

      if (data.secret) {
        var secretDiv = document.createElement('div');
        secretDiv.className = 'secret-display';
        secretDiv.textContent = 'Secret (save this, shown only once): ' + data.secret;
        resultEl.appendChild(secretDiv);
        document.getElementById('new-name').value = '';
        document.getElementById('new-agent').value = '';
        loadSources();
      } else if (data.error) {
        var errDiv = document.createElement('div');
        errDiv.className = 'msg msg-info';
        errDiv.textContent = 'Error: ' + data.error;
        resultEl.appendChild(errDiv);
      }
    }

    async function toggleSource(id, enabled) {
      await apiCall('PATCH', '/sources/' + id, { enabled: enabled });
      loadSources();
    }

    async function revokeSource(id) {
      if (!confirm('Revoke this webhook source? This cannot be undone.')) return;
      await apiCall('DELETE', '/sources/' + id);
      loadSources();
    }

    init();
  </script>
</body>
</html>`;
}

// ============ Main Handler ============

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const pathParts = url.pathname.split('/').filter(Boolean);
  const action = pathParts.slice(1).join('/') || '';

  // Serve admin HTML on GET /
  if (req.method === 'GET' && (action === '' || action === 'webhook-admin')) {
    return new Response(getAdminHtml(), {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // All API routes require JWT auth
  const auth = await verifyJwt(req.headers.get('authorization'));
  if (!auth.valid) {
    return errorResponse('Unauthorized', 401);
  }

  // Route API calls
  if (action === 'sources' || action === 'webhook-admin/sources') {
    if (req.method === 'GET') {
      return handleListSources();
    }
    if (req.method === 'POST') {
      const body = await req.json();
      return handleRegisterSource(body);
    }
  }

  // Match /sources/:id
  const sourceMatch = action.match(/(?:webhook-admin\/)?sources\/([a-f0-9-]+)/);
  if (sourceMatch) {
    const id = sourceMatch[1];
    if (req.method === 'PATCH') {
      const body = await req.json();
      return handleToggleSource(id, body);
    }
    if (req.method === 'DELETE') {
      return handleRevokeSource(id);
    }
  }

  return errorResponse('Not found', 404);
});
