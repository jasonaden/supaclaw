#!/usr/bin/env npx tsx

/**
 * Conversation Logger - Auto-save conversations to Supaclaw
 * 
 * Features:
 * - Saves every conversation turn
 * - Auto-summarizes when context gets long
 * - Importance scoring (critical info gets tagged)
 * - Fast retrieval for context recovery
 * 
 * Usage:
 *   # Log a conversation turn
 *   npx tsx conversation-logger.ts log --role user --content "message here"
 *   npx tsx conversation-logger.ts log --role assistant --content "response here"
 *   
 *   # Get recent conversation context
 *   npx tsx conversation-logger.ts context --turns 10
 *   
 *   # Search conversations
 *   npx tsx conversation-logger.ts search "keyword"
 *   
 *   # Summarize and compress old conversations
 *   npx tsx conversation-logger.ts compress --older-than 24h
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_KEY) {
  console.error('Error: SUPABASE_KEY required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Importance keywords - messages containing these get flagged
const CRITICAL_KEYWORDS = [
  'remember', 'don\'t forget', 'important', 'critical', 'always', 'never',
  'password', 'secret', 'key', 'token', 'deadline', 'urgent', 'asap',
  'decision', 'agreed', 'confirmed', 'approved', 'rejected'
];

const ACTION_KEYWORDS = [
  'todo', 'task', 'buy', 'sell', 'send', 'email', 'call', 'meet',
  'create', 'build', 'fix', 'update', 'delete', 'deploy', 'push'
];

function detectImportance(content: string): { level: 'critical' | 'action' | 'normal', tags: string[] } {
  const lower = content.toLowerCase();
  const tags: string[] = [];
  
  for (const kw of CRITICAL_KEYWORDS) {
    if (lower.includes(kw)) {
      tags.push(kw);
    }
  }
  if (tags.length > 0) return { level: 'critical', tags };
  
  for (const kw of ACTION_KEYWORDS) {
    if (lower.includes(kw)) {
      tags.push(kw);
    }
  }
  if (tags.length > 0) return { level: 'action', tags };
  
  return { level: 'normal', tags: [] };
}

async function logConversation(role: 'user' | 'assistant', content: string, sessionId?: string) {
  const { level, tags } = detectImportance(content);
  const today = new Date().toISOString().split('T')[0];
  
  const { error } = await supabase.from('memories').insert({
    content,
    summary: `[${role}] ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`,
    memory_type: level === 'critical' ? 'decision' : level === 'action' ? 'task' : 'daily',
    date: today,
    tags: ['conversation', role, ...tags],
    metadata: {
      role,
      session_id: sessionId || 'default',
      importance: level,
      timestamp: new Date().toISOString()
    }
  });
  
  if (error) {
    console.error('Error logging:', error.message);
    return false;
  }
  
  const icon = level === 'critical' ? '🔴' : level === 'action' ? '🟡' : '✓';
  console.log(`${icon} Logged [${role}] (${level})`);
  return true;
}

async function getContext(turns: number = 10) {
  const { data, error } = await supabase
    .from('memories')
    .select('content, metadata, created_at')
    .contains('tags', ['conversation'])
    .order('created_at', { ascending: false })
    .limit(turns);
  
  if (error) {
    console.error(error.message);
    return;
  }
  
  console.log(`\n📜 Last ${turns} conversation turns:\n`);
  
  // Reverse to show oldest first
  data.reverse().forEach((m, i) => {
    const role = m.metadata?.role || 'unknown';
    const time = new Date(m.created_at).toLocaleTimeString();
    console.log(`[${time}] ${role.toUpperCase()}: ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}\n`);
  });
}

async function searchConversations(query: string) {
  const { data, error } = await supabase
    .from('memories')
    .select('content, metadata, created_at, tags')
    .contains('tags', ['conversation'])
    .textSearch('fts', query.split(' ').join(' & '))
    .order('created_at', { ascending: false })
    .limit(20);
  
  if (error) {
    console.error(error.message);
    return;
  }
  
  console.log(`\n🔍 Found ${data.length} matches for "${query}":\n`);
  
  data.forEach((m, i) => {
    const role = m.metadata?.role || '?';
    const date = new Date(m.created_at).toLocaleDateString();
    const importance = m.metadata?.importance || 'normal';
    const icon = importance === 'critical' ? '🔴' : importance === 'action' ? '🟡' : '⚪';
    
    console.log(`${i + 1}. ${icon} [${date}] ${role}: ${m.content.slice(0, 150)}...\n`);
  });
}

async function getCriticalMemories() {
  const { data, error } = await supabase
    .from('memories')
    .select('content, metadata, created_at, tags')
    .contains('tags', ['conversation'])
    .or('memory_type.eq.decision,memory_type.eq.task')
    .order('created_at', { ascending: false })
    .limit(50);
  
  if (error) {
    console.error(error.message);
    return;
  }
  
  console.log(`\n🔴 Critical & Action items (${data.length}):\n`);
  
  data.forEach((m, i) => {
    const date = new Date(m.created_at).toLocaleDateString();
    const tags = m.tags?.filter((t: string) => !['conversation', 'user', 'assistant'].includes(t)).join(', ');
    console.log(`${i + 1}. [${date}] ${m.content.slice(0, 100)}...`);
    if (tags) console.log(`   Tags: ${tags}`);
    console.log();
  });
}

async function getTodaySummary() {
  const today = new Date().toISOString().split('T')[0];
  
  const { data, error } = await supabase
    .from('memories')
    .select('content, metadata')
    .contains('tags', ['conversation'])
    .eq('date', today)
    .order('created_at', { ascending: true });
  
  if (error) {
    console.error(error.message);
    return;
  }
  
  const userMsgs = data.filter(m => m.metadata?.role === 'user').length;
  const assistantMsgs = data.filter(m => m.metadata?.role === 'assistant').length;
  const critical = data.filter(m => m.metadata?.importance === 'critical').length;
  const actions = data.filter(m => m.metadata?.importance === 'action').length;
  
  console.log(`\n📊 Today's Summary (${today}):`);
  console.log(`   User messages: ${userMsgs}`);
  console.log(`   Assistant messages: ${assistantMsgs}`);
  console.log(`   Critical items: ${critical}`);
  console.log(`   Action items: ${actions}`);
  console.log(`   Total turns: ${data.length}`);
}

// CLI
const [,, command, ...args] = process.argv;

switch (command) {
  case 'log': {
    const roleIdx = args.indexOf('--role');
    const contentIdx = args.indexOf('--content');
    const sessionIdx = args.indexOf('--session');
    
    const role = roleIdx >= 0 ? args[roleIdx + 1] as 'user' | 'assistant' : 'user';
    const content = contentIdx >= 0 ? args.slice(contentIdx + 1).join(' ') : args.join(' ');
    const session = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;
    
    if (!content) {
      console.error('Usage: conversation-logger.ts log --role user --content "message"');
      process.exit(1);
    }
    
    logConversation(role, content, session);
    break;
  }
  
  case 'context': {
    const turnsIdx = args.indexOf('--turns');
    const turns = turnsIdx >= 0 ? parseInt(args[turnsIdx + 1]) : 10;
    getContext(turns);
    break;
  }
  
  case 'search':
    searchConversations(args.join(' '));
    break;
  
  case 'critical':
    getCriticalMemories();
    break;
  
  case 'today':
    getTodaySummary();
    break;
  
  default:
    console.log(`
Conversation Logger - Never forget a conversation

Commands:
  log --role <user|assistant> --content "message"   Log a conversation turn
  context --turns <n>                               Get last n turns (default 10)
  search <query>                                    Search conversations
  critical                                          Show critical & action items
  today                                             Today's summary

Auto-tagging:
  🔴 Critical: remember, important, decision, deadline, etc.
  🟡 Action: todo, task, buy, sell, create, etc.
  ⚪ Normal: everything else
    `);
}
