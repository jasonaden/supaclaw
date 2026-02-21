#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createInterface } from 'readline';

const CONFIG_FILE = '.supaclaw.json';

interface Config {
  supabaseUrl: string;
  supabaseKey: string;
  agentId: string;
  embeddingProvider?: 'openai' | 'gemini' | 'voyage' | 'none';
  openaiApiKey?: string;
  geminiApiKey?: string;
  embeddingModel?: string;
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
  console.log('🚀 Supaclaw - Setup\n');

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
  console.log('  1. Run migrations: npx supaclaw migrate');
  console.log('  2. Test connection: npx supaclaw test');
  console.log('  3. Check status:    npx supaclaw status');
}

async function cmdMigrate(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `supaclaw init` first.');
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
  console.log('   npx supaclaw test');
  console.log('   npx supaclaw status');
}

async function cmdTest(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `supaclaw init` first.');
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
        console.error('   npx supaclaw migrate');
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
      console.log('   npx supaclaw migrate');
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
    console.error('❌ No config found. Run `supaclaw init` first.');
    process.exit(1);
  }

  console.log('📊 Supaclaw - Status\n');

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
    console.error('❌ No config found. Run `supaclaw init` first.');
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
    } else if (mode === 'semantic' || mode === 'hybrid') {
      // Use Supaclaw class for embedding generation (supports openai + gemini)
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId,
        embeddingProvider: config.embeddingProvider || 'none',
        openaiApiKey: config.openaiApiKey || process.env.OPENAI_API_KEY,
        geminiApiKey: config.geminiApiKey || process.env.GEMINI_API_KEY,
        embeddingModel: config.embeddingModel,
      });

      if (!config.embeddingProvider || config.embeddingProvider === 'none') {
        console.error('❌ Embedding provider required for semantic/hybrid search.');
        console.error('   Set "embeddingProvider" to "gemini" or "openai" in .supaclaw.json');
        process.exit(1);
      }

      if (mode === 'semantic') {
        const results = await memory.recall(query, {
          limit,
          minSimilarity: options.minSimilarity || 0.5,
        });
        data = results || [];
      } else {
        const results = await memory.hybridRecall(query, {
          limit,
          vectorWeight: 0.7,
          keywordWeight: 0.3,
        });
        data = results || [];
      }
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
    console.error('❌ No config found. Run `supaclaw init` first.');
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
    console.error('❌ No config found. Run `supaclaw init` first.');
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
    let markdown = `# Supaclaw Export\n\n`;
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
    const resolvedPath = outputPath || 'supaclaw-export.md';
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
    console.error('❌ No config found. Run `supaclaw init` first.');
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
    console.error('❌ No config found. Run `supaclaw init` first.');
    process.exit(1);
  }

  try {
    const { Supaclaw } = await import('./index');
    const memory = new Supaclaw({
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
    console.error('❌ No config found. Run `supaclaw init` first.');
    process.exit(1);
  }

  try {
    const { Supaclaw } = await import('./index');
    const memory = new Supaclaw({
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
    console.error('❌ No config found. Run `supaclaw init` first.');
    process.exit(1);
  }

  try {
    const { Supaclaw } = await import('./index');
    const memory = new Supaclaw({
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
    console.error('❌ No config found. Run `supaclaw init` first.');
    process.exit(1);
  }

  try {
    const { Supaclaw } = await import('./index');
    const memory = new Supaclaw({
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
    console.error('❌ No config found. Run `supaclaw init` first.');
    process.exit(1);
  }

  try {
    const { Supaclaw } = await import('./index');
    const memory = new Supaclaw({
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
    console.error('❌ No config found. Run `supaclaw init` first.');
    process.exit(1);
  }

  try {
    const { Supaclaw } = await import('./index');
    const memory = new Supaclaw({
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
    console.error('❌ No config found. Run `supaclaw init` first.');
    process.exit(1);
  }

  try {
    const { Supaclaw } = await import('./index');
    const memory = new Supaclaw({
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
  .name('supaclaw')
  .description('Persistent memory for AI agents using Supabase')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize configuration (creates .supaclaw.json)')
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
    cmdExport(path || 'supaclaw-export.md');
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

program
  .command('entities')
  .description('List entities')
  .option('-t, --type <type>', 'Filter by entity type')
  .option('-l, --limit <number>', 'Maximum results', '50')
  .action(async (options) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const entities = await memory.searchEntities({
        entityType: options.type,
        limit: parseInt(options.limit)
      });

      if (entities.length === 0) {
        console.log('No entities found.');
        return;
      }

      console.log(`\n📦 Found ${entities.length} entities:\n`);
      entities.forEach((entity, i) => {
        console.log(`${i + 1}. ${entity.name} [${entity.entity_type}]`);
        console.log(`   ID: ${entity.id}`);
        if (entity.description) {
          console.log(`   Description: ${entity.description}`);
        }
        if (entity.aliases && entity.aliases.length > 0) {
          console.log(`   Aliases: ${entity.aliases.join(', ')}`);
        }
        console.log(`   Mentions: ${entity.mention_count}`);
        console.log(`   Last seen: ${new Date(entity.last_seen_at).toLocaleString()}`);
        console.log();
      });
    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

program
  .command('entity-graph <entityId>')
  .description('Show entity relationship graph')
  .option('-d, --depth <number>', 'Maximum depth', '2')
  .option('-c, --min-confidence <number>', 'Minimum confidence', '0.5')
  .action(async (entityId, options) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      // Get direct relationships
      const relationships = await memory.getEntityRelationships(entityId);

      console.log(`\n🕸️  Entity Relationship Graph\n`);

      if (relationships.length === 0) {
        console.log('No relationships found.');
        return;
      }

      // Group by direction
      const outgoing = relationships.filter(r => r.direction === 'outgoing');
      const incoming = relationships.filter(r => r.direction === 'incoming');

      if (outgoing.length > 0) {
        console.log('Outgoing relationships:');
        outgoing.forEach(r => {
          console.log(`  → ${r.relatedEntity.name} [${r.relationship.relationship_type}]`);
          console.log(`     Confidence: ${r.relationship.confidence.toFixed(2)}, Mentions: ${r.relationship.mention_count}`);
        });
        console.log();
      }

      if (incoming.length > 0) {
        console.log('Incoming relationships:');
        incoming.forEach(r => {
          console.log(`  ← ${r.relatedEntity.name} [${r.relationship.relationship_type}]`);
          console.log(`     Confidence: ${r.relationship.confidence.toFixed(2)}, Mentions: ${r.relationship.mention_count}`);
        });
        console.log();
      }

      // Get related entities (graph traversal)
      const related = await memory.findRelatedEntities(entityId, {
        maxDepth: parseInt(options.depth),
        minConfidence: parseFloat(options.minConfidence)
      });

      if (related.length > 0) {
        console.log(`Related entities (within ${options.depth} hops):`);
        related.forEach(r => {
          const path = r.relationshipPath.join(' → ');
          console.log(`  ${r.entityName} [${r.entityType}]`);
          console.log(`     Path: ${path}`);
          console.log(`     Confidence: ${r.totalConfidence.toFixed(3)}, Depth: ${r.depth}`);
        });
      }

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

program
  .command('entity-stats')
  .description('Show entity network statistics')
  .action(async () => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const stats = await memory.getEntityNetworkStats();

      console.log('\n📊 Entity Network Statistics\n');
      console.log(`Total Entities: ${stats.totalEntities}`);
      console.log(`Total Relationships: ${stats.totalRelationships}`);
      console.log(`Avg Connections per Entity: ${stats.avgConnectionsPerEntity.toFixed(2)}`);
      
      if (stats.mostConnectedEntity) {
        console.log(`\nMost Connected Entity:`);
        console.log(`  Name: ${stats.mostConnectedEntity.name}`);
        console.log(`  Connections: ${stats.mostConnectedEntity.connectionCount}`);
      }
    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

program
  .command('extract-entities <text>')
  .description('Extract entities and relationships from text')
  .option('-k, --openai-key <key>', 'OpenAI API key (or set OPENAI_API_KEY env var)')
  .action(async (text, options) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    const apiKey = options.openaiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('❌ OpenAI API key required. Provide via --openai-key or OPENAI_API_KEY env var.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId,
        openaiApiKey: apiKey
      });

      console.log('🧠 Extracting entities and relationships...\n');
      const result = await memory.extractEntitiesWithRelationships(text);

      console.log(`✅ Extracted:`);
      console.log(`   Entities: ${result.entities.length}`);
      console.log(`   Relationships: ${result.relationships.length}\n`);

      if (result.entities.length > 0) {
        console.log('Entities:');
        result.entities.forEach(e => {
          console.log(`  - ${e.name} [${e.entity_type}]`);
          if (e.description) {
            console.log(`    ${e.description}`);
          }
        });
        console.log();
      }

      if (result.relationships.length > 0) {
        console.log('Relationships:');
        result.relationships.forEach(r => {
          const source = result.entities.find(e => e.id === r.source_entity_id)?.name;
          const target = result.entities.find(e => e.id === r.target_entity_id)?.name;
          console.log(`  - ${source} → ${r.relationship_type} → ${target}`);
          console.log(`    Confidence: ${r.confidence.toFixed(2)}`);
        });
      }

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

// ============ TASK DEPENDENCIES ============

program
  .command('task-deps <taskId>')
  .description('Show task dependencies')
  .action(async (taskId) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const dependencies = await memory.getTaskDependencies(taskId);
      const blocked = await memory.isTaskBlocked(taskId);

      console.log(`\n📋 Task Dependencies for ${taskId}:`);
      console.log(`Status: ${blocked ? '🚫 BLOCKED' : '✅ Ready'}\n`);

      if (dependencies.length === 0) {
        console.log('No dependencies');
      } else {
        dependencies.forEach(dep => {
          const statusIcon = dep.status === 'done' ? '✅' : '⏳';
          console.log(`${statusIcon} [${dep.status.toUpperCase()}] ${dep.title}`);
        });
      }

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

program
  .command('task-add-dep <taskId> <dependsOnTaskId>')
  .description('Add a task dependency')
  .action(async (taskId, dependsOnTaskId) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      await memory.addTaskDependency(taskId, dependsOnTaskId);
      console.log(`✅ Dependency added: ${taskId} depends on ${dependsOnTaskId}`);

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

program
  .command('task-ready')
  .description('List tasks ready to start (no blocking dependencies)')
  .option('-u, --user <userId>', 'Filter by user ID')
  .action(async (options) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const tasks = await memory.getReadyTasks({ userId: options.user });

      console.log(`\n✅ Ready Tasks (${tasks.length}):\n`);
      tasks.forEach(task => {
        console.log(`[P${task.priority}] ${task.title}`);
        if (task.description) {
          console.log(`   ${task.description}`);
        }
        if (task.due_at) {
          console.log(`   Due: ${new Date(task.due_at).toLocaleString()}`);
        }
        console.log();
      });

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

// ============ TASK TEMPLATES ============

program
  .command('task-template <name>')
  .description('Create a task template')
  .option('-f, --file <path>', 'JSON file with template definition')
  .action(async (name, options) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    if (!options.file) {
      console.error('❌ --file required. Provide a JSON file with template definition.');
      console.log('\nExample JSON:');
      console.log(JSON.stringify({
        name: 'Example Template',
        description: 'Template description',
        tasks: [
          { title: 'Task 1', description: 'First task', priority: 5 },
          { title: 'Task 2', description: 'Depends on Task 1', priority: 3, dependencies: [0] }
        ]
      }, null, 2));
      process.exit(1);
    }

    try {
      const fs = await import('fs/promises');
      const templateData = JSON.parse(await fs.readFile(options.file, 'utf-8'));

      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const result = await memory.createTaskTemplate(templateData);
      console.log(`✅ Template created: ${result.id}`);

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

program
  .command('task-templates')
  .description('List all task templates')
  .action(async () => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const templates = await memory.getTaskTemplates();

      console.log(`\n📋 Task Templates (${templates.length}):\n`);
      templates.forEach(t => {
        console.log(`📝 ${t.name} [ID: ${t.id}]`);
        if (t.description) {
          console.log(`   ${t.description}`);
        }
        console.log(`   Tasks: ${t.tasks.length}`);
        console.log();
      });

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

program
  .command('task-apply-template <templateId>')
  .description('Apply a task template (create all tasks)')
  .option('-u, --user <userId>', 'User ID for created tasks')
  .option('-s, --start <date>', 'Start date (ISO format)')
  .action(async (templateId, options) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const tasks = await memory.applyTaskTemplate(templateId, {
        userId: options.user,
        startDate: options.start
      });

      console.log(`✅ Created ${tasks.length} tasks from template:`);
      tasks.forEach(t => {
        console.log(`  - ${t.title} [${t.id}]`);
      });

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

// ============ TASK REMINDERS ============

program
  .command('task-reminders')
  .description('Show tasks needing reminders')
  .option('-u, --user <userId>', 'Filter by user ID')
  .option('-h, --hours <hours>', 'Hours ahead to check (default: 24)', '24')
  .action(async (options) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const tasks = await memory.getTasksNeedingReminders({
        userId: options.user,
        hoursAhead: parseInt(options.hours)
      });

      console.log(`\n⏰ Tasks Needing Reminders (${tasks.length}):\n`);
      tasks.forEach(task => {
        console.log(memory.formatTaskReminder(task, task.timeUntilDue));
        console.log();
      });

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

// ============ LEARNING PATTERNS ============

program
  .command('learning-patterns')
  .description('Detect patterns in learnings')
  .action(async () => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const patterns = await memory.detectLearningPatterns();

      console.log('\n📊 Learning Patterns:\n');
      
      console.log('Common Categories:');
      patterns.commonCategories.forEach(c => {
        console.log(`  - ${c.category}: ${c.count}`);
      });

      console.log('\nCommon Triggers:');
      patterns.commonTriggers.slice(0, 5).forEach(t => {
        console.log(`  - "${t.pattern}": ${t.count} occurrences`);
      });

      console.log('\nRecent Trends:');
      patterns.recentTrends.forEach(t => {
        const icon = t.severity === 'critical' ? '🔴' : t.severity === 'warning' ? '🟡' : '🟢';
        console.log(`  ${icon} Week ${t.week}: ${t.count} learnings`);
      });

      console.log('\nTop Applied Lessons:');
      patterns.topLessons.forEach(l => {
        console.log(`  - "${l.lesson.substring(0, 60)}..." (${l.applied} times)`);
      });

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

program
  .command('learning-recommend <context>')
  .description('Get learning recommendations for current context')
  .option('-l, --limit <number>', 'Max recommendations', '5')
  .action(async (context, options) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const recommendations = await memory.getLearningRecommendations(
        context,
        parseInt(options.limit)
      );

      console.log(`\n💡 Learning Recommendations for "${context}":\n`);
      recommendations.forEach(l => {
        console.log(`[${l.severity.toUpperCase()}] ${l.category}`);
        console.log(`Trigger: ${l.trigger}`);
        console.log(`Lesson: ${l.lesson}`);
        if (l.action) {
          console.log(`Action: ${l.action}`);
        }
        console.log(`Applied: ${l.applied_count} times\n`);
      });

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

// ============ LEARNING SIMILARITY ============

program
  .command('learning-similar <learningId>')
  .description('Find similar learnings using embeddings')
  .option('-k, --openai-key <key>', 'OpenAI API key (or set OPENAI_API_KEY env var)')
  .option('-l, --limit <number>', 'Max results', '5')
  .option('-t, --threshold <number>', 'Similarity threshold (0-1)', '0.7')
  .action(async (learningId, options) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    const apiKey = options.openaiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      console.error('❌ OpenAI API key required. Provide via --openai-key or OPENAI_API_KEY env var.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId,
        openaiApiKey: apiKey
      });

      const similar = await memory.findSimilarLearnings(learningId, {
        limit: parseInt(options.limit),
        threshold: parseFloat(options.threshold)
      });

      console.log(`\n🔍 Similar Learnings to ${learningId}:\n`);
      similar.forEach(l => {
        console.log(`[Similarity: ${(l.similarity * 100).toFixed(1)}%] ${l.category}`);
        console.log(`Trigger: ${l.trigger}`);
        console.log(`Lesson: ${l.lesson}`);
        console.log(`ID: ${l.id}\n`);
      });

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

// ============ LEARNING EXPORT ============

program
  .command('learning-export')
  .description('Export learnings to markdown report')
  .option('-c, --category <category>', 'Filter by category')
  .option('-s, --severity <severity>', 'Filter by severity')
  .option('-d, --since <date>', 'Only include learnings since date (ISO format)')
  .option('-o, --output <path>', 'Output file path', 'learnings-report.md')
  .action(async (options) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const report = await memory.exportLearningsReport({
        category: options.category,
        severity: options.severity,
        since: options.since
      });

      const fs = await import('fs/promises');
      await fs.writeFile(options.output, report, 'utf-8');

      console.log(`✅ Learning report exported to ${options.output}`);

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

program
  .command('learning-export-json')
  .description('Export learnings to JSON')
  .option('-c, --category <category>', 'Filter by category')
  .option('-s, --severity <severity>', 'Filter by severity')
  .option('-d, --since <date>', 'Only include learnings since date (ISO format)')
  .option('-o, --output <path>', 'Output file path', 'learnings-export.json')
  .action(async (options) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      const { Supaclaw } = await import('./index');
      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      const data = await memory.exportLearningsJSON({
        category: options.category,
        severity: options.severity,
        since: options.since
      });

      const fs = await import('fs/promises');
      await fs.writeFile(options.output, JSON.stringify(data, null, 2), 'utf-8');

      console.log(`✅ Learning data exported to ${options.output}`);

    } catch (err) {
      console.error('❌ Error:', err);
      process.exit(1);
    }
  });

// ============ PHASE 9: MIGRATION & IMPORT ============

program
  .command('import-memory-md <path>')
  .description('Import MEMORY.md into memories table')
  .action(async (memoryPath: string) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      console.log(`📥 Importing MEMORY.md from: ${memoryPath}\n`);

      const { parseMemoryMd } = await import('./parsers');
      const { Supaclaw } = await import('./index');

      const memories = parseMemoryMd(memoryPath);
      console.log(`Found ${memories.length} memories to import\n`);

      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      let imported = 0;
      for (const mem of memories) {
        try {
          await memory.remember({
            content: mem.content,
            category: mem.category,
            importance: mem.importance,
            metadata: mem.metadata
          });
          imported++;
        } catch (err) {
          console.error(`⚠️  Failed to import: ${mem.content.substring(0, 50)}...`, err);
        }
      }

      console.log(`\n✅ Imported ${imported}/${memories.length} memories`);

    } catch (err) {
      console.error('❌ Import error:', err);
      process.exit(1);
    }
  });

program
  .command('import-daily-logs <directory>')
  .description('Import memory/*.md daily logs into sessions table')
  .option('-u, --user-id <id>', 'User ID for sessions', 'default')
  .action(async (directory: string, options: { userId: string }) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      console.log(`📥 Importing daily logs from: ${directory}\n`);

      const { parseAllDailyLogs } = await import('./parsers');
      const { Supaclaw } = await import('./index');

      const sessions = parseAllDailyLogs(directory, options.userId);
      console.log(`Found ${sessions.length} sessions to import\n`);

      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      let imported = 0;
      for (const sess of sessions) {
        try {
          const session = await memory.startSession({
            userId: sess.user_id,
            channel: sess.channel
          });

          for (const msg of sess.messages) {
            await memory.addMessage(session.id, {
              role: msg.role,
              content: msg.content
            });
          }

          if (sess.ended_at || sess.summary) {
            await memory.endSession(session.id, { summary: sess.summary });
          }

          imported++;
        } catch (err) {
          console.error(`⚠️  Failed to import session:`, err);
        }
      }

      console.log(`\n✅ Imported ${imported}/${sessions.length} sessions`);

    } catch (err) {
      console.error('❌ Import error:', err);
      process.exit(1);
    }
  });

program
  .command('import-todo-md <path>')
  .description('Import TODO.md into tasks table')
  .action(async (todoPath: string) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      console.log(`📥 Importing TODO.md from: ${todoPath}\n`);

      const { parseTodoMd } = await import('./parsers');
      const { Supaclaw } = await import('./index');

      const tasks = parseTodoMd(todoPath);
      console.log(`Found ${tasks.length} tasks to import\n`);

      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      let imported = 0;
      for (const task of tasks) {
        try {
          await memory.createTask({
            title: task.title,
            description: task.description,
            priority: task.priority,
            dueAt: task.due_date,
            metadata: { ...task.metadata, originalStatus: task.status }
          });
          imported++;
        } catch (err) {
          console.error(`⚠️  Failed to import task: ${task.title}`, err);
        }
      }

      console.log(`\n✅ Imported ${imported}/${tasks.length} tasks`);

    } catch (err) {
      console.error('❌ Import error:', err);
      process.exit(1);
    }
  });

program
  .command('import-learnings-md <path>')
  .description('Import LEARNINGS.md into learnings table')
  .action(async (learningsPath: string) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    try {
      console.log(`📥 Importing LEARNINGS.md from: ${learningsPath}\n`);

      const { parseLearningsMd } = await import('./parsers');
      const { Supaclaw } = await import('./index');

      const learnings = parseLearningsMd(learningsPath);
      console.log(`Found ${learnings.length} learnings to import\n`);

      const memory = new Supaclaw({
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        agentId: config.agentId
      });

      let imported = 0;
      for (const learning of learnings) {
        try {
          // Map parsed category to valid enum value
          const validCategories = ['error', 'correction', 'improvement', 'capability_gap'];
          const category = validCategories.includes(learning.category) 
            ? learning.category as 'error' | 'correction' | 'improvement' | 'capability_gap'
            : 'improvement';

          await memory.learn({
            category,
            trigger: learning.trigger,
            lesson: learning.lesson,
            metadata: { 
              originalCategory: learning.category,
              originalImportance: learning.importance 
            }
          });
          imported++;
        } catch (err) {
          console.error(`⚠️  Failed to import learning:`, err);
        }
      }

      console.log(`\n✅ Imported ${imported}/${learnings.length} learnings`);

    } catch (err) {
      console.error('❌ Import error:', err);
      process.exit(1);
    }
  });

program
  .command('import-all <workspace>')
  .description('Import all Clawdbot memory files from workspace (MEMORY.md, memory/, TODO.md, LEARNINGS.md)')
  .option('-u, --user-id <id>', 'User ID for sessions', 'default')
  .action(async (workspace: string, options: { userId: string }) => {
    const config = loadConfig();
    if (!config) {
      console.error('❌ No config found. Run `supaclaw init` first.');
      process.exit(1);
    }

    const { join } = await import('path');
    const { existsSync } = await import('fs');

    console.log(`📦 Importing all memory files from: ${workspace}\n`);

    const memoryMdPath = join(workspace, 'MEMORY.md');
    const dailyLogsDir = join(workspace, 'memory');
    const todoMdPath = join(workspace, 'TODO.md');
    const learningsMdPath = join(workspace, 'LEARNINGS.md');

    let totalImported = 0;

    // Import MEMORY.md
    if (existsSync(memoryMdPath)) {
      try {
        console.log('📄 Importing MEMORY.md...');
        const { parseMemoryMd } = await import('./parsers');
        const { Supaclaw } = await import('./index');

        const memories = parseMemoryMd(memoryMdPath);
        const memory = new Supaclaw({
          supabaseUrl: config.supabaseUrl,
          supabaseKey: config.supabaseKey,
          agentId: config.agentId
        });

        for (const mem of memories) {
          try {
            await memory.remember({
              content: mem.content,
              category: mem.category,
              importance: mem.importance,
              metadata: mem.metadata
            });
            totalImported++;
          } catch (err) {
            // Silent skip
          }
        }
        console.log(`✅ Imported ${memories.length} memories\n`);
      } catch (err) {
        console.error('⚠️  Failed to import MEMORY.md:', err);
      }
    }

    // Import daily logs
    if (existsSync(dailyLogsDir)) {
      try {
        console.log('📅 Importing daily logs...');
        const { parseAllDailyLogs } = await import('./parsers');
        const { Supaclaw } = await import('./index');

        const sessions = parseAllDailyLogs(dailyLogsDir, options.userId);
        const memory = new Supaclaw({
          supabaseUrl: config.supabaseUrl,
          supabaseKey: config.supabaseKey,
          agentId: config.agentId
        });

        for (const sess of sessions) {
          try {
            const session = await memory.startSession({
              userId: sess.user_id,
              channel: sess.channel
            });

            for (const msg of sess.messages) {
              await memory.addMessage(session.id, {
                role: msg.role,
                content: msg.content
              });
            }

            if (sess.ended_at || sess.summary) {
              await memory.endSession(session.id, { summary: sess.summary });
            }
            totalImported++;
          } catch (err) {
            // Silent skip
          }
        }
        console.log(`✅ Imported ${sessions.length} sessions\n`);
      } catch (err) {
        console.error('⚠️  Failed to import daily logs:', err);
      }
    }

    // Import TODO.md
    if (existsSync(todoMdPath)) {
      try {
        console.log('✅ Importing TODO.md...');
        const { parseTodoMd } = await import('./parsers');
        const { Supaclaw } = await import('./index');

        const tasks = parseTodoMd(todoMdPath);
        const memory = new Supaclaw({
          supabaseUrl: config.supabaseUrl,
          supabaseKey: config.supabaseKey,
          agentId: config.agentId
        });

        for (const task of tasks) {
          try {
            await memory.createTask({
              title: task.title,
              description: task.description,
              priority: task.priority,
              dueAt: task.due_date,
              metadata: { ...task.metadata, originalStatus: task.status }
            });
            totalImported++;
          } catch (err) {
            // Silent skip
          }
        }
        console.log(`✅ Imported ${tasks.length} tasks\n`);
      } catch (err) {
        console.error('⚠️  Failed to import TODO.md:', err);
      }
    }

    // Import LEARNINGS.md
    if (existsSync(learningsMdPath)) {
      try {
        console.log('🧠 Importing LEARNINGS.md...');
        const { parseLearningsMd } = await import('./parsers');
        const { Supaclaw } = await import('./index');

        const learnings = parseLearningsMd(learningsMdPath);
        const memory = new Supaclaw({
          supabaseUrl: config.supabaseUrl,
          supabaseKey: config.supabaseKey,
          agentId: config.agentId
        });

        for (const learning of learnings) {
          try {
            // Map parsed category to valid enum value
            const validCategories = ['error', 'correction', 'improvement', 'capability_gap'];
            const category = validCategories.includes(learning.category) 
              ? learning.category as 'error' | 'correction' | 'improvement' | 'capability_gap'
              : 'improvement';

            await memory.learn({
              category,
              trigger: learning.trigger,
              lesson: learning.lesson,
              metadata: { 
                originalCategory: learning.category,
                originalImportance: learning.importance 
              }
            });
            totalImported++;
          } catch (err) {
            // Silent skip
          }
        }
        console.log(`✅ Imported ${learnings.length} learnings\n`);
      } catch (err) {
        console.error('⚠️  Failed to import LEARNINGS.md:', err);
      }
    }

    console.log(`\n🎉 Migration complete! Total items imported: ${totalImported}`);
  });

// ============ WEBHOOK COMMANDS ============

const webhook = program.command('webhook').description('Manage webhook sources');

webhook
  .command('register')
  .description('Register a new webhook source')
  .requiredOption('--name <name>', 'Name for this webhook source (e.g. "telegram-bot")')
  .option('--agent-id <id>', 'Agent ID (defaults to config agentId)')
  .action(async (options: { name: string; agentId?: string }) => {
    const config = loadConfig();
    if (!config) {
      console.error('No config found. Run `supaclaw init` first.');
      process.exit(1);
    }
    const supabase = getSupabaseClient(config);
    const { generateWebhookSecret, hashSecret } = await import('./webhook-auth');

    const agentId = options.agentId || config.agentId;
    const secret = generateWebhookSecret();
    const secretHash = await hashSecret(secret);

    const { error } = await supabase.from('webhook_sources').insert({
      agent_id: agentId,
      name: options.name,
      secret_hash: secretHash,
    });

    if (error) {
      console.error('Failed to register webhook source:', error.message);
      process.exit(1);
    }

    console.log('');
    console.log('Webhook source registered: ' + options.name);
    console.log('Agent: ' + agentId);
    console.log('');
    console.log('Secret (save this, shown only once):');
    console.log('  ' + secret);
    console.log('');
  });

webhook
  .command('list')
  .description('List registered webhook sources')
  .action(async () => {
    const config = loadConfig();
    if (!config) {
      console.error('No config found. Run `supaclaw init` first.');
      process.exit(1);
    }
    const supabase = getSupabaseClient(config);

    const { data, error } = await supabase
      .from('webhook_sources')
      .select('id, agent_id, name, enabled, created_at')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to list webhook sources:', error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) {
      console.log('No webhook sources registered.');
      return;
    }

    console.log('');
    console.log('Webhook Sources:');
    console.log('');
    for (const src of data) {
      const status = src.enabled ? 'enabled' : 'disabled';
      console.log('  ' + src.name + ' (' + src.agent_id + ') - ' + status);
      console.log('    ID: ' + src.id + ' | Created: ' + src.created_at);
    }
    console.log('');
  });

webhook
  .command('revoke')
  .description('Disable a webhook source')
  .argument('<id>', 'Webhook source ID')
  .action(async (id: string) => {
    const config = loadConfig();
    if (!config) {
      console.error('No config found. Run `supaclaw init` first.');
      process.exit(1);
    }
    const supabase = getSupabaseClient(config);

    const { error } = await supabase
      .from('webhook_sources')
      .update({ enabled: false })
      .eq('id', id);

    if (error) {
      console.error('Failed to revoke webhook source:', error.message);
      process.exit(1);
    }

    console.log('Webhook source ' + id + ' revoked.');
  });

program.parse(process.argv);
