#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createInterface } from 'readline';

const CONFIG_FILE = '.openclaw-memory.json';

interface Config {
  supabaseUrl: string;
  supabaseKey: string;
  agentId: string;
}

// ============ CLI HELPERS ============

function loadConfig(): Config | null {
  const configPath = join(process.cwd(), CONFIG_FILE);
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.error(`❌ Failed to read ${CONFIG_FILE}:`, err);
    process.exit(1);
  }
}

function saveConfig(config: Config): void {
  const configPath = join(process.cwd(), CONFIG_FILE);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`✅ Saved config to ${CONFIG_FILE}`);
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function getSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseKey);
}

// ============ COMMANDS ============

async function cmdInit(): Promise<void> {
  console.log('🚀 OpenClaw Memory - Setup\n');

  // Check if config already exists
  if (existsSync(join(process.cwd(), CONFIG_FILE))) {
    const overwrite = await prompt('⚠️  Config already exists. Overwrite? (y/N): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  console.log('Enter your Supabase project details:\n');

  const supabaseUrl = await prompt('Supabase URL: ');
  const supabaseKey = await prompt('Supabase anon/service key: ');
  const agentId = await prompt('Agent ID (e.g., "hans-assistant"): ');

  if (!supabaseUrl || !supabaseKey || !agentId) {
    console.error('❌ All fields are required.');
    process.exit(1);
  }

  // Validate URL
  try {
    new URL(supabaseUrl);
  } catch {
    console.error('❌ Invalid Supabase URL');
    process.exit(1);
  }

  const config: Config = {
    supabaseUrl,
    supabaseKey,
    agentId
  };

  saveConfig(config);

  console.log('\n✅ Configuration saved!');
  console.log('\nNext steps:');
  console.log('  1. Run migrations: npx openclaw-memory migrate');
  console.log('  2. Test connection: npx openclaw-memory test');
  console.log('  3. Check status:    npx openclaw-memory status');
}

async function cmdMigrate(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  console.log('🔄 Database Migration\n');

  // Read migration file
  const migrationPath = join(__dirname, '../migrations/001_initial.sql');
  if (!existsSync(migrationPath)) {
    console.error('❌ Migration file not found:', migrationPath);
    process.exit(1);
  }

  const sql = readFileSync(migrationPath, 'utf-8');

  console.log('To set up your database:\n');
  console.log('1. Go to your Supabase dashboard');
  console.log(`   ${config.supabaseUrl.replace('/rest/v1', '')}`);
  console.log('2. Navigate to: SQL Editor → New Query');
  console.log('3. Copy the SQL from:');
  console.log(`   ${migrationPath}`);
  console.log('4. Paste and run the query\n');

  console.log('Or run this SQL directly:\n');
  console.log('─'.repeat(60));
  console.log(sql);
  console.log('─'.repeat(60));

  console.log('\n✅ After running the migration, verify with:');
  console.log('   npx openclaw-memory test');
  console.log('   npx openclaw-memory status');
}

async function cmdTest(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  console.log('🔌 Testing Supabase Connection...\n');

  const supabase = getSupabaseClient(config);

  try {
    // Test basic connectivity
    const { error: sessionsError } = await supabase
      .from('sessions')
      .select('id')
      .limit(1);

    if (sessionsError) {
      if (sessionsError.code === '42P01') {
        console.error('❌ Tables not found. Run migrations first:');
        console.error('   npx openclaw-memory migrate');
      } else {
        console.error('❌ Connection failed:', sessionsError.message);
      }
      process.exit(1);
    }

    console.log('✅ Connection successful!');
    console.log(`   Agent ID: ${config.agentId}`);
    console.log(`   Database: ${config.supabaseUrl}\n`);

    // Test each table
    const tables = ['sessions', 'messages', 'memories', 'entities', 'tasks', 'learnings'];
    let allTablesExist = true;

    for (const table of tables) {
      const { error } = await supabase
        .from(table)
        .select('id')
        .limit(1);

      if (error) {
        console.log(`❌ Table "${table}" not found`);
        allTablesExist = false;
      } else {
        console.log(`✅ Table "${table}" accessible`);
      }
    }

    if (!allTablesExist) {
      console.log('\n⚠️  Some tables are missing. Run migrations:');
      console.log('   npx openclaw-memory migrate');
      process.exit(1);
    }

    console.log('\n🎉 All systems operational!');
  } catch (err) {
    console.error('❌ Unexpected error:', err);
    process.exit(1);
  }
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  console.log('📊 OpenClaw Memory - Status\n');

  const supabase = getSupabaseClient(config);

  try {
    const tables = ['sessions', 'messages', 'memories', 'entities', 'tasks', 'learnings'];
    const stats: Record<string, number> = {};

    for (const table of tables) {
      const { count, error } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', config.agentId);

      if (error) {
        if (error.code === '42P01') {
          stats[table] = -1;
        } else {
          console.error(`❌ Error checking ${table}:`, error.message);
          stats[table] = -1;
        }
      } else {
        stats[table] = count || 0;
      }
    }

    console.log(`Agent ID: ${config.agentId}`);
    console.log(`Supabase: ${config.supabaseUrl}\n`);

    console.log('Database Statistics:');
    for (const [table, count] of Object.entries(stats)) {
      if (count === -1) {
        console.log(`  ${table.padEnd(12)} ⚠️  not found`);
      } else {
        console.log(`  ${table.padEnd(12)} ${count.toString().padStart(6)} records`);
      }
    }

    // Check for active sessions
    const { data: activeSessions } = await supabase
      .from('sessions')
      .select('id, started_at, channel')
      .eq('agent_id', config.agentId)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(5);

    if (activeSessions && activeSessions.length > 0) {
      console.log(`\n💬 Active Sessions: ${activeSessions.length}`);
      activeSessions.forEach(s => {
        const date = new Date(s.started_at).toLocaleString();
        console.log(`  - ${s.id.slice(0, 8)}... (${s.channel || 'unknown'}) started ${date}`);
      });
    } else {
      console.log('\n💬 No active sessions');
    }

  } catch (err) {
    console.error('❌ Failed to fetch status:', err);
    process.exit(1);
  }
}

async function cmdSearch(query: string, options: { 
  limit?: number;
  mode?: 'keyword' | 'semantic' | 'hybrid';
  minSimilarity?: number;
}): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  if (!query || query.trim().length === 0) {
    console.error('❌ Search query is required');
    process.exit(1);
  }

  const limit = options.limit || 10;
  const mode = options.mode || 'keyword';
  const modeEmoji = {
    keyword: '📝',
    semantic: '🧠',
    hybrid: '⚡'
  };

  console.log(`${modeEmoji[mode]} Searching memories (${mode} mode): "${query}"\n`);

  const supabase = getSupabaseClient(config);

  try {
    let data: any[] = [];

    if (mode === 'keyword') {
      // Traditional keyword search
      const { data: results, error } = await supabase
        .from('memories')
        .select('*')
        .eq('agent_id', config.agentId)
        .or(`content.ilike.%${query}%,category.ilike.%${query}%`)
        .order('importance', { ascending: false })
        .limit(limit);

      if (error) throw error;
      data = results || [];
    } else if (mode === 'semantic') {
      // Vector similarity search (requires OpenAI API key)
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        console.error('❌ OPENAI_API_KEY environment variable required for semantic search');
        process.exit(1);
      }

      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey: openaiKey });
      
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: query,
      });
      
      const queryEmbedding = embeddingResponse.data[0].embedding;

      const { data: results, error } = await supabase.rpc('match_memories', {
        query_embedding: queryEmbedding,
        match_threshold: options.minSimilarity || 0.7,
        match_count: limit,
        p_agent_id: config.agentId
      });

      if (error) throw error;
      data = results || [];
    } else if (mode === 'hybrid') {
      // Hybrid search: vector + keyword
      const openaiKey = process.env.OPENAI_API_KEY;
      if (!openaiKey) {
        console.error('❌ OPENAI_API_KEY environment variable required for hybrid search');
        process.exit(1);
      }

      const OpenAI = (await import('openai')).default;
      const openai = new OpenAI({ apiKey: openaiKey });
      
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: query,
      });
      
      const queryEmbedding = embeddingResponse.data[0].embedding;

      const { data: results, error } = await supabase.rpc('hybrid_search_memories', {
        query_embedding: queryEmbedding,
        query_text: query,
        vector_weight: 0.7,
        keyword_weight: 0.3,
        match_count: limit,
        p_agent_id: config.agentId
      });

      if (error) throw error;
      data = results || [];
    }

    if (!data || data.length === 0) {
      console.log('No memories found.');
      return;
    }

    console.log(`Found ${data.length} memories:\n`);
    data.forEach((mem: any, idx: number) => {
      const scoreLabel = mem.similarity ? `similarity: ${mem.similarity.toFixed(3)}` :
                        mem.score ? `score: ${mem.score.toFixed(3)}` :
                        `importance: ${mem.importance}`;
      
      console.log(`${idx + 1}. [${mem.category || 'none'}] (${scoreLabel})`);
      console.log(`   ${mem.content}`);
      if (mem.metadata && Object.keys(mem.metadata).length > 0) {
        console.log(`   Metadata: ${JSON.stringify(mem.metadata)}`);
      }
      console.log(`   Created: ${new Date(mem.created_at).toLocaleString()}\n`);
    });

  } catch (err) {
    console.error('❌ Search error:', err);
    process.exit(1);
  }
}

