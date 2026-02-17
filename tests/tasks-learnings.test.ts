/**
 * Tests for Tasks & Learnings
 * Uses mock Supabase client (no real DB required)
 */

import { Supaclaw } from '../src/index';
import type { SupaclawDeps } from '../src/types';

// Mock Supabase client with configurable results
let mockSingleResult: { data: unknown; error: unknown } = { data: null, error: null };
let mockListResult: { data: unknown[]; error: unknown } = { data: [], error: null };
let mockRpcResult: { data: unknown; error: unknown } = { data: null, error: null };

const mockSupabase = {
  from: (_table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: () => chain,
      update: () => chain,
      delete: () => chain,
      eq: () => chain,
      neq: () => chain,
      lt: () => chain,
      gt: () => chain,
      gte: () => chain,
      lte: () => chain,
      is: () => chain,
      not: () => chain,
      in: () => chain,
      or: () => chain,
      ilike: () => chain,
      order: () => chain,
      limit: () => chain,
      range: () => chain,
      single: () => Promise.resolve(mockSingleResult),
      then: (fn: (val: typeof mockListResult) => void) => fn(mockListResult)
    };
    return chain;
  },
  rpc: () => Promise.resolve(mockRpcResult)
};

const makeDeps = (): SupaclawDeps => ({
  supabase: mockSupabase as any,
  agentId: 'test-agent',
  config: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseKey: 'test-key',
    agentId: 'test-agent',
    embeddingProvider: 'none'
  }
});

const mockTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  agent_id: 'test-agent',
  title: 'Test Task',
  description: 'A test task',
  status: 'pending',
  priority: 5,
  due_at: null,
  completed_at: null,
  parent_task_id: null,
  metadata: {},
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides
});

const mockLearning = (overrides: Record<string, unknown> = {}) => ({
  id: 'learning-1',
  agent_id: 'test-agent',
  category: 'error',
  trigger: 'Failed API call',
  lesson: 'Always check API status',
  action: 'Add status check',
  severity: 'warning',
  source_session_id: null,
  applied_count: 0,
  created_at: '2024-01-01T00:00:00Z',
  metadata: {},
  ...overrides
});

// ============ TASK DEPENDENCIES ============

describe('Task Dependencies', () => {
  let memory: Supaclaw;

  beforeEach(() => {
    mockSingleResult = { data: null, error: null };
    mockListResult = { data: [], error: null };
    mockRpcResult = { data: null, error: null };
    memory = new Supaclaw(makeDeps());
  });

  test('should create a task', async () => {
    mockSingleResult = { data: mockTask(), error: null };

    const task = await memory.createTask({ title: 'Task 1', priority: 5 });

    expect(task).toHaveProperty('id');
    expect(task).toHaveProperty('title');
    expect(task).toHaveProperty('status');
  });

  test('should update a task', async () => {
    mockSingleResult = {
      data: mockTask({ status: 'done', completed_at: '2024-01-02T00:00:00Z' }),
      error: null
    };

    const task = await memory.updateTask('task-1', { status: 'done' });

    expect(task).toHaveProperty('id');
    expect(task.status).toBe('done');
  });

  test('should add task dependency without error', async () => {
    mockSingleResult = { data: mockTask({ metadata: {} }), error: null };

    await expect(
      memory.addTaskDependency('task-2', 'task-1')
    ).resolves.not.toThrow();
  });

  test('should get task dependencies', async () => {
    mockSingleResult = {
      data: mockTask({ metadata: { dependencies: ['task-dep-1'] } }),
      error: null
    };
    mockListResult = {
      data: [mockTask({ id: 'task-dep-1', title: 'Dependency' })],
      error: null
    };

    const dependencies = await memory.getTaskDependencies('task-2');

    expect(Array.isArray(dependencies)).toBe(true);
  });

  test('should detect blocked tasks', async () => {
    mockSingleResult = {
      data: mockTask({ metadata: { dependencies: ['dep-1'] } }),
      error: null
    };
    mockListResult = {
      data: [mockTask({ id: 'dep-1', status: 'pending' })],
      error: null
    };

    const blocked = await memory.isTaskBlocked('task-2');

    expect(typeof blocked).toBe('boolean');
    expect(blocked).toBe(true);
  });

  test('should list ready tasks (no blocking deps)', async () => {
    mockListResult = {
      data: [mockTask({ id: 'task-ready', metadata: {} })],
      error: null
    };
    mockSingleResult = { data: mockTask({ id: 'task-ready', metadata: {} }), error: null };

    const ready = await memory.getReadyTasks();

    expect(Array.isArray(ready)).toBe(true);
    expect(ready.length).toBe(1);
  });

  test('should remove task dependency without error', async () => {
    mockSingleResult = {
      data: mockTask({ metadata: { dependencies: ['task-1'] } }),
      error: null
    };

    await expect(
      memory.removeTaskDependency('task-2', 'task-1')
    ).resolves.not.toThrow();
  });
});

