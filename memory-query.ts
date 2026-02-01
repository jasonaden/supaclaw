#!/usr/bin/env npx tsx

/**
 * Query memory from Supabase
 * 
 * Usage: 
 *   npx tsx memory-query.ts search "keyword"
 *   npx tsx memory-query.ts recent 5
 *   npx tsx memory-query.ts date 2026-01-31
 *   npx tsx memory-query.ts add "New memory entry" --type thought
 *   npx tsx memory-query.ts stats
 *   
 * Environment variables:
 *   SUPABASE_URL - Supabase URL (default: http://127.0.0.1:54321)
 *   SUPABASE_KEY - Supabase service key (required)
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_KEY) {
  console.error('Error: SUPABASE_KEY environment variable required');
  console.error('Run `npx supabase status` to get your local secret key');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const [,, command, ...args] = process.argv;

async function search(query: string) {
  const { data, error } = await supabase
    .from('memories')
    .select('summary, content, date, memory_type')
    .textSearch('fts', query.split(' ').join(' & '))
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return console.error(error.message);
  
  console.log(`\n🔍 Search: "${query}" (${data.length} results)\n`);
  data.forEach((m, i) => {
    console.log(`${i + 1}. [${m.memory_type}${m.date ? ` ${m.date}` : ''}] ${m.summary}`);
    console.log(`   ${m.content.slice(0, 150).replace(/\n/g, ' ')}...\n`);
  });
}

async function recent(limit = 5) {
  const { data, error } = await supabase
    .from('memories')
    .select('summary, content, date, memory_type, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return console.error(error.message);
  
  console.log(`\n📜 Recent ${limit} memories:\n`);
  data.forEach((m, i) => {
    console.log(`${i + 1}. [${m.memory_type}${m.date ? ` ${m.date}` : ''}] ${m.summary}`);
  });
}

async function byDate(date: string) {
  const { data, error } = await supabase
    .from('memories')
    .select('summary, content, memory_type')
    .eq('date', date)
    .order('created_at', { ascending: true });

  if (error) return console.error(error.message);
  
  console.log(`\n📅 Memories from ${date} (${data.length}):\n`);
  data.forEach((m, i) => {
    console.log(`${i + 1}. [${m.memory_type}] ${m.summary}`);
  });
}

async function add(content: string, type = 'thought') {
  const today = new Date().toISOString().split('T')[0];
  
  const { error } = await supabase.from('memories').insert({
    content,
    summary: content.split('\n')[0].slice(0, 100),
    memory_type: type,
    date: today,
    tags: ['manual'],
    metadata: { added_via: 'cli' }
  });

  if (error) return console.error(error.message);
  console.log(`✓ Added ${type} memory`);
}

async function stats() {
  const { data } = await supabase.from('memories').select('memory_type, date');
  
  const byType: Record<string, number> = {};
  const byDate: Record<string, number> = {};
  
  data?.forEach(m => {
    byType[m.memory_type] = (byType[m.memory_type] || 0) + 1;
    if (m.date) byDate[m.date] = (byDate[m.date] || 0) + 1;
  });
  
  console.log('\n📊 Memory Stats\n');
  console.log('By Type:', byType);
  console.log('By Date:', byDate);
  console.log(`Total: ${data?.length} entries`);
}

switch (command) {
  case 'search':
    search(args.join(' '));
    break;
  case 'recent':
    recent(parseInt(args[0]) || 5);
    break;
  case 'date':
    byDate(args[0]);
    break;
  case 'add':
    const typeIdx = args.indexOf('--type');
    const type = typeIdx >= 0 ? args[typeIdx + 1] : 'thought';
    const content = args.filter((_, i) => i !== typeIdx && i !== typeIdx + 1).join(' ');
    add(content, type);
    break;
  case 'stats':
    stats();
    break;
  default:
    console.log(`
Memory Query CLI

Commands:
  search <query>     Full-text search
  recent [n]         Show n recent entries (default 5)
  date <YYYY-MM-DD>  Show entries from date
  add <text> [--type <type>]  Add new entry
  stats              Show statistics

Types: daily, long_term, thought, decision, task, event

Environment:
  SUPABASE_KEY       Required - your Supabase service key
  SUPABASE_URL       Optional - defaults to http://127.0.0.1:54321
    `);
}