async function cmdSessions(options: { limit?: number; active?: boolean }): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  console.log('📋 Sessions\n');

  const supabase = getSupabaseClient(config);
  const limit = options.limit || 20;

  try {
    let query = supabase
      .from('sessions')
      .select('*')
      .eq('agent_id', config.agentId);

    if (options.active) {
      query = query.is('ended_at', null);
    }

    const { data, error } = await query
      .order('started_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('❌ Failed to fetch sessions:', error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) {
      console.log('No sessions found.');
      return;
    }

    console.log(`Found ${data.length} sessions:\n`);
    data.forEach((session, idx) => {
      const started = new Date(session.started_at).toLocaleString();
      const ended = session.ended_at ? new Date(session.ended_at).toLocaleString() : 'active';
      const status = session.ended_at ? '✓' : '●';
      
      console.log(`${status} ${session.id.slice(0, 8)}...`);
      console.log(`  User: ${session.user_id || 'unknown'}`);
      console.log(`  Channel: ${session.channel || 'unknown'}`);
      console.log(`  Started: ${started}`);
      console.log(`  Ended: ${ended}`);
      if (session.summary) {
        console.log(`  Summary: ${session.summary.slice(0, 100)}${session.summary.length > 100 ? '...' : ''}`);
      }
      console.log('');
    });

  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
}