// ============ TASK TEMPLATES ============

describe('Task Templates', () => {
  let memory: Supaclaw;

  beforeEach(() => {
    mockSingleResult = { data: null, error: null };
    mockListResult = { data: [], error: null };
    mockRpcResult = { data: null, error: null };
    memory = new Supaclaw(makeDeps());
  });

  test('should create task template', async () => {
    mockSingleResult = { data: mockTask({ id: 'template-1' }), error: null };

    const template = await memory.createTaskTemplate({
      name: 'Onboarding Template',
      description: 'Standard onboarding workflow',
      tasks: [
        { title: 'Send welcome email', priority: 5 },
        { title: 'Schedule intro call', priority: 4, dependencies: [0] }
      ]
    });

    expect(template).toHaveProperty('id');
  });

  test('should list task templates', async () => {
    mockListResult = {
      data: [
        mockTask({
          id: 'template-1',
          title: '[TEMPLATE] Testing Template',
          description: 'QA workflow',
          metadata: {
            is_template: true,
            template_data: {
              name: 'Testing Template',
              tasks: [
                { title: 'Write tests', priority: 5 },
                { title: 'Run tests', priority: 4, dependencies: [0] }
              ]
            }
          }
        })
      ],
      error: null
    };

    const templates = await memory.getTaskTemplates();

    expect(templates.length).toBe(1);
    expect(templates[0]).toHaveProperty('id');
    expect(templates[0]).toHaveProperty('name');
    expect(templates[0]).toHaveProperty('tasks');
    expect(templates[0]!.name).toBe('Testing Template');
    expect(templates[0]!.tasks).toHaveLength(2);
  });

  test('should apply task template', async () => {
    const templateTask = mockTask({
      id: 'template-1',
      title: '[TEMPLATE] Project Setup',
      metadata: {
        is_template: true,
        template_data: {
          name: 'Project Setup',
          tasks: [
            { title: 'Create repository', priority: 5 },
            { title: 'Setup CI/CD', priority: 4, dependencies: [0] }
          ]
        }
      }
    });

    mockSingleResult = { data: templateTask, error: null };

    const createdTasks = await memory.applyTaskTemplate('template-1');

    expect(createdTasks).toHaveLength(2);
    expect(createdTasks[0]).toHaveProperty('id');
    expect(createdTasks[1]).toHaveProperty('id');
  });
});

// ============ TASK REMINDERS ============

describe('Task Reminders', () => {
  let memory: Supaclaw;

  beforeEach(() => {
    mockSingleResult = { data: null, error: null };
    mockListResult = { data: [], error: null };
    mockRpcResult = { data: null, error: null };
    memory = new Supaclaw(makeDeps());
  });

  test('should get tasks needing reminders', async () => {
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    mockListResult = {
      data: [mockTask({ id: 'due-soon', title: 'Due soon', due_at: soon })],
      error: null
    };

    const reminders = await memory.getTasksNeedingReminders({ hoursAhead: 24 });

    expect(Array.isArray(reminders)).toBe(true);
  });

  test('should format task reminder message', () => {
    const task = mockTask({
      title: 'Important meeting',
      description: 'Quarterly review'
    }) as any;
    const timeUntilDue = 3 * 60 * 60 * 1000; // 3 hours

    const message = memory.formatTaskReminder(task, timeUntilDue);

    expect(message).toContain('Important meeting');
    expect(message).toContain('3h');
  });
});

// ============ LEARNING PATTERNS ============

