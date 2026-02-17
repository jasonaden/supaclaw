/**
 * Tests for Phase 8: Tasks & Learnings (Steps 71-80)
 * - Task CRUD (already existed)
 * - Task dependencies
 * - Task templates
 * - Task reminders
 * - Learning patterns
 * - Learning similarity search
 * - Learning export/reports
 */

import { vi } from 'vitest';
import Supaclaw from '../src/index';

const hasSupabase = !!process.env['SUPABASE_URL'] && !!process.env['SUPABASE_KEY'];

const config = {
  supabaseUrl: process.env['SUPABASE_URL'] || 'http://localhost:54321',
  supabaseKey: process.env['SUPABASE_KEY'] || 'test-key',
  agentId: 'test-agent-tasks-learnings',
  openaiApiKey: process.env['OPENAI_API_KEY']
};

let memory: Supaclaw;

beforeAll(async () => {
  if (!hasSupabase) return;
  memory = new Supaclaw(config);
  await memory.initialize();
});

afterAll(async () => {
  // Clean up test data
  try {
    const tasks = await memory.getTasks({ limit: 1000 });
    for (const task of tasks) {
      await memory.deleteTask(task.id);
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
});

// ============ TASK DEPENDENCIES (Steps 71-73) ============

describe.skipIf(!hasSupabase)('Task Dependencies', () => {
  test('should add task dependency', async () => {
    const task1 = await memory.createTask({
      title: 'Task 1 - Must be done first',
      priority: 5
    });

    const task2 = await memory.createTask({
      title: 'Task 2 - Depends on Task 1',
      priority: 3
    });

    await memory.addTaskDependency(task2.id, task1.id);

    const dependencies = await memory.getTaskDependencies(task2.id);
    expect(dependencies).toHaveLength(1);
    expect(dependencies[0].id).toBe(task1.id);
  });

  test('should detect blocked tasks', async () => {
    const task1 = await memory.createTask({
      title: 'Dependency Task',
      status: 'pending',
      priority: 5
    });

    const task2 = await memory.createTask({
      title: 'Dependent Task',
      priority: 3
    });

    await memory.addTaskDependency(task2.id, task1.id);

    const blocked = await memory.isTaskBlocked(task2.id);
    expect(blocked).toBe(true);

    // Complete the dependency
    await memory.updateTask(task1.id, { status: 'done' });

    const stillBlocked = await memory.isTaskBlocked(task2.id);
    expect(stillBlocked).toBe(false);
  });

  test('should list ready tasks', async () => {
    const task1 = await memory.createTask({
      title: 'Ready Task (no deps)',
      status: 'pending',
      priority: 5
    });

    const task2 = await memory.createTask({
      title: 'Blocked Task',
      status: 'pending',
      priority: 3
    });

    const depTask = await memory.createTask({
      title: 'Blocker',
      status: 'pending',
      priority: 4
    });

    await memory.addTaskDependency(task2.id, depTask.id);

    const ready = await memory.getReadyTasks();
    const readyIds = ready.map(t => t.id);

    expect(readyIds).toContain(task1.id);
    expect(readyIds).not.toContain(task2.id);
  });

  test('should remove task dependency', async () => {
    const task1 = await memory.createTask({
      title: 'Dependency',
      priority: 5
    });

    const task2 = await memory.createTask({
      title: 'Dependent',
      priority: 3
    });

    await memory.addTaskDependency(task2.id, task1.id);
    await memory.removeTaskDependency(task2.id, task1.id);

    const dependencies = await memory.getTaskDependencies(task2.id);
    expect(dependencies).toHaveLength(0);
  });
});

// ============ TASK TEMPLATES (Steps 72, 75) ============

describe.skipIf(!hasSupabase)('Task Templates', () => {
  test('should create task template', async () => {
    const template = await memory.createTaskTemplate({
      name: 'Onboarding Template',
      description: 'Standard onboarding workflow',
      tasks: [
        { title: 'Send welcome email', priority: 5 },
        { title: 'Schedule intro call', priority: 4, dependencies: [0] },
        { title: 'Assign mentor', priority: 3, dependencies: [1] }
      ]
    });

    expect(template.id).toBeDefined();
  });

  test('should list task templates', async () => {
    await memory.createTaskTemplate({
      name: 'Testing Template',
      description: 'QA workflow',
      tasks: [
        { title: 'Write tests', priority: 5 },
        { title: 'Run tests', priority: 4, dependencies: [0] }
      ]
    });

    const templates = await memory.getTaskTemplates();
    expect(templates.length).toBeGreaterThan(0);
    
    const testTemplate = templates.find(t => t.name === 'Testing Template');
    expect(testTemplate).toBeDefined();
    expect(testTemplate!.tasks).toHaveLength(2);
  });

  test('should apply task template', async () => {
    const template = await memory.createTaskTemplate({
      name: 'Project Setup',
      description: 'Standard project setup',
      tasks: [
        { title: 'Create repository', priority: 5 },
        { title: 'Setup CI/CD', priority: 4, dependencies: [0] },
        { title: 'Write README', priority: 3, dependencies: [0] }
      ]
    });

    const createdTasks = await memory.applyTaskTemplate(template.id, {
      userId: 'test-user'
    });

    expect(createdTasks).toHaveLength(3);
    expect(createdTasks[0].title).toBe('Create repository');
    expect(createdTasks[1].title).toBe('Setup CI/CD');
    expect(createdTasks[2].title).toBe('Write README');

    // Verify dependencies were set
    const deps1 = await memory.getTaskDependencies(createdTasks[1].id);
    const deps2 = await memory.getTaskDependencies(createdTasks[2].id);

    expect(deps1).toHaveLength(1);
    expect(deps1[0].id).toBe(createdTasks[0].id);
    
    expect(deps2).toHaveLength(1);
    expect(deps2[0].id).toBe(createdTasks[0].id);
  });
});

// ============ TASK REMINDERS (Step 74) ============

describe.skipIf(!hasSupabase)('Task Reminders', () => {
  test('should get tasks needing reminders', async () => {
    const now = new Date();
    const soon = new Date(now.getTime() + 2 * 60 * 60 * 1000); // 2 hours from now
    const later = new Date(now.getTime() + 48 * 60 * 60 * 1000); // 48 hours from now

    const task1 = await memory.createTask({
      title: 'Due soon',
      dueAt: soon.toISOString(),
      priority: 5
    });

    const task2 = await memory.createTask({
      title: 'Due later',
      dueAt: later.toISOString(),
      priority: 3
    });

    const reminders = await memory.getTasksNeedingReminders({ hoursAhead: 24 });
    
    const reminderIds = reminders.map(t => t.id);
    expect(reminderIds).toContain(task1.id);
    expect(reminderIds).not.toContain(task2.id);
  });

  test('should format task reminder message', async () => {
    const task = await memory.createTask({
      title: 'Important meeting',
      description: 'Quarterly review',
      priority: 5
    });

    const timeUntilDue = 3 * 60 * 60 * 1000; // 3 hours
    const message = memory.formatTaskReminder(task, timeUntilDue);

    expect(message).toContain('Important meeting');
    expect(message).toContain('3h');
  });
});

// ============ LEARNING PATTERNS (Step 77) ============

describe.skipIf(!hasSupabase)('Learning Patterns', () => {
  test('should detect learning patterns', async () => {
    // Create some test learnings
    await memory.learn({
      category: 'error',
      trigger: 'Failed API call to service',
      lesson: 'Always check API status before calling',
      severity: 'critical'
    });

    await memory.learn({
      category: 'error',
      trigger: 'Failed database connection',
      lesson: 'Add connection retry logic',
      severity: 'warning'
    });

    await memory.learn({
      category: 'correction',
      trigger: 'User corrected preference',
      lesson: 'User prefers TypeScript over JavaScript',
      severity: 'info'
    });

    const patterns = await memory.detectLearningPatterns();

    expect(patterns.commonCategories).toBeDefined();
    expect(patterns.commonCategories.length).toBeGreaterThan(0);
    
    const errorCategory = patterns.commonCategories.find(c => c.category === 'error');
    expect(errorCategory).toBeDefined();
    expect(errorCategory!.count).toBeGreaterThanOrEqual(2);

    expect(patterns.commonTriggers).toBeDefined();
    expect(patterns.recentTrends).toBeDefined();
  });

  test('should get learning recommendations', async () => {
    await memory.learn({
      category: 'improvement',
      trigger: 'Slow database query',
      lesson: 'Add index on frequently queried columns',
      severity: 'warning'
    });

    await memory.learn({
      category: 'improvement',
      trigger: 'Database timeout',
      lesson: 'Optimize complex queries',
      severity: 'critical'
    });

    const recommendations = await memory.getLearningRecommendations('database', 3);

    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations[0].trigger).toMatch(/database/i);
  });
});

// ============ LEARNING SIMILARITY SEARCH (Step 79) ============

describe.skipIf(!hasSupabase)('Learning Similarity Search', () => {
  test('should find similar learnings (requires OpenAI)', async () => {
    if (!config.openaiApiKey) {
      console.warn('Skipping similarity test - no OpenAI API key');
      return;
    }

    const learning1 = await memory.learn({
      category: 'error',
      trigger: 'API rate limit exceeded',
      lesson: 'Implement exponential backoff',
      severity: 'warning'
    });

    await memory.learn({
      category: 'error',
      trigger: 'Too many requests to API',
      lesson: 'Add request throttling',
      severity: 'warning'
    });

    await memory.learn({
      category: 'correction',
      trigger: 'User prefers dark mode',
      lesson: 'Remember UI preferences',
      severity: 'info'
    });

    const similar = await memory.findSimilarLearnings(learning1.id, {
      threshold: 0.7,
      limit: 5
    });

    expect(similar.length).toBeGreaterThan(0);
    // The similar learning should be about rate limiting/API calls
    const hasRelated = similar.some(l => 
      l.trigger.toLowerCase().includes('api') || 
      l.trigger.toLowerCase().includes('request')
    );
    expect(hasRelated).toBe(true);
  });
});

// ============ LEARNING EXPORT/REPORT (Step 80) ============

describe.skipIf(!hasSupabase)('Learning Export & Reports', () => {
  test('should export learnings to markdown report', async () => {
    await memory.learn({
      category: 'error',
      trigger: 'Export test error',
      lesson: 'Test lesson for export',
      severity: 'info'
    });

    const report = await memory.exportLearningsReport({});

    expect(report).toContain('# Learning Report');
    expect(report).toContain('Total Learnings:');
    expect(report).toContain('## Patterns');
    expect(report).toContain('## All Learnings');
  });

  test('should export learnings to JSON', async () => {
    const data = await memory.exportLearningsJSON({
      category: 'error'
    });

    expect(data).toBeDefined();
    expect((data as any).generated).toBeDefined();
    expect((data as any).total).toBeGreaterThanOrEqual(0);
    expect((data as any).patterns).toBeDefined();
    expect((data as any).learnings).toBeDefined();
    expect(Array.isArray((data as any).learnings)).toBe(true);
  });

  test('should filter exported learnings by date', async () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    await memory.learn({
      category: 'improvement',
      trigger: 'Recent improvement',
      lesson: 'New lesson',
      severity: 'info'
    });

    const data = await memory.exportLearningsJSON({
      since: yesterday.toISOString()
    });

    expect((data as any).learnings.length).toBeGreaterThan(0);
    const allRecent = (data as any).learnings.every((l: any) => 
      new Date(l.created_at) >= yesterday
    );
    expect(allRecent).toBe(true);
  });
});