async function cmdExport(outputPath: string): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  console.log('📤 Exporting memories to markdown...\n');

  const supabase = getSupabaseClient(config);

  try {
    // Fetch all memories
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .eq('agent_id', config.agentId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('❌ Export failed:', error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) {
      console.log('No memories to export.');
      return;
    }

    // Build markdown
    let markdown = `# OpenClaw Memory Export\n\n`;
    markdown += `**Agent:** ${config.agentId}\n`;
    markdown += `**Exported:** ${new Date().toISOString()}\n`;
    markdown += `**Total Memories:** ${data.length}\n\n`;
    markdown += `---\n\n`;

    // Group by category
    const byCategory: Record<string, typeof data> = {};
    data.forEach(mem => {
      const cat = mem.category || 'uncategorized';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(mem);
    });

    for (const [category, memories] of Object.entries(byCategory)) {
      markdown += `## ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n`;
      
      memories.forEach(mem => {
        markdown += `### ${new Date(mem.created_at).toISOString().split('T')[0]}\n\n`;
        markdown += `**Importance:** ${mem.importance}\n\n`;
        markdown += `${mem.content}\n\n`;
        if (mem.metadata) {
          markdown += `*Metadata:* ${JSON.stringify(mem.metadata)}\n\n`;
        }
        markdown += `---\n\n`;
      });
    }

    // Write to file
    const resolvedPath = outputPath || 'openclaw-memory-export.md';
    writeFileSync(resolvedPath, markdown, 'utf-8');

    console.log(`✅ Exported ${data.length} memories to: ${resolvedPath}`);

  } catch (err) {
    console.error('❌ Export error:', err);
    process.exit(1);
  }
}

