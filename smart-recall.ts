#!/usr/bin/env npx tsx

/**
 * Smart Recall - Context-aware memory retrieval
 * 
 * Solves: "I recorded it but didn't read it"
 * 
 * Features:
 * - Suggests relevant memories based on current topic
 * - Pre-loads context before compression hits
 * - Prioritizes recent + high-importance memories
 * - Compact output to minimize token usage
 * 
 * Usage:
 *   # Get relevant memories for current context
 *   npx tsx smart-recall.ts recall "current topic or question"
 *   
 *   # Quick context dump (for session start)
 *   npx tsx smart-recall.ts bootstrap
 *   
 *   # Emergency save before compression
 *   npx tsx smart-recall.ts emergency-save "quick notes about current state"
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_KEY) {
  console.error('Error: SUPABASE_KEY required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function recall(topic: string, maxTokens: number = 1000) {
  // Search for relevant memories
  const { data: relevant, error: e1 } = await supabase
    .from('memories')
    .select('summary, content, memory_type, date, tags, metadata')
    .textSearch('fts', topic.split(' ').join(' | '))
    .order('created_at', { ascending: false })
    .limit(20);
  
  // Also get recent critical items
  const { data: critical } = await supabase
    .from('memories')
    .select('summary, content, memory_type, date')
    .in('memory_type', ['decision', 'task'])
    .order('created_at', { ascending: false })
    .limit(10);
  
  // Combine and dedupe
  const all = [...(relevant || []), ...(critical || [])];
  const seen = new Set<string>();
  const unique = all.filter(m => {
    const key = m.content.slice(0, 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  
  // Format compactly
  console.log(`\n🧠 RECALL: "${topic}"\n`);
  console.log('---');
  
  let charCount = 0;
  const maxChars = maxTokens * 4; // rough estimate
  
  for (const m of unique.slice(0, 15)) {
    const icon = m.memory_type === 'decision' ? '🔴' : m.memory_type === 'task' ? '🟡' : '•';
    const date = m.date || '';
    const line = `${icon} [${date}] ${m.summary || m.content.slice(0, 80)}`;
    
    if (charCount + line.length > maxChars) break;
    
    console.log(line);
    charCount += line.length;
  }
  
  console.log('---');
  console.log(`(${unique.length} memories found, showing top ${Math.min(15, unique.length)})`);
}

async function bootstrap() {
  console.log('\n🚀 SESSION BOOTSTRAP - Loading essential context\n');
  console.log('='.repeat(50));
  
  // 1. Critical decisions (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  
  const { data: decisions } = await supabase
    .from('memories')
    .select('summary, date')
    .eq('memory_type', 'decision')
    .gte('date', weekAgo)
    .order('created_at', { ascending: false })
    .limit(5);
  
  if (decisions?.length) {
    console.log('\n🔴 RECENT DECISIONS:');
    decisions.forEach(d => console.log(`  • [${d.date}] ${d.summary}`));
  }
  
  // 2. Active tasks
  const { data: tasks } = await supabase
    .from('memories')
    .select('summary, date')
    .eq('memory_type', 'task')
    .gte('date', weekAgo)
    .order('created_at', { ascending: false })
    .limit(5);
  
  if (tasks?.length) {
    console.log('\n🟡 ACTIVE TASKS:');
    tasks.forEach(t => console.log(`  • [${t.date}] ${t.summary}`));
  }
  
  // 3. Today's conversation summary
  const today = new Date().toISOString().split('T')[0];
  const { data: todayConvo } = await supabase
    .from('memories')
    .select('summary, metadata')
    .contains('tags', ['conversation'])
    .eq('date', today)
    .order('created_at', { ascending: false })
    .limit(10);
  
  if (todayConvo?.length) {
    console.log('\n💬 TODAY\'S CONVERSATION (recent):');
    todayConvo.slice(0, 5).reverse().forEach(c => {
      const role = c.metadata?.role || '?';
      console.log(`  ${role === 'user' ? '👤' : '🤖'} ${c.summary?.slice(0, 60)}...`);
    });
  }
  
  // 4. Long-term important
  const { data: longterm } = await supabase
    .from('memories')
    .select('summary')
    .eq('memory_type', 'long_term')
    .order('created_at', { ascending: false })
    .limit(3);
  
  if (longterm?.length) {
    console.log('\n📌 LONG-TERM NOTES:');
    longterm.forEach(l => console.log(`  • ${l.summary?.slice(0, 80)}`));
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('Bootstrap complete. Ready to continue.\n');
}

async function emergencySave(notes: string) {
  const timestamp = new Date().toISOString();
  
  const { error } = await supabase.from('memories').insert({
    content: `EMERGENCY SAVE @ ${timestamp}\n\n${notes}`,
    summary: `🚨 Emergency save: ${notes.slice(0, 80)}`,
    memory_type: 'decision',
    date: new Date().toISOString().split('T')[0],
    tags: ['emergency', 'critical', 'pre-compression'],
    metadata: {
      type: 'emergency_save',
      timestamp
    }
  });
  
  if (error) {
    console.error('FAILED TO SAVE:', error.message);
    process.exit(1);
  }
  
  console.log('🚨 EMERGENCY SAVE COMPLETE');
  console.log(`Saved: "${notes.slice(0, 100)}..."`);
  console.log('This will be flagged as critical and appear in bootstrap.');
}

async function getStats() {
  const { data } = await supabase
    .from('memories')
    .select('memory_type, date, tags');
  
  const stats = {
    total: data?.length || 0,
    byType: {} as Record<string, number>,
    conversations: 0,
    critical: 0,
    thisWeek: 0
  };
  
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
  data?.forEach(m => {
    stats.byType[m.memory_type] = (stats.byType[m.memory_type] || 0) + 1;
    if (m.tags?.includes('conversation')) stats.conversations++;
    if (m.memory_type === 'decision' || m.memory_type === 'task') stats.critical++;
    if (m.date && new Date(m.date) >= weekAgo) stats.thisWeek++;
  });
  
  console.log('\n📊 MEMORY STATS');
  console.log('='.repeat(30));
  console.log(`Total memories: ${stats.total}`);
  console.log(`This week: ${stats.thisWeek}`);
  console.log(`Conversations logged: ${stats.conversations}`);
  console.log(`Critical items: ${stats.critical}`);
  console.log(`\nBy type:`, stats.byType);
}

// CLI
const [,, command, ...args] = process.argv;

switch (command) {
  case 'recall':
    recall(args.join(' '));
    break;
  
  case 'bootstrap':
    bootstrap();
    break;
  
  case 'emergency-save':
  case 'save':
    emergencySave(args.join(' '));
    break;
  
  case 'stats':
    getStats();
    break;
  
  default:
    console.log(`
Smart Recall - Context-aware memory retrieval

Commands:
  recall <topic>              Find relevant memories for a topic
  bootstrap                   Load essential context for new session
  emergency-save <notes>      Quick save before context compression
  stats                       Memory statistics

Examples:
  npx tsx smart-recall.ts recall "stock trading"
  npx tsx smart-recall.ts bootstrap
  npx tsx smart-recall.ts emergency-save "Working on ReviewPal, needs v1.4 with line links"
    `);
}
