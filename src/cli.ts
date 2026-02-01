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

async function cmdSearch(query: string, options: { limit?: number }): Promise<void> {
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
  console.log(`🔍 Searching memories for: "${query}"\n`);

  const supabase = getSupabaseClient(config);

  try {
    // For now, use keyword search (semantic search requires embeddings)
    const { data, error } = await supabase
      .from('memories')
      .select('*')
      .eq('agent_id', config.agentId)
      .or(`content.ilike.%${query}%,category.ilike.%${query}%`)
      .order('importance', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('❌ Search failed:', error.message);
      process.exit(1);
    }

    if (!data || data.length === 0) {
      console.log('No memories found.');
      return;
    }

    console.log(`Found ${data.length} memories:\n`);
    data.forEach((mem, idx) => {
      console.log(`${idx + 1}. [${mem.category}] (importance: ${mem.importance})`);
      console.log(`   ${mem.content}`);
      if (mem.metadata) {
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
  .description('Search memories by keyword')
  .option('-l, --limit <number>', 'Maximum results', '10')
  .action((query, options) => {
    cmdSearch(query, { limit: parseInt(options.limit) });
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

program.parse(process.argv);