async function cmdImport(inputPath: string): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  console.log(`📥 Importing memories from: ${inputPath}\n`);

  if (!existsSync(inputPath)) {
    console.error('❌ File not found:', inputPath);
    process.exit(1);
  }

  try {
    const content = readFileSync(inputPath, 'utf-8');
    
    // Simple parser: extract lines that look like memories
    // Format: "- Memory text" or "* Memory text"
    const lines = content.split('\n');
    const memories: Array<{ content: string; category: string; importance: number }> = [];

    let currentCategory = 'imported';
    
    lines.forEach(line => {
      line = line.trim();
      
      // Detect category headers
      if (line.startsWith('## ')) {
        currentCategory = line.slice(3).toLowerCase().trim();
        return;
      }

      // Detect memory lines
      if (line.startsWith('- ') || line.startsWith('* ')) {
        const content = line.slice(2).trim();
        if (content.length > 0) {
          memories.push({
            content,
            category: currentCategory,
            importance: 0.5 // default
          });
        }
      }
    });

    if (memories.length === 0) {
      console.log('⚠️  No memories found in file. Expected format:');
      console.log('   ## Category Name');
      console.log('   - Memory item one');
      console.log('   - Memory item two');
      return;
    }

    console.log(`Found ${memories.length} memories to import.\n`);

    const supabase = getSupabaseClient(config);
    let imported = 0;

    for (const mem of memories) {
      const { error } = await supabase
        .from('memories')
        .insert({
          agent_id: config.agentId,
          content: mem.content,
          category: mem.category,
          importance: mem.importance
        });

      if (error) {
        console.error(`❌ Failed to import: ${mem.content.slice(0, 50)}...`);
        console.error(`   Error: ${error.message}`);
      } else {
        imported++;
      }
    }

    console.log(`\n✅ Successfully imported ${imported}/${memories.length} memories`);

  } catch (err) {
    console.error('❌ Import error:', err);
    process.exit(1);
  }
}

async function cmdDecay(options: { 
  olderThanDays: number; 
  decayRate: number; 
  minImportance: number;
}): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  try {
    const { OpenClawMemory } = await import('./index');
    const memory = new OpenClawMemory({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      agentId: config.agentId
    });

    console.log(`🔄 Applying importance decay to memories older than ${options.olderThanDays} days...`);
    const result = await memory.decayMemoryImportance(options);

    console.log(`\n✅ Decay complete:`);
    console.log(`   - Updated: ${result.updated} memories`);
    console.log(`   - Average decay: ${(result.avgDecay * 100).toFixed(2)}%`);
  } catch (err) {
    console.error('❌ Decay error:', err);
    process.exit(1);
  }
}

async function cmdConsolidate(options: {
  similarityThreshold: number;
  category?: string;
  limit: number;
}): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  try {
    const { OpenClawMemory } = await import('./index');
    const memory = new OpenClawMemory({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      agentId: config.agentId
    });

    console.log(`🔄 Consolidating similar memories (threshold: ${options.similarityThreshold})...`);
    const result = await memory.consolidateMemories(options);

    console.log(`\n✅ Consolidation complete:`);
    console.log(`   - Merged: ${result.merged} memories`);
    console.log(`   - Kept: ${result.kept} unique memories`);
  } catch (err) {
    console.error('❌ Consolidation error:', err);
    process.exit(1);
  }
}

