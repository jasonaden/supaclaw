#!/usr/bin/env npx tsx

/**
 * AUTO-LOG - Log a message to Supaclaw
 * 
 * Usage:
 *   auto-log user "message content"
 *   auto-log assistant "response content"
 *   auto-log status  (show stats)
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz';
const AGENT_ID = 'hans-assistant';
const USER_ID = 'han';
const CHANNEL = 'telegram';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function getOrCreateSession() {
  // Get today's session or create one
  const today = new Date().toISOString().split('T')[0];
  
  const { data: sessions } = await supabase
    .from('sessions')
    .select('id')
    .eq('agent_id', AGENT_ID)
    .gte('started_at', today)
    .order('started_at', { ascending: false })
    .limit(1);
  
  if (sessions && sessions.length > 0) {
    return sessions[0].id;
  }
  
  // Create new session for today
  const { data, error } = await supabase
    .from('sessions')
    .insert({
      agent_id: AGENT_ID,
      user_id: USER_ID,
      channel: CHANNEL,
      metadata: { date: today }
    })
    .select()
    .single();
  
  if (error) throw error;
  return data.id;
}

async function logMessage(role: 'user' | 'assistant', content: string) {
  const sessionId = await getOrCreateSession();
  
  const { error } = await supabase.from('messages').insert({
    session_id: sessionId,
    role,
    content,
    metadata: { logged_at: new Date().toISOString() }
  });
  
  if (error) {
    console.error('❌ Failed:', error.message);
    return false;
  }
  
  console.log(`✓ [${role}] logged`);
  return true;
}

async function showStatus() {
  const today = new Date().toISOString().split('T')[0];
  
  const { data: sessions } = await supabase
    .from('sessions')
    .select('id')
    .eq('agent_id', AGENT_ID);
  
  const { data: messages } = await supabase
    .from('messages')
    .select('role, created_at');
  
  const { data: memories } = await supabase
    .from('memories')
    .select('category');
  
  const todayMessages = messages?.filter(m => 
    m.created_at?.startsWith(today)
  ) || [];
  
  console.log('\n📊 SUPACLAW STATUS');
  console.log('==================');
  console.log(`Sessions: ${sessions?.length || 0}`);
  console.log(`Total messages: ${messages?.length || 0}`);
  console.log(`Today's messages: ${todayMessages.length}`);
  console.log(`  - User: ${todayMessages.filter(m => m.role === 'user').length}`);
  console.log(`  - Assistant: ${todayMessages.filter(m => m.role === 'assistant').length}`);
  console.log(`Memories: ${memories?.length || 0}`);
}

// CLI
const [,, command, ...args] = process.argv;

if (command === 'user' || command === 'assistant') {
  const content = args.join(' ');
  if (!content) {
    console.error('Usage: auto-log <user|assistant> "message"');
    process.exit(1);
  }
  logMessage(command as 'user' | 'assistant', content);
} else if (command === 'status') {
  showStatus();
} else {
  console.log(`
Auto-Log - Quick message logging to Supaclaw

Usage:
  npx tsx scripts/auto-log.ts user "what the user said"
  npx tsx scripts/auto-log.ts assistant "what I responded"
  npx tsx scripts/auto-log.ts status

Alias (add to shell):
  alias log='npx tsx ~/clawd/scripts/auto-log.ts'
  `);
}
