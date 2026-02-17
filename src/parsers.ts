/**
 * Phase 9: Migration & Import Parsers
 * 
 * Parsers for converting Clawdbot memory files to Supaclaw database format:
 * - MEMORY.md → memories table
 * - memory/*.md → sessions + messages
 * - TODO.md → tasks table
 * - LEARNINGS.md → learnings table
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

// ============ TYPES ============

export interface ParsedMemory {
  content: string;
  category: string;
  importance: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface ParsedSession {
  user_id: string;
  channel?: string;
  started_at: string;
  ended_at?: string;
  summary?: string;
  messages: ParsedMessage[];
}

export interface ParsedMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedTask {
  title: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?: number;
  due_date?: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedLearning {
  category: string;
  trigger: string;
  lesson: string;
  importance: number;
  applied_count?: number;
  created_at?: string;
}

// ============ MEMORY.MD PARSER ============

/**
 * Parse MEMORY.md into structured memories
 * 
 * Expected format:
 * # MEMORY.md
 * 
 * ## Category Name
 * 
 * - Memory item [importance: 0.9]
 * - Another memory [2024-01-28]
 * 
 * Regular paragraphs are also captured as memories.
 */
export function parseMemoryMd(filePath: string): ParsedMemory[] {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const memories: ParsedMemory[] = [];
  
  const lines = content.split('\n');
  let currentCategory = 'general';
  let currentParagraph = '';
  let lineNumber = 0;

  const flushParagraph = () => {
    if (currentParagraph.trim().length > 0) {
      memories.push({
        content: currentParagraph.trim(),
        category: currentCategory,
        importance: 0.6,
        metadata: { source: 'MEMORY.md' }
      });
      currentParagraph = '';
    }
  };

  for (const line of lines) {
    lineNumber++;
    const trimmed = line.trim();

    // Skip title and empty lines at paragraph boundaries
    if (trimmed.startsWith('# ') || trimmed === '') {
      flushParagraph();
      continue;
    }

    // Category header
    if (trimmed.startsWith('## ')) {
      flushParagraph();
      currentCategory = trimmed.slice(3).trim().toLowerCase();
      continue;
    }

    // List item memory
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      flushParagraph();
      let memoryText = trimmed.slice(2).trim();
      let importance = 0.6;
      let createdAt: string | undefined;

      // Extract [importance: X] tags
      const importanceMatch = memoryText.match(/\[importance:\s*([\d.]+)\]/i);
      if (importanceMatch) {
        importance = parseFloat(importanceMatch[1]!);
        memoryText = memoryText.replace(importanceMatch[0]!, '').trim();
      }

      // Extract [YYYY-MM-DD] dates
      const dateMatch = memoryText.match(/\[(\d{4}-\d{2}-\d{2})\]/);
      if (dateMatch) {
        createdAt = dateMatch[1]!;
        memoryText = memoryText.replace(dateMatch[0], '').trim();
      }

      if (memoryText.length > 0) {
        memories.push({
          content: memoryText,
          category: currentCategory,
          importance,
          created_at: createdAt,
          metadata: { source: 'MEMORY.md', line: lineNumber }
        });
      }
      continue;
    }

    // Regular text - accumulate into paragraph
    if (trimmed.length > 0) {
      currentParagraph += (currentParagraph ? ' ' : '') + trimmed;
    }
  }

  flushParagraph();

  return memories;
}

// ============ DAILY LOG PARSER (memory/*.md) ============

/**
 * Parse daily log files (memory/YYYY-MM-DD.md) into sessions and messages
 * 
 * Expected format:
 * # 2024-01-28
 * 
 * ## Session: Trading Research
 * Started: 09:00
 * 
 * **User**: What's the stock price of TSLA?
 * 
 * **Assistant**: Tesla is currently trading at $245.
 * 
 * **User**: Should I buy?
 * 
 * Summary: Discussed TSLA stock price...
 */
