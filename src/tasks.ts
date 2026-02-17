import { SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import type { SupaclawDeps, SupaclawConfig, Task } from './types';

export class TaskManager {
  private supabase: SupabaseClient;
  private agentId: string;
  private config: SupaclawConfig;
  private openai?: OpenAI;

  constructor(deps: SupaclawDeps) {
    this.supabase = deps.supabase;
    this.agentId = deps.agentId;
    this.config = deps.config;
    this.openai = deps.openai;
  }

  /**
   * Create a task
   */
  async createTask(task: {
    title: string;
    description?: string;
    priority?: number;
    dueAt?: string;
    userId?: string;
    parentTaskId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Task> {
    const { data, error } = await this.supabase
      .from('tasks')
      .insert({
        agent_id: this.agentId,
        user_id: task.userId,
        title: task.title,
        description: task.description,
        priority: task.priority ?? 0,
        due_at: task.dueAt,
        parent_task_id: task.parentTaskId,
        metadata: task.metadata || {}
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Update a task
   */
  async updateTask(taskId: string, updates: Partial<{
    title: string;
    description: string;
    status: 'pending' | 'in_progress' | 'blocked' | 'done';
    priority: number;
    dueAt: string;
    metadata: Record<string, unknown>;
  }>): Promise<Task> {
    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    };

    if (updates.title !== undefined) updateData['title'] = updates.title;
    if (updates.description !== undefined) updateData['description'] = updates.description;
    if (updates.status !== undefined) {
      updateData['status'] = updates.status;
      if (updates.status === 'done') {
        updateData['completed_at'] = new Date().toISOString();
      }
    }
    if (updates.priority !== undefined) updateData['priority'] = updates.priority;
    if (updates.dueAt !== undefined) updateData['due_at'] = updates.dueAt;
    if (updates.metadata !== undefined) updateData['metadata'] = updates.metadata;

    const { data, error } = await this.supabase
      .from('tasks')
      .update(updateData)
      .eq('id', taskId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Get tasks
   */
  async getTasks(opts: {
    status?: string;
    userId?: string;
    limit?: number;
  } = {}): Promise<Task[]> {
    let query = this.supabase
      .from('tasks')
      .select()
      .eq('agent_id', this.agentId)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(opts.limit || 50);

    if (opts.status) {
      query = query.eq('status', opts.status);
    }
    if (opts.userId) {
      query = query.eq('user_id', opts.userId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId: string): Promise<void> {
    const { error } = await this.supabase
      .from('tasks')
      .delete()
      .eq('id', taskId);

    if (error) throw error;
  }

  /**
   * Get subtasks of a parent task
   */
  async getSubtasks(parentTaskId: string): Promise<Task[]> {
    const { data, error } = await this.supabase
      .from('tasks')
      .select()
      .eq('parent_task_id', parentTaskId)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Get task with all its subtasks (hierarchical)
   */
  async getTaskWithSubtasks(taskId: string): Promise<{
    task: Task;
    subtasks: Task[];
  }> {
    const task = await this.supabase
      .from('tasks')
      .select()
      .eq('id', taskId)
      .single();

    if (task.error) throw task.error;

    const subtasks = await this.getSubtasks(taskId);

    return {
      task: task.data,
      subtasks
    };
  }

  /**
   * Get upcoming tasks (due soon)
   */
  async getUpcomingTasks(opts: {
    userId?: string;
    hoursAhead?: number;
  } = {}): Promise<Task[]> {
    const now = new Date();
    const future = new Date(now.getTime() + (opts.hoursAhead || 24) * 60 * 60 * 1000);

    let query = this.supabase
      .from('tasks')
      .select()
      .eq('agent_id', this.agentId)
      .neq('status', 'done')
      .not('due_at', 'is', null)
      .gte('due_at', now.toISOString())
      .lte('due_at', future.toISOString())
      .order('due_at', { ascending: true });

    if (opts.userId) {
      query = query.eq('user_id', opts.userId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  /**
   * Add a task dependency (taskId depends on dependsOnTaskId)
   */
  async addTaskDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    // Store in metadata
    const task = await this.supabase
      .from('tasks')
      .select()
      .eq('id', taskId)
      .single();

    if (task.error) throw task.error;

    const dependencies = (task.data.metadata?.dependencies as string[]) || [];
    if (!dependencies.includes(dependsOnTaskId)) {
      dependencies.push(dependsOnTaskId);
    }

    await this.supabase
      .from('tasks')
      .update({
        metadata: {
          ...task.data.metadata,
          dependencies
        }
      })
      .eq('id', taskId);
  }

  /**
   * Remove a task dependency
   */
  async removeTaskDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    const task = await this.supabase
      .from('tasks')
      .select()
      .eq('id', taskId)
      .single();

    if (task.error) throw task.error;

    const dependencies = (task.data.metadata?.dependencies as string[]) || [];
    const filtered = dependencies.filter(id => id !== dependsOnTaskId);

    await this.supabase
      .from('tasks')
      .update({
        metadata: {
          ...task.data.metadata,
          dependencies: filtered
        }
      })
      .eq('id', taskId);
  }

  /**
   * Get task dependencies
   */
  async getTaskDependencies(taskId: string): Promise<Task[]> {
    const task = await this.supabase
      .from('tasks')
      .select()
      .eq('id', taskId)
      .single();

    if (task.error) throw task.error;

    const dependencyIds = (task.data.metadata?.dependencies as string[]) || [];
    if (dependencyIds.length === 0) return [];

    const { data, error } = await this.supabase
      .from('tasks')
      .select()
      .in('id', dependencyIds);

    if (error) throw error;
    return data || [];
  }

  /**
   * Check if a task is blocked by uncompleted dependencies
   */
  async isTaskBlocked(taskId: string): Promise<boolean> {
    const dependencies = await this.getTaskDependencies(taskId);
    return dependencies.some(dep => dep.status !== 'done');
  }

  /**
   * Get tasks that are ready to start (no blocking dependencies)
   */
  async getReadyTasks(opts: {
    userId?: string;
  } = {}): Promise<Task[]> {
    const tasks = await this.getTasks({ status: 'pending', userId: opts.userId });
    const ready: Task[] = [];

    for (const task of tasks) {
      const blocked = await this.isTaskBlocked(task.id);
      if (!blocked) {
        ready.push(task);
      }
    }

    return ready;
  }

  /**
   * Create a task template
   */
  async createTaskTemplate(template: {
    name: string;
    description?: string;
    tasks: Array<{
      title: string;
      description?: string;
      priority?: number;
      estimatedDuration?: string;
      dependencies?: number[]; // Indexes of other tasks in this template
    }>;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    // Store as a special task with metadata flag
    const { data, error } = await this.supabase
      .from('tasks')
      .insert({
        agent_id: this.agentId,
        title: `[TEMPLATE] ${template.name}`,
        description: template.description,
        status: 'pending',
        priority: -1, // Templates have negative priority
        metadata: {
          is_template: true,
          template_data: template,
          ...template.metadata
        }
      })
      .select()
      .single();

    if (error) throw error;
    return { id: data.id };
  }

  /**
   * Get all task templates
   */
  async getTaskTemplates(): Promise<Array<{
    id: string;
    name: string;
    description?: string;
    tasks: Array<{
      title: string;
      description?: string;
      priority?: number;
      estimatedDuration?: string;
      dependencies?: number[];
    }>;
  }>> {
    const { data, error } = await this.supabase
      .from('tasks')
      .select()
      .eq('agent_id', this.agentId)
      .eq('metadata->>is_template', 'true');

    if (error) throw error;

    return (data || []).map(task => ({
      id: task.id,
      name: task.title.replace('[TEMPLATE] ', ''),
      description: task.description,
      tasks: ((task.metadata?.template_data as Record<string, unknown> | undefined)?.['tasks'] as { title: string; description?: string; priority?: number; estimatedDuration?: string; dependencies?: number[]; }[]) || []
    }));
  }

  /**
   * Apply a task template (create all tasks from template)
   */
  async applyTaskTemplate(templateId: string, opts: {
    userId?: string;
    startDate?: string;
    metadata?: Record<string, unknown>;
  } = {}): Promise<Task[]> {
    const template = await this.supabase
      .from('tasks')
      .select()
      .eq('id', templateId)
      .single();

    if (template.error) throw template.error;

    const templateData = template.data.metadata?.template_data as Record<string, unknown> | undefined;
    if (!templateData?.['tasks']) {
      throw new Error('Invalid template data');
    }

    const tasksList = templateData['tasks'] as { title: string; description?: string; priority?: number; estimatedDuration?: string; dependencies?: number[]; }[];

    const createdTasks: Task[] = [];
    const taskIdMap = new Map<number, string>(); // template index -> created task id

    // Create all tasks first
    for (let i = 0; i < tasksList.length; i++) {
      const taskDef = tasksList[i]!;

      let dueAt: string | undefined;
      if (opts.startDate && taskDef.estimatedDuration) {
        // Calculate due date based on start date + duration
        const start = new Date(opts.startDate);
        const durationHours = parseInt(taskDef.estimatedDuration) || 24;
        dueAt = new Date(start.getTime() + durationHours * 60 * 60 * 1000).toISOString();
      }

      const task = await this.createTask({
        title: taskDef.title,
        description: taskDef.description,
        priority: taskDef.priority || 0,
        dueAt,
        userId: opts.userId,
        metadata: {
          from_template: templateId,
          template_index: i,
          ...opts.metadata
        }
      });

      createdTasks.push(task);
      taskIdMap.set(i, task.id);
    }

    // Now add dependencies
    for (let i = 0; i < tasksList.length; i++) {
      const taskDef = tasksList[i]!;
      if (taskDef.dependencies && taskDef.dependencies.length > 0) {
        const taskId = taskIdMap.get(i);
        if (taskId) {
          for (const depIndex of taskDef.dependencies) {
            const depId = taskIdMap.get(depIndex);
            if (depId) {
              await this.addTaskDependency(taskId, depId);
            }
          }
        }
      }
    }

    return createdTasks;
  }

  /**
   * Get tasks that need reminders (due soon but not done)
   */
  async getTasksNeedingReminders(opts: {
    userId?: string;
    hoursAhead?: number;
  } = {}): Promise<Array<Task & { timeUntilDue: number }>> {
    const tasks = await this.getUpcomingTasks({
      userId: opts.userId,
      hoursAhead: opts.hoursAhead || 24
    });

    const now = Date.now();
    return tasks.map(task => ({
      ...task,
      timeUntilDue: task.due_at ? new Date(task.due_at).getTime() - now : 0
    })).filter(task => task.timeUntilDue > 0);
  }

  /**
   * Format task reminder message
   */
  formatTaskReminder(task: Task, timeUntilDue: number): string {
    const hours = Math.floor(timeUntilDue / (60 * 60 * 1000));
    const minutes = Math.floor((timeUntilDue % (60 * 60 * 1000)) / (60 * 1000));

    let timeStr = '';
    if (hours > 0) {
      timeStr = `${hours}h ${minutes}m`;
    } else {
      timeStr = `${minutes}m`;
    }

    return `\u23F0 Task reminder: "${task.title}" is due in ${timeStr}\n${task.description || ''}`;
  }
}
