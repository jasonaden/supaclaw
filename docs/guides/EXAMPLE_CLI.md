# Supaclaw CLI - Quick Start

## Installation

```bash
npm install supaclaw
# or globally:
npm install -g supaclaw
```

## Setup

### 1. Initialize Configuration

```bash
npx supaclaw init
```

You'll be prompted for:
- Supabase URL (from your project settings)
- Supabase anon/service key (from your project API settings)
- Agent ID (e.g., "hans-assistant")

This creates `.supaclaw.json`:

```json
{
  "supabaseUrl": "https://xxx.supabase.co",
  "supabaseKey": "eyJ...",
  "agentId": "hans-assistant"
}
```

### 2. Run Migrations

```bash
npx supaclaw migrate
```

This will display the SQL to run in your Supabase SQL Editor. Copy and paste it into:

**Supabase Dashboard → SQL Editor → New Query**

### 3. Verify Setup

```bash
npx supaclaw status
```

Output:
```
📊 Supaclaw - Status

Agent ID: hans-assistant
Supabase: https://xxx.supabase.co

Database Statistics:
  sessions     0 records
  messages     0 records
  memories     0 records
  entities     0 records
  tasks        0 records
  learnings    0 records
```

## Usage in Code

```typescript
import Supaclaw from 'supaclaw';
import { readFileSync } from 'fs';

// Load config
const config = JSON.parse(readFileSync('.supaclaw.json', 'utf-8'));

// Initialize
const memory = new Supaclaw(config);

// Start a session
const session = await memory.startSession({
  userId: 'han',
  channel: 'telegram'
});

// Add messages
await memory.addMessage(session.id, {
  role: 'user',
  content: 'Remember: I prefer tabs over spaces'
});

await memory.addMessage(session.id, {
  role: 'assistant',
  content: 'Got it! Tabs > spaces for you.'
});

// Create a long-term memory
await memory.remember({
  content: 'Han prefers tabs over spaces in code',
  category: 'preference',
  importance: 0.8,
  userId: 'han',
  sessionId: session.id
});

// Later: Recall memories
const memories = await memory.recall('code formatting preferences', {
  userId: 'han',
  limit: 5
});

console.log(memories);
// [{ content: 'Han prefers tabs over spaces...', importance: 0.8, ... }]

// End session
await memory.endSession(session.id, {
  summary: 'Discussed code formatting preferences'
});
```

## Commands

```bash
# Initialize config
supaclaw init

# Show migration SQL
supaclaw migrate

# Check database status
supaclaw status

# Help
supaclaw help
```

## Next Steps

- Read the [API Documentation](./README.md)
- Check the [Schema](./SCHEMA.md)
- See the [Development Plan](./TODO.md)