// ============ INTEGRATION TESTS ============

describe.skipIf(!hasSupabase)('Task & Learning Integration', () => {
  test('should track learnings from task failures', async () => {
    const task = await memory.createTask({
      title: 'Deploy to production',
      priority: 5
    });

    // Simulate a task failure and learning
    await memory.updateTask(task.id, { status: 'blocked' });
    
    const learning = await memory.learn({
      category: 'error',
      trigger: `Task ${task.id} blocked - missing environment variables`,
      lesson: 'Always verify env vars before deployment tasks',
      action: 'Create pre-deployment checklist',
      severity: 'critical',
      metadata: { task_id: task.id }
    });

    expect(learning.id).toBeDefined();
    expect(learning.trigger).toContain(task.id);
  });

  test('should apply learnings to improve task templates', async () => {
    // Create a learning about best practices
    await memory.learn({
      category: 'improvement',
      trigger: 'Forgot to add testing step in project setup',
      lesson: 'All project templates should include testing setup',
      action: 'Update project templates to include test frameworks',
      severity: 'warning'
    });

    // Create improved template based on learning
    const template = await memory.createTaskTemplate({
      name: 'Improved Project Setup',
      description: 'Includes testing (learned from past mistakes)',
      tasks: [
        { title: 'Create repository', priority: 5 },
        { title: 'Setup testing framework', priority: 4, dependencies: [0] },
        { title: 'Setup CI/CD', priority: 3, dependencies: [1] },
        { title: 'Write README', priority: 2, dependencies: [0] }
      ],
      metadata: { incorporates_learning: true }
    });

    const tasks = await memory.applyTaskTemplate(template.id);
    
    expect(tasks).toHaveLength(4);
    const testingTask = tasks.find(t => t.title.includes('testing'));
    expect(testingTask).toBeDefined();
  });
});