describe('Learning Patterns', () => {
  let memory: Supaclaw;

  beforeEach(() => {
    mockSingleResult = { data: null, error: null };
    mockListResult = { data: [], error: null };
    mockRpcResult = { data: null, error: null };
    memory = new Supaclaw(makeDeps());
  });

  test('should record a learning', async () => {
    mockSingleResult = { data: mockLearning(), error: null };

    const learning = await memory.learn({
      category: 'error',
      trigger: 'Failed API call to service',
      lesson: 'Always check API status before calling',
      severity: 'critical'
    });

    expect(learning).toHaveProperty('id');
    expect(learning).toHaveProperty('category');
    expect(learning).toHaveProperty('trigger');
    expect(learning).toHaveProperty('lesson');
  });

  test('should detect learning patterns', async () => {
    mockListResult = {
      data: [
        mockLearning({ id: 'l1', category: 'error', trigger: 'Failed API call', severity: 'critical' }),
        mockLearning({ id: 'l2', category: 'error', trigger: 'Failed database connection', severity: 'warning' }),
        mockLearning({ id: 'l3', category: 'correction', trigger: 'User corrected preference', severity: 'info', applied_count: 3 })
      ],
      error: null
    };

    const patterns = await memory.detectLearningPatterns();

    expect(patterns).toHaveProperty('commonCategories');
    expect(patterns).toHaveProperty('commonTriggers');
    expect(patterns).toHaveProperty('recentTrends');
    expect(patterns).toHaveProperty('topLessons');
    expect(patterns.commonCategories.length).toBeGreaterThan(0);

    const errorCategory = patterns.commonCategories.find(c => c.category === 'error');
    expect(errorCategory).toBeDefined();
    expect(errorCategory!.count).toBe(2);
  });

  test('should get learning recommendations', async () => {
    mockListResult = {
      data: [
        mockLearning({ id: 'l1', trigger: 'Slow database query', lesson: 'Add index', severity: 'warning', applied_count: 2 }),
        mockLearning({ id: 'l2', trigger: 'Database timeout', lesson: 'Optimize queries', severity: 'critical', applied_count: 0 })
      ],
      error: null
    };

    const recommendations = await memory.getLearningRecommendations('database', 3);

    expect(Array.isArray(recommendations)).toBe(true);
    expect(recommendations.length).toBeGreaterThan(0);
  });
});

// ============ LEARNING EXPORT ============

describe('Learning Export & Reports', () => {
  let memory: Supaclaw;

  beforeEach(() => {
    mockSingleResult = { data: null, error: null };
    mockListResult = { data: [], error: null };
    mockRpcResult = { data: null, error: null };
    memory = new Supaclaw(makeDeps());
  });

  test('should export learnings to markdown report', async () => {
    mockListResult = {
      data: [
        mockLearning({ id: 'l1', category: 'error', trigger: 'Export test error', lesson: 'Test lesson' })
      ],
      error: null
    };

    const report = await memory.exportLearningsReport({});

    expect(report).toContain('# Learning Report');
    expect(report).toContain('Total Learnings:');
    expect(report).toContain('## Patterns');
    expect(report).toContain('## All Learnings');
  });

  test('should export learnings to JSON', async () => {
    mockListResult = {
      data: [mockLearning({ id: 'l1', category: 'error' })],
      error: null
    };

    const data = await memory.exportLearningsJSON({ category: 'error' });

    expect(data).toBeDefined();
    expect((data as any).generated).toBeDefined();
    expect((data as any).total).toBeGreaterThanOrEqual(0);
    expect((data as any).patterns).toBeDefined();
    expect((data as any).learnings).toBeDefined();
    expect(Array.isArray((data as any).learnings)).toBe(true);
  });

  test('should filter exported learnings by date', async () => {
    const recentDate = new Date().toISOString();
    mockListResult = {
      data: [mockLearning({ id: 'l1', created_at: recentDate })],
      error: null
    };

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
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

// ============ INTEGRATION ============

describe('Task & Learning Integration', () => {
  let memory: Supaclaw;

  beforeEach(() => {
    mockSingleResult = { data: null, error: null };
    mockListResult = { data: [], error: null };
    mockRpcResult = { data: null, error: null };
    memory = new Supaclaw(makeDeps());
  });

  test('should track learnings from task failures', async () => {
    const task = mockTask({ id: 'task-deploy', title: 'Deploy to production' });
    mockSingleResult = { data: task, error: null };

    const createdTask = await memory.createTask({ title: 'Deploy to production', priority: 5 });
    await memory.updateTask(createdTask.id, { status: 'blocked' });

    const learningData = mockLearning({
      trigger: `Task ${createdTask.id} blocked - missing environment variables`,
      severity: 'critical',
      metadata: { task_id: createdTask.id }
    });
    mockSingleResult = { data: learningData, error: null };

    const learning = await memory.learn({
      category: 'error',
      trigger: `Task ${createdTask.id} blocked - missing environment variables`,
      lesson: 'Always verify env vars before deployment tasks',
      action: 'Create pre-deployment checklist',
      severity: 'critical',
      metadata: { task_id: createdTask.id }
    });

    expect(learning.id).toBeDefined();
    expect(learning.trigger).toContain(createdTask.id);
  });

  test('should create task template based on learnings', async () => {
    mockSingleResult = { data: mockLearning(), error: null };
    await memory.learn({
      category: 'improvement',
      trigger: 'Forgot to add testing step',
      lesson: 'All project templates should include testing',
      severity: 'warning'
    });

    mockSingleResult = { data: mockTask({ id: 'improved-template-1' }), error: null };
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

    expect(template).toHaveProperty('id');
  });
});