async function cmdTag(memoryId: string, tags: string[]): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  try {
    const { OpenClawMemory } = await import('./index');
    const memory = new OpenClawMemory({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      agentId: config.agentId
    });

    const result = await memory.tagMemory(memoryId, tags);
    const allTags = result.metadata?.tags as string[] || [];

    console.log(`✅ Tagged memory ${memoryId}`);
    console.log(`   Tags: ${allTags.join(', ')}`);
  } catch (err) {
    console.error('❌ Tag error:', err);
    process.exit(1);
  }
}

async function cmdUntag(memoryId: string, tags: string[]): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  try {
    const { OpenClawMemory } = await import('./index');
    const memory = new OpenClawMemory({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      agentId: config.agentId
    });

    const result = await memory.untagMemory(memoryId, tags);
    const allTags = result.metadata?.tags as string[] || [];

    console.log(`✅ Removed tags from memory ${memoryId}`);
    console.log(`   Remaining tags: ${allTags.length > 0 ? allTags.join(', ') : 'none'}`);
  } catch (err) {
    console.error('❌ Untag error:', err);
    process.exit(1);
  }
}

async function cmdSearchTags(tags: string[], options: { 
  matchAll: boolean; 
  limit: number;
}): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  try {
    const { OpenClawMemory } = await import('./index');
    const memory = new OpenClawMemory({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      agentId: config.agentId
    });

    console.log(`🔍 Searching for memories with tags: ${tags.join(', ')} (${options.matchAll ? 'ALL' : 'ANY'})`);
    const results = await memory.searchMemoriesByTags(tags, options);

    if (results.length === 0) {
      console.log('   No matching memories found.');
      return;
    }

    console.log(`\nFound ${results.length} memories:\n`);
    results.forEach((mem, i) => {
      const memTags = mem.metadata?.tags as string[] || [];
      console.log(`${i + 1}. [${mem.category || 'uncategorized'}] ${mem.content.slice(0, 80)}...`);
      console.log(`   Tags: ${memTags.join(', ')}`);
      console.log(`   Importance: ${mem.importance}`);
      console.log();
    });
  } catch (err) {
    console.error('❌ Search error:', err);
    process.exit(1);
  }
}

async function cmdCleanup(options: {
  olderThanDays: number;
  action: 'archive' | 'delete';
  keepSummaries: boolean;
}): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  try {
    const { OpenClawMemory } = await import('./index');
    const memory = new OpenClawMemory({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      agentId: config.agentId
    });

    const actionWord = options.action === 'delete' ? 'Deleting' : 'Archiving';
    console.log(`🔄 ${actionWord} sessions older than ${options.olderThanDays} days...`);

    const result = await memory.cleanupOldSessions(options);
    const count = options.action === 'delete' ? result.deleted! : result.archived!;

    console.log(`\n✅ Cleanup complete: ${actionWord.toLowerCase()} ${count} sessions`);
  } catch (err) {
    console.error('❌ Cleanup error:', err);
    process.exit(1);
  }
}

async function cmdCleanupStats(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  try {
    const { OpenClawMemory } = await import('./index');
    const memory = new OpenClawMemory({
      supabaseUrl: config.supabaseUrl,
      supabaseKey: config.supabaseKey,
      agentId: config.agentId
    });

    console.log('📊 Gathering cleanup statistics...\n');
    const stats = await memory.getCleanupStats();

    console.log('Sessions:');
    console.log(`   Total: ${stats.totalSessions}`);
    console.log(`   Archived: ${stats.archivedSessions}`);
    console.log(`   Old (>90 days): ${stats.oldSessions}`);
    console.log();
    console.log('Messages:');
    console.log(`   Total: ${stats.totalMessages}`);
    console.log(`   Orphaned: ${stats.orphanedMessages}`);
  } catch (err) {
    console.error('❌ Stats error:', err);
    process.exit(1);
  }
}

// ============ MAIN ============