export function parseDailyLog(filePath: string, userId: string = 'default'): ParsedSession[] {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const sessions: ParsedSession[] = [];
  
  const lines = content.split('\n');
  let currentSession: ParsedSession | null = null;
  let currentMessage = '';
  let currentRole: 'user' | 'assistant' | 'system' | null = null;
  
  // Extract date from filename (YYYY-MM-DD.md)
  const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2})/);
  const fileDate = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

  const flushMessage = () => {
    if (currentMessage.trim() && currentRole && currentSession) {
      currentSession.messages.push({
        role: currentRole,
        content: currentMessage.trim(),
        timestamp: currentSession.started_at
      });
      currentMessage = '';
      currentRole = null;
    }
  };

  const flushSession = () => {
    if (currentSession) {
      sessions.push(currentSession);
      currentSession = null;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Session header
    if (trimmed.startsWith('## Session:') || trimmed.startsWith('## ')) {
      flushMessage();
      flushSession();
      
      const sessionName = trimmed.replace(/^## (Session:?\s*)?/, '').trim();
      currentSession = {
        user_id: userId,
        started_at: `${fileDate}T00:00:00Z`,
        messages: [],
        summary: sessionName
      };
      continue;
    }

    // Started/Ended timestamps
    if (trimmed.startsWith('Started:') && currentSession) {
      const time = trimmed.replace('Started:', '').trim();
      currentSession.started_at = `${fileDate}T${time}:00Z`;
      continue;
    }

    if (trimmed.startsWith('Ended:') && currentSession) {
      const time = trimmed.replace('Ended:', '').trim();
      currentSession.ended_at = `${fileDate}T${time}:00Z`;
      continue;
    }

    // Summary
    if (trimmed.startsWith('Summary:') && currentSession) {
      currentSession.summary = trimmed.replace('Summary:', '').trim();
      continue;
    }

    // Message markers
    if (trimmed.startsWith('**User**:') || trimmed.startsWith('**User**')) {
      flushMessage();
      currentRole = 'user';
      currentMessage = trimmed.replace(/^\*\*User\*\*:?\s*/, '');
      continue;
    }

    if (trimmed.startsWith('**Assistant**:') || trimmed.startsWith('**Assistant**')) {
      flushMessage();
      currentRole = 'assistant';
      currentMessage = trimmed.replace(/^\*\*Assistant\*\*:?\s*/, '');
      continue;
    }

    if (trimmed.startsWith('**System**:') || trimmed.startsWith('**System**')) {
      flushMessage();
      currentRole = 'system';
      currentMessage = trimmed.replace(/^\*\*System\*\*:?\s*/, '');
      continue;
    }

    // Continue accumulating message content
    if (currentRole && trimmed.length > 0) {
      currentMessage += '\n' + trimmed;
    }
  }

  flushMessage();
  flushSession();

  // If no sessions were found but there's content, create a default session
  if (sessions.length === 0 && content.trim().length > 0) {
    sessions.push({
      user_id: userId,
      started_at: `${fileDate}T00:00:00Z`,
      messages: [{
        role: 'system',
        content: content,
        timestamp: `${fileDate}T00:00:00Z`
      }],
      summary: 'Daily log'
    });
  }

  return sessions;
}

/**
 * Parse all daily logs in a directory (memory/*.md)
 */
export function parseAllDailyLogs(memoryDir: string, userId: string = 'default'): ParsedSession[] {
  if (!existsSync(memoryDir)) {
    throw new Error(`Directory not found: ${memoryDir}`);
  }

  const files = readdirSync(memoryDir)
    .filter(f => f.match(/^\d{4}-\d{2}-\d{2}\.md$/))
    .sort();

  const allSessions: ParsedSession[] = [];

  for (const file of files) {
    const filePath = join(memoryDir, file);
    try {
      const sessions = parseDailyLog(filePath, userId);
      allSessions.push(...sessions);
    } catch (err) {
      console.error(`⚠️  Failed to parse ${file}:`, err);
    }
  }

  return allSessions;
}

// ============ TODO.MD PARSER ============

/**
 * Parse TODO.md into structured tasks
 * 
 * Expected format:
 * # TODO
 * 
 * ## Priority: High
 * - [ ] Incomplete task
 * - [x] Completed task
 * - [~] Cancelled task
 * 
 * ## Category Name
 * - [ ] Task with [due: 2024-02-01]
 */
export function parseTodoMd(filePath: string): ParsedTask[] {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const tasks: ParsedTask[] = [];
  
  const lines = content.split('\n');
  let currentPriority = 1;
  let currentCategory = 'general';

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip title and empty lines
    if (trimmed.startsWith('# ') || trimmed === '') {
      continue;
    }

    // Category/Section headers
    if (trimmed.startsWith('## ')) {
      const header = trimmed.slice(3).trim();
      
      // Check for priority indicators
      if (header.toLowerCase().includes('priority')) {
        if (header.toLowerCase().includes('high') || header.toLowerCase().includes('urgent')) {
          currentPriority = 3;
        } else if (header.toLowerCase().includes('medium') || header.toLowerCase().includes('normal')) {
          currentPriority = 2;
        } else if (header.toLowerCase().includes('low')) {
          currentPriority = 1;
        }
      } else {
        currentCategory = header.toLowerCase();
      }
      continue;
    }

    // Task items
    const taskMatch = trimmed.match(/^[-*]\s*\[([ x~])\]\s*(.+)$/i);
    if (taskMatch) {
      const statusChar = taskMatch[1]!;
      let taskText = taskMatch[2]!.trim();
      
      let status: ParsedTask['status'] = 'pending';
      if (statusChar.toLowerCase() === 'x') status = 'completed';
      if (statusChar === '~') status = 'cancelled';

      // Extract [due: YYYY-MM-DD] tags
      let dueDate: string | undefined;
      const dueDateMatch = taskText.match(/\[due:\s*(\d{4}-\d{2}-\d{2})\]/i);
      if (dueDateMatch) {
        dueDate = dueDateMatch[1];
        taskText = taskText.replace(dueDateMatch[0], '').trim();
      }

      if (taskText.length > 0) {
        tasks.push({
          title: taskText,
          status,
          priority: currentPriority,
          due_date: dueDate,
          metadata: { source: 'TODO.md', category: currentCategory }
        });
      }
    }
  }

  return tasks;
}

