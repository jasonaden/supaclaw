/**
 * Tests for Phase 9 parsers
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import {
  parseMemoryMd,
  parseDailyLog,
  parseAllDailyLogs,
  parseTodoMd,
  parseLearningsMd
} from '../src/parsers';

const TEST_DIR = join(__dirname, '__test_files__');

describe('Phase 9: Parsers', () => {
  beforeEach(() => {
    // Create test directory
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch {}
  });

  describe('parseMemoryMd', () => {
    it('should parse basic memories from MEMORY.md', () => {
      const content = `# MEMORY.md

## Preferences

- User prefers TypeScript over JavaScript
- Likes concise code without comments

## Projects

- Working on Supaclaw database
- Building AI agents
`;

      const filePath = join(TEST_DIR, 'MEMORY.md');
      writeFileSync(filePath, content, 'utf-8');

      const memories = parseMemoryMd(filePath);

      expect(memories.length).toBeGreaterThan(0);
      expect(memories.some(m => m.content.includes('TypeScript'))).toBe(true);
      expect(memories.some(m => m.category === 'preferences')).toBe(true);
      expect(memories.some(m => m.category === 'projects')).toBe(true);
    });

    it('should parse importance tags', () => {
      const content = `# MEMORY.md

## Important

- Critical setting [importance: 0.9]
- Medium priority item [importance: 0.5]
`;

      const filePath = join(TEST_DIR, 'MEMORY.md');
      writeFileSync(filePath, content, 'utf-8');

      const memories = parseMemoryMd(filePath);

      const critical = memories.find(m => m.content.includes('Critical'));
      expect(critical?.importance).toBe(0.9);

      const medium = memories.find(m => m.content.includes('Medium'));
      expect(medium?.importance).toBe(0.5);
    });

    it('should parse date tags', () => {
      const content = `# MEMORY.md

## Events

- Project started [2024-01-28]
- Feature completed [2024-02-01]
`;

      const filePath = join(TEST_DIR, 'MEMORY.md');
      writeFileSync(filePath, content, 'utf-8');

      const memories = parseMemoryMd(filePath);

      const started = memories.find(m => m.content.includes('started'));
      expect(started?.created_at).toBe('2024-01-28');

      const completed = memories.find(m => m.content.includes('completed'));
      expect(completed?.created_at).toBe('2024-02-01');
    });

    it('should handle paragraphs as memories', () => {
      const content = `# MEMORY.md

## Notes

This is a longer memory that spans multiple lines.
It should be combined into a single paragraph memory.

This is another separate paragraph that should be
treated as a distinct memory.
`;

      const filePath = join(TEST_DIR, 'MEMORY.md');
      writeFileSync(filePath, content, 'utf-8');

      const memories = parseMemoryMd(filePath);

      expect(memories.length).toBe(2);
      expect(memories[0].content).toContain('longer memory');
      expect(memories[1].content).toContain('separate paragraph');
    });
  });

  describe('parseDailyLog', () => {
    it('should parse sessions from daily log', () => {
      const content = `# 2024-01-28

## Session: Trading Research
Started: 09:00

**User**: What's the stock price of TSLA?

**Assistant**: Tesla is currently trading at $245.

**User**: Should I buy?

**Assistant**: Based on the analysis, it's a good entry point.

Summary: Discussed TSLA stock price and buy recommendation.
`;

      const filePath = join(TEST_DIR, '2024-01-28.md');
      writeFileSync(filePath, content, 'utf-8');

      const sessions = parseDailyLog(filePath, 'han');

      expect(sessions.length).toBe(1);
      expect(sessions[0].user_id).toBe('han');
      expect(sessions[0].messages.length).toBe(4);
      expect(sessions[0].messages[0].role).toBe('user');
      expect(sessions[0].messages[0].content).toContain('TSLA');
      expect(sessions[0].summary).toBe('Discussed TSLA stock price and buy recommendation.');
    });

    it('should handle multiple sessions', () => {
      const content = `# 2024-01-28

## Session: Morning Check
Started: 08:00

**User**: Good morning!

**Assistant**: Good morning! How can I help?

## Session: Stock Research
Started: 10:00

**User**: Check AAPL price

**Assistant**: Apple is at $180.
`;

      const filePath = join(TEST_DIR, '2024-01-28.md');
      writeFileSync(filePath, content, 'utf-8');

      const sessions = parseDailyLog(filePath, 'han');

      expect(sessions.length).toBe(2);
      expect(sessions[0].summary).toBe('Morning Check');
      expect(sessions[1].summary).toBe('Stock Research');
    });

    it('should extract date from filename', () => {
      const content = `**User**: Hello

**Assistant**: Hi there!`;

      const filePath = join(TEST_DIR, '2024-02-01.md');
      writeFileSync(filePath, content, 'utf-8');

      const sessions = parseDailyLog(filePath, 'han');

      expect(sessions[0].started_at).toContain('2024-02-01');
    });
  });

  describe('parseAllDailyLogs', () => {
    it('should parse multiple daily log files', () => {
      const memoryDir = join(TEST_DIR, 'memory');
      mkdirSync(memoryDir, { recursive: true });

      writeFileSync(join(memoryDir, '2024-01-28.md'), `
## Session: Day 1

**User**: First day

**Assistant**: Welcome!
`, 'utf-8');

      writeFileSync(join(memoryDir, '2024-01-29.md'), `
## Session: Day 2

**User**: Second day

**Assistant**: Great to see you again!
`, 'utf-8');

      const sessions = parseAllDailyLogs(memoryDir, 'han');

      expect(sessions.length).toBe(2);
      expect(sessions[0].started_at).toContain('2024-01-28');
      expect(sessions[1].started_at).toContain('2024-01-29');
    });

    it('should skip invalid files', () => {
      const memoryDir = join(TEST_DIR, 'memory');
      mkdirSync(memoryDir, { recursive: true });

      writeFileSync(join(memoryDir, '2024-01-28.md'), `**User**: Valid`, 'utf-8');
      writeFileSync(join(memoryDir, 'README.md'), `# Not a daily log`, 'utf-8');
      writeFileSync(join(memoryDir, 'notes.txt'), `Random notes`, 'utf-8');

      const sessions = parseAllDailyLogs(memoryDir, 'han');

      expect(sessions.length).toBe(1);
    });
  });

  describe('parseTodoMd', () => {
    it('should parse tasks with different statuses', () => {
      const content = `# TODO

- [ ] Incomplete task
- [x] Completed task
- [~] Cancelled task
`;

      const filePath = join(TEST_DIR, 'TODO.md');
      writeFileSync(filePath, content, 'utf-8');

      const tasks = parseTodoMd(filePath);

      expect(tasks.length).toBe(3);
      expect(tasks[0].status).toBe('pending');
      expect(tasks[1].status).toBe('completed');
      expect(tasks[2].status).toBe('cancelled');
    });

    it('should parse priority sections', () => {
      const content = `# TODO

## Priority: High

- [ ] Urgent task

## Priority: Medium

- [ ] Normal task

## Priority: Low

- [ ] Minor task
`;

      const filePath = join(TEST_DIR, 'TODO.md');
      writeFileSync(filePath, content, 'utf-8');

      const tasks = parseTodoMd(filePath);

      expect(tasks[0].priority).toBe(3); // High
      expect(tasks[1].priority).toBe(2); // Medium
      expect(tasks[2].priority).toBe(1); // Low
    });

    it('should parse due dates', () => {
      const content = `# TODO

- [ ] Task with deadline [due: 2024-02-15]
- [ ] Another task [due: 2024-03-01]
`;

      const filePath = join(TEST_DIR, 'TODO.md');
      writeFileSync(filePath, content, 'utf-8');

      const tasks = parseTodoMd(filePath);

      expect(tasks[0].due_date).toBe('2024-02-15');
      expect(tasks[1].due_date).toBe('2024-03-01');
    });

    it('should handle categories', () => {
      const content = `# TODO

## Work

- [ ] Work task

## Personal

- [ ] Personal task
`;

      const filePath = join(TEST_DIR, 'TODO.md');
      writeFileSync(filePath, content, 'utf-8');

      const tasks = parseTodoMd(filePath);

      expect(tasks[0].metadata?.category).toBe('work');
      expect(tasks[1].metadata?.category).toBe('personal');
    });
  });

  describe('parseLearningsMd', () => {
    it('should parse learnings from LEARNINGS.md', () => {
      const content = `# LEARNINGS

## Category: Corrections

**Trigger**: User said "actually, I prefer Rust"
**Lesson**: User prefers Rust over TypeScript
**Importance**: 0.8

---

## Category: Errors

**Trigger**: Command failed with exit code 1
**Lesson**: Always check file existence before reading
**Importance**: 0.6
`;

      const filePath = join(TEST_DIR, 'LEARNINGS.md');
      writeFileSync(filePath, content, 'utf-8');

      const learnings = parseLearningsMd(filePath);

      expect(learnings.length).toBe(2);
      expect(learnings[0].category).toBe('corrections');
      expect(learnings[0].trigger).toContain('prefer Rust');
      expect(learnings[0].lesson).toContain('Rust over TypeScript');
      expect(learnings[0].importance).toBe(0.8);

      expect(learnings[1].category).toBe('errors');
      expect(learnings[1].trigger).toContain('exit code 1');
    });

    it('should handle optional date field', () => {
      const content = `# LEARNINGS

## Category: Improvement

**Date**: 2024-01-28
**Trigger**: Noticed inefficiency in code
**Lesson**: Use caching to improve performance
**Importance**: 0.7
`;

      const filePath = join(TEST_DIR, 'LEARNINGS.md');
      writeFileSync(filePath, content, 'utf-8');

      const learnings = parseLearningsMd(filePath);

      expect(learnings[0].created_at).toBe('2024-01-28');
    });

    it('should skip blocks without lesson', () => {
      const content = `# LEARNINGS

## Category: Invalid

**Trigger**: Some trigger
**Importance**: 0.5

---

## Category: Valid

**Trigger**: Another trigger
**Lesson**: This one has a lesson
`;

      const filePath = join(TEST_DIR, 'LEARNINGS.md');
      writeFileSync(filePath, content, 'utf-8');

      const learnings = parseLearningsMd(filePath);

      expect(learnings.length).toBe(1);
      expect(learnings[0].category).toBe('valid');
    });

    it('should use default trigger if missing', () => {
      const content = `# LEARNINGS

## Category: Test

**Lesson**: Lesson without explicit trigger
`;

      const filePath = join(TEST_DIR, 'LEARNINGS.md');
      writeFileSync(filePath, content, 'utf-8');

      const learnings = parseLearningsMd(filePath);

      expect(learnings[0].trigger).toBe('Unknown trigger');
    });
  });
});
