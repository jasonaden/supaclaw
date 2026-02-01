#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
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
  console.log('  2. Check status:   npx openclaw-memory status');
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
  console.log('   npx openclaw-memory status');
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.error('❌ No config found. Run `openclaw-memory init` first.');
    process.exit(1);
  }

  console.log('📊 OpenClaw Memory - Status\n');

  const supabase = createClient(config.supabaseUrl, config.supabaseKey);

  try {
    // Check each table
    const tables = ['sessions', 'messages', 'memories', 'entities', 'tasks', 'learnings'];
    const stats: Record<string, number> = {};

    for (const table of tables) {
      const { count, error } = await supabase
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq('agent_id', config.agentId);

      if (error) {
        if (error.code === '42P01') {
          console.log(`⚠️  Table "${table}" not found. Run migrations first.`);
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
        console.log(`  ${table.padEnd(12)} ${count} records`);
      }
    }

    // Check for active sessions
    const { data: activeSessions } = await supabase
      .from('sessions')
      .select('id, started_at, channel')
      .eq('agent_id', config.agentId)
      .is('ended_at', null)
      .limit(5);

    if (activeSessions && activeSessions.length > 0) {
      console.log(`\nActive Sessions: ${activeSessions.length}`);
      activeSessions.forEach(s => {
        console.log(`  - ${s.id.slice(0, 8)}... (${s.channel || 'no channel'})`);
      });
    }

  } catch (err) {
    console.error('❌ Failed to fetch status:', err);
    process.exit(1);
  }
}

function showHelp(): void {
  console.log(`
OpenClaw Memory CLI

Usage:
  openclaw-memory <command> [options]

Commands:
  init      Initialize configuration (creates .openclaw-memory.json)
  migrate   Run database migrations
  status    Show database statistics
  help      Show this help message

Examples:
  openclaw-memory init
  openclaw-memory migrate
  openclaw-memory status

Documentation: https://github.com/Arephan/openclaw-memory
`);
}

// ============ MAIN ============

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'init':
      await cmdInit();
      break;
    case 'migrate':
      await cmdMigrate();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      if (command) {
        console.error(`❌ Unknown command: ${command}\n`);
      }
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