const program = new Command();

program
  .name('openclaw-memory')
  .description('Persistent memory for AI agents using Supabase')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize configuration (creates .openclaw-memory.json)')
  .action(cmdInit);

program
  .command('migrate')
  .description('Display database migration SQL')
  .action(cmdMigrate);

program
  .command('test')
  .description('Test Supabase connection and verify tables')
  .action(cmdTest);

program
  .command('status')
  .description('Show database statistics and active sessions')
  .action(cmdStatus);

program
  .command('search <query>')
  .description('Search memories using keyword, semantic, or hybrid search')
  .option('-l, --limit <number>', 'Maximum results', '10')
  .option('-m, --mode <type>', 'Search mode: keyword, semantic, or hybrid', 'keyword')
  .option('-s, --min-similarity <number>', 'Minimum similarity score (0-1) for semantic/hybrid search', '0.7')
  .action((query, options) => {
    const mode = ['keyword', 'semantic', 'hybrid'].includes(options.mode) ? options.mode : 'keyword';
    cmdSearch(query, { 
      limit: parseInt(options.limit),
      mode: mode as 'keyword' | 'semantic' | 'hybrid',
      minSimilarity: parseFloat(options.minSimilarity)
    });
  });

program
  .command('sessions')
  .description('List recent sessions')
  .option('-l, --limit <number>', 'Maximum sessions', '20')
  .option('-a, --active', 'Show only active sessions')
  .action((options) => {
    cmdSessions({ 
      limit: parseInt(options.limit), 
      active: options.active 
    });
  });

program
  .command('export [path]')
  .description('Export memories to markdown file')
  .action((path) => {
    cmdExport(path || 'openclaw-memory-export.md');
  });

program
  .command('import <path>')
  .description('Import memories from markdown file')
  .action(cmdImport);

program
  .command('decay')
  .description('Apply importance decay to old memories')
  .option('-d, --days <number>', 'Only decay memories older than X days', '7')
  .option('-r, --rate <number>', 'Decay rate (0-1)', '0.1')
  .option('--min <number>', 'Minimum importance threshold', '0.1')
  .action((options) => {
    cmdDecay({
      olderThanDays: parseInt(options.days),
      decayRate: parseFloat(options.rate),
      minImportance: parseFloat(options.min)
    });
  });

program
  .command('consolidate')
  .description('Merge similar memories')
  .option('-t, --threshold <number>', 'Similarity threshold (0-1)', '0.9')
  .option('-c, --category <name>', 'Filter by category')
  .option('-l, --limit <number>', 'Max memories to check', '100')
  .action((options) => {
    cmdConsolidate({
      similarityThreshold: parseFloat(options.threshold),
      category: options.category,
      limit: parseInt(options.limit)
    });
  });

program
  .command('tag <memoryId> <tags...>')
  .description('Add tags to a memory')
  .action(cmdTag);

program
  .command('untag <memoryId> <tags...>')
  .description('Remove tags from a memory')
  .action(cmdUntag);

program
  .command('search-tags <tags...>')
  .description('Search memories by tags')
  .option('-a, --all', 'Match ALL tags (default: match ANY)')
  .option('-l, --limit <number>', 'Maximum results', '50')
  .action((tags, options) => {
    cmdSearchTags(tags, {
      matchAll: options.all,
      limit: parseInt(options.limit)
    });
  });

program
  .command('cleanup')
  .description('Archive or delete old sessions')
  .option('-d, --days <number>', 'Archive sessions older than X days', '90')
  .option('--delete', 'Delete instead of archive')
  .option('--keep-summaries', 'Keep sessions with summaries', true)
  .action((options) => {
    cmdCleanup({
      olderThanDays: parseInt(options.days),
      action: options.delete ? 'delete' : 'archive',
      keepSummaries: options.keepSummaries
    });
  });

program
  .command('cleanup-stats')
  .description('Show cleanup statistics')
  .action(cmdCleanupStats);

program.parse(process.argv);
