#!/usr/bin/env npx tsx

/**
 * Migrate memory files to Supabase
 * 
 * Usage: 
 *   MEMORY_DIR=/path/to/memory npx tsx migrate-memory-to-supabase.ts
 *   
 * Environment variables:
 *   SUPABASE_URL - Supabase URL (default: http://127.0.0.1:54321)
 *   SUPABASE_KEY - Supabase service key (required, or run `npx supabase status` to get it)
 *   MEMORY_DIR - Path to memory folder with YYYY-MM-DD.md files
 *   MEMORY_FILE - Path to main MEMORY.md file (optional)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_KEY) {
  console.error('Error: SUPABASE_KEY environment variable required');
  console.error('Run `npx supabase status` to get your local secret key');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

interface MemoryEntry {
  content: string;
  summary?: string;
  memory_type: 'daily' | 'long_term' | 'thought' | 'decision' | 'task' | 'event';
  date?: string;
  tags?: string[];
  source_file?: string;
  source_line_start?: number;
  source_line_end?: number;
  metadata?: Record<string, any>;
}

async function parseAndInsertDailyLog(filePath: string) {
  const content = readFileSync(filePath, 'utf-8');
  const fileName = basename(filePath, '.md');
  
  // Extract date from filename (YYYY-MM-DD.md)
  const dateMatch = fileName.match(/^(\d{4}-\d{2}-\d{2})$/);
  const date = dateMatch ? dateMatch[1] : null;
  
  // Split by sections (## headers)
  const sections = content.split(/^## /m).filter(Boolean);
  
  const entries: MemoryEntry[] = [];
  
  for (const section of sections) {
    const lines = section.split('\n');
    const header = lines[0]?.trim();
    const body = lines.slice(1).join('\n').trim();
    
    if (!body) continue;
    
    // Extract time from header if present (e.g., "08:42 EST - Something")
    const timeMatch = header.match(/^(\d{2}:\d{2})/);
    
    // Determine type based on content
    let type: MemoryEntry['memory_type'] = 'daily';
    const lowerBody = body.toLowerCase();
    if (lowerBody.includes('decision:') || lowerBody.includes('decided')) type = 'decision';
    else if (lowerBody.includes('task:') || lowerBody.includes('todo')) type = 'task';
    else if (lowerBody.includes('event:') || header.includes('Meeting')) type = 'event';
    
    // Extract tags from **bold** words and #hashtags
    const tags = new Set<string>();
    const boldMatches = body.match(/\*\*([^*]+)\*\*/g) || [];
    boldMatches.forEach(m => tags.add(m.replace(/\*\*/g, '').toLowerCase()));
    const hashMatches = body.match(/#(\w+)/g) || [];
    hashMatches.forEach(m => tags.add(m.slice(1).toLowerCase()));
    
    entries.push({
      content: body,
      summary: header,
      memory_type: type,
      date: date || undefined,
      tags: Array.from(tags).slice(0, 10),
      source_file: filePath,
      metadata: {
        time: timeMatch?.[1],
        original_header: header
      }
    });
  }
  
  if (entries.length > 0) {
    const { error } = await supabase.from('memories').insert(entries);
    if (error) {
      console.error(`Error inserting from ${filePath}:`, error.message);
    } else {
      console.log(`✓ Inserted ${entries.length} entries from ${fileName}`);
    }
  }
  
  return entries.length;
}

async function parseLongTermMemory(filePath: string) {
  const content = readFileSync(filePath, 'utf-8');
  
  // Split by ## headers or treat as one entry
  const sections = content.split(/^## /m).filter(Boolean);
  
  const entries: MemoryEntry[] = [];
  
  for (const section of sections) {
    const lines = section.split('\n');
    const header = lines[0]?.trim();
    const body = lines.slice(1).join('\n').trim();
    
    if (!body || body.length < 20) continue;
    
    entries.push({
      content: body,
      summary: header,
      memory_type: 'long_term',
      source_file: filePath,
      tags: ['long_term'],
      metadata: { original_header: header }
    });
  }
  
  if (entries.length > 0) {
    const { error } = await supabase.from('memories').insert(entries);
    if (error) {
      console.error(`Error inserting MEMORY.md:`, error.message);
    } else {
      console.log(`✓ Inserted ${entries.length} long-term entries`);
    }
  }
  
  return entries.length;
}

async function main() {
  console.log('🧠 Memory Migration to Supabase\n');
  
  const memoryDir = process.env.MEMORY_DIR;
  const mainMemory = process.env.MEMORY_FILE;
  
  if (!memoryDir && !mainMemory) {
    console.error('Error: Set MEMORY_DIR and/or MEMORY_FILE environment variables');
    console.error('Example: MEMORY_DIR=./memory SUPABASE_KEY=xxx npx tsx migrate-memory-to-supabase.ts');
    process.exit(1);
  }
  
  let total = 0;
  
  // Migrate MEMORY.md
  if (mainMemory && existsSync(mainMemory)) {
    total += await parseLongTermMemory(mainMemory);
  }
  
  // Migrate daily logs
  if (memoryDir && existsSync(memoryDir)) {
    const files = readdirSync(memoryDir)
      .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
      .sort();
    
    for (const file of files) {
      total += await parseAndInsertDailyLog(join(memoryDir, file));
    }
  }
  
  console.log(`\n✨ Total: ${total} memory entries migrated`);
  
  // Test query
  console.log('\n📊 Testing queries...');
  
  const { data: recent } = await supabase
    .from('memories')
    .select('summary, memory_type, date')
    .order('created_at', { ascending: false })
    .limit(5);
  
  if (recent) {
    console.log('\nRecent entries:');
    recent.forEach(r => console.log(`  - [${r.memory_type}] ${r.summary?.slice(0, 50)}...`));
  }
}

main().catch(console.error);