// ============ LEARNINGS.MD PARSER ============

/**
 * Parse LEARNINGS.md into structured learnings
 * 
 * Expected format:
 * # LEARNINGS
 * 
 * ## Category: Corrections
 * 
 * **Trigger**: User said "actually, I prefer Rust"
 * **Lesson**: User prefers Rust over TypeScript
 * **Importance**: 0.8
 * 
 * ---
 * 
 * ## Category: Errors
 * ...
 */
export function parseLearningsMd(filePath: string): ParsedLearning[] {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const learnings: ParsedLearning[] = [];
  
  // Split by --- separators
  const blocks = content.split(/\n---+\n/);
  
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let category = 'general';
    let trigger = '';
    let lesson = '';
    let importance = 0.5;
    let createdAt: string | undefined;

    for (const line of lines) {
      const trimmed = line.trim();

      // Category header
      if (trimmed.startsWith('## ')) {
        const header = trimmed.slice(3).trim();
        const catMatch = header.match(/Category:\s*(.+)/i);
        if (catMatch) {
          category = catMatch[1]!.trim().toLowerCase();
        }
        continue;
      }

      // Field lines
      const triggerMatch = trimmed.match(/^\*\*Trigger\*\*:\s*(.+)/i);
      if (triggerMatch) {
        trigger = triggerMatch[1]!.trim();
        continue;
      }

      const lessonMatch = trimmed.match(/^\*\*Lesson\*\*:\s*(.+)/i);
      if (lessonMatch) {
        lesson = lessonMatch[1]!.trim();
        continue;
      }

      const importanceMatch = trimmed.match(/^\*\*Importance\*\*:\s*([\d.]+)/i);
      if (importanceMatch) {
        importance = parseFloat(importanceMatch[1]!);
        continue;
      }

      const dateMatch = trimmed.match(/^\*\*Date\*\*:\s*(\d{4}-\d{2}-\d{2})/i);
      if (dateMatch) {
        createdAt = dateMatch[1]!;
        continue;
      }
    }

    // Add if we have at minimum a lesson
    if (lesson.length > 0) {
      learnings.push({
        category,
        trigger: trigger || 'Unknown trigger',
        lesson,
        importance,
        created_at: createdAt
      });
    }
  }

  return learnings;
}
