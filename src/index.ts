import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import {
  ContextBudget,
  ContextWindow,
  createContextBudget,
  createAdaptiveBudget,
  buildContextWindow,
  formatContextWindow,
  getContextStats,
  getBudgetForModel
} from './context-manager';
import type { SupaclawConfig, Session, Message, Memory, Entity, Task, Learning, EntityRelationship, SupaclawDeps } from './types';

// Domain managers
import { SessionManager } from './sessions';
import { MemoryManager } from './memories';
import { EntityManager } from './entities';
import { TaskManager } from './tasks';
import { LearningManager } from './learnings';
import { MaintenanceManager } from './maintenance';

// Re-export all types for backward compatibility
export type { SupaclawConfig, Session, Message, Memory, Entity, Task, Learning, EntityRelationship, SupaclawDeps } from './types';

// Re-export domain managers
export { SessionManager } from './sessions';
export { MemoryManager } from './memories';
export { EntityManager } from './entities';
export { TaskManager } from './tasks';
export { LearningManager } from './learnings';
export { MaintenanceManager } from './maintenance';

export class Supaclaw {
  private supabase: SupabaseClient;
  private agentId: string;
  private config: SupaclawConfig;
  private openai?: OpenAI;

  // Domain managers exposed as readonly properties
  readonly sessions: SessionManager;
  readonly memories: MemoryManager;
  readonly entities: EntityManager;
  readonly tasks: TaskManager;
  readonly learnings: LearningManager;
  readonly maintenance: MaintenanceManager;

  constructor(config: SupaclawConfig);
  constructor(deps: SupaclawDeps);
  constructor(configOrDeps: SupaclawConfig | SupaclawDeps) {
    if ('supabase' in configOrDeps) {
      // SupaclawDeps path (dependency injection)
      const deps = configOrDeps;
      this.supabase = deps.supabase;
      this.agentId = deps.agentId;
      this.config = deps.config;
      this.openai = deps.openai;
    } else {
      // SupaclawConfig path (original constructor)
      const config = configOrDeps;
      this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
      this.agentId = config.agentId;
      this.config = config;

      if (config.openaiApiKey) {
        this.openai = new OpenAI({ apiKey: config.openaiApiKey });
      }
    }

    // Build deps object for managers
    const deps: SupaclawDeps = {
      supabase: this.supabase,
      agentId: this.agentId,
      config: this.config,
      openai: this.openai,
    };

    // Instantiate domain managers
    this.sessions = new SessionManager(deps);
    this.memories = new MemoryManager(deps);
    this.entities = new EntityManager(deps);
    this.tasks = new TaskManager(deps);
    this.learnings = new LearningManager(deps);
    this.maintenance = new MaintenanceManager(deps);

    // Wire up cross-manager dependency: extractMemoriesFromSession needs remember()
    this.sessions.rememberFn = this.memories.remember.bind(this.memories);
  }

  /**
   * Initialize database tables (run once)
   */
  async initialize(): Promise<void> {
    // Tables are created via migration SQL files
    // This checks if tables exist
    const { error } = await this.supabase
      .from('sessions')
      .select('id')
      .limit(1);

    if (error && error.code === '42P01') {
      throw new Error(
        'Tables not found. Run migrations first: npx supaclaw migrate'
      );
    }
  }

  // ============ SESSION DELEGATES ============

  async startSession(opts: Parameters<SessionManager['startSession']>[0] = {}) {
    return this.sessions.startSession(opts);
  }

  async endSession(...args: Parameters<SessionManager['endSession']>) {
    return this.sessions.endSession(...args);
  }

  async generateSessionSummary(sessionId: string) {
    return this.sessions.generateSessionSummary(sessionId);
  }

  async resumeSession(sessionId: string) {
    return this.sessions.resumeSession(sessionId);
  }

  async searchSessions(opts: Parameters<SessionManager['searchSessions']>[0] = {}) {
    return this.sessions.searchSessions(opts);
  }

  async exportSessionToMarkdown(sessionId: string) {
    return this.sessions.exportSessionToMarkdown(sessionId);
  }

  async importSessionFromMarkdown(...args: Parameters<SessionManager['importSessionFromMarkdown']>) {
    return this.sessions.importSessionFromMarkdown(...args);
  }

  async extractMemoriesFromSession(...args: Parameters<SessionManager['extractMemoriesFromSession']>) {
    return this.sessions.extractMemoriesFromSession(...args);
  }

  async countSessionTokens(sessionId: string) {
    return this.sessions.countSessionTokens(sessionId);
  }

  async getSession(sessionId: string) {
    return this.sessions.getSession(sessionId);
  }

  async getRecentSessions(opts: Parameters<SessionManager['getRecentSessions']>[0] = {}) {
    return this.sessions.getRecentSessions(opts);
  }

  async addMessage(...args: Parameters<SessionManager['addMessage']>) {
    return this.sessions.addMessage(...args);
  }

  async getMessages(...args: Parameters<SessionManager['getMessages']>) {
    return this.sessions.getMessages(...args);
  }

  // ============ MEMORY DELEGATES ============

  async remember(memory: Parameters<MemoryManager['remember']>[0]) {
    return this.memories.remember(memory);
  }

  async recall(...args: Parameters<MemoryManager['recall']>) {
    return this.memories.recall(...args);
  }

  async hybridRecall(...args: Parameters<MemoryManager['hybridRecall']>) {
    return this.memories.hybridRecall(...args);
  }

  async forget(memoryId: string) {
    return this.memories.forget(memoryId);
  }

  async getMemories(opts: Parameters<MemoryManager['getMemories']>[0] = {}) {
    return this.memories.getMemories(opts);
  }

  async findSimilarMemories(...args: Parameters<MemoryManager['findSimilarMemories']>) {
    return this.memories.findSimilarMemories(...args);
  }

  async decayMemoryImportance(opts: Parameters<MemoryManager['decayMemoryImportance']>[0] = {}) {
    return this.memories.decayMemoryImportance(opts);
  }

  async consolidateMemories(opts: Parameters<MemoryManager['consolidateMemories']>[0] = {}) {
    return this.memories.consolidateMemories(opts);
  }

  async versionMemory(memoryId: string) {
    return this.memories.versionMemory(memoryId);
  }

  async getMemoryVersions(memoryId: string) {
    return this.memories.getMemoryVersions(memoryId);
  }

  async tagMemory(memoryId: string, tags: string[]) {
    return this.memories.tagMemory(memoryId, tags);
  }

  async untagMemory(memoryId: string, tags: string[]) {
    return this.memories.untagMemory(memoryId, tags);
  }

  async searchMemoriesByTags(...args: Parameters<MemoryManager['searchMemoriesByTags']>) {
    return this.memories.searchMemoriesByTags(...args);
  }

  // ============ ENTITY DELEGATES ============

  async extractEntities(...args: Parameters<EntityManager['extractEntities']>) {
    return this.entities.extractEntities(...args);
  }

  async createEntity(entity: Parameters<EntityManager['createEntity']>[0]) {
    return this.entities.createEntity(entity);
  }

  async updateEntity(...args: Parameters<EntityManager['updateEntity']>) {
    return this.entities.updateEntity(...args);
  }

  async findEntity(nameOrAlias: string) {
    return this.entities.findEntity(nameOrAlias);
  }

  async searchEntities(opts: Parameters<EntityManager['searchEntities']>[0] = {}) {
    return this.entities.searchEntities(opts);
  }

  async mergeEntities(primaryId: string, duplicateId: string) {
    return this.entities.mergeEntities(primaryId, duplicateId);
  }

  async createEntityRelationship(rel: Parameters<EntityManager['createEntityRelationship']>[0]) {
    return this.entities.createEntityRelationship(rel);
  }

  async getEntityRelationships(...args: Parameters<EntityManager['getEntityRelationships']>) {
    return this.entities.getEntityRelationships(...args);
  }

  async findRelatedEntities(...args: Parameters<EntityManager['findRelatedEntities']>) {
    return this.entities.findRelatedEntities(...args);
  }

  async getEntityNetworkStats() {
    return this.entities.getEntityNetworkStats();
  }

  async extractEntitiesWithRelationships(...args: Parameters<EntityManager['extractEntitiesWithRelationships']>) {
    return this.entities.extractEntitiesWithRelationships(...args);
  }

  async deleteEntityRelationship(relationshipId: string) {
    return this.entities.deleteEntityRelationship(relationshipId);
  }

  async searchRelationships(opts: Parameters<EntityManager['searchRelationships']>[0] = {}) {
    return this.entities.searchRelationships(opts);
  }

  // ============ TASK DELEGATES ============

  async createTask(task: Parameters<TaskManager['createTask']>[0]) {
    return this.tasks.createTask(task);
  }

  async updateTask(...args: Parameters<TaskManager['updateTask']>) {
    return this.tasks.updateTask(...args);
  }

  async getTasks(opts: Parameters<TaskManager['getTasks']>[0] = {}) {
    return this.tasks.getTasks(opts);
  }

  async deleteTask(taskId: string) {
    return this.tasks.deleteTask(taskId);
  }

  async getSubtasks(parentTaskId: string) {
    return this.tasks.getSubtasks(parentTaskId);
  }

  async getTaskWithSubtasks(taskId: string) {
    return this.tasks.getTaskWithSubtasks(taskId);
  }

  async getUpcomingTasks(opts: Parameters<TaskManager['getUpcomingTasks']>[0] = {}) {
    return this.tasks.getUpcomingTasks(opts);
  }

  async addTaskDependency(taskId: string, dependsOnTaskId: string) {
    return this.tasks.addTaskDependency(taskId, dependsOnTaskId);
  }

  async removeTaskDependency(taskId: string, dependsOnTaskId: string) {
    return this.tasks.removeTaskDependency(taskId, dependsOnTaskId);
  }

  async getTaskDependencies(taskId: string) {
    return this.tasks.getTaskDependencies(taskId);
  }

  async isTaskBlocked(taskId: string) {
    return this.tasks.isTaskBlocked(taskId);
  }

  async getReadyTasks(opts: Parameters<TaskManager['getReadyTasks']>[0] = {}) {
    return this.tasks.getReadyTasks(opts);
  }

  async createTaskTemplate(template: Parameters<TaskManager['createTaskTemplate']>[0]) {
    return this.tasks.createTaskTemplate(template);
  }

  async getTaskTemplates() {
    return this.tasks.getTaskTemplates();
  }

  async applyTaskTemplate(...args: Parameters<TaskManager['applyTaskTemplate']>) {
    return this.tasks.applyTaskTemplate(...args);
  }

  async getTasksNeedingReminders(opts: Parameters<TaskManager['getTasksNeedingReminders']>[0] = {}) {
    return this.tasks.getTasksNeedingReminders(opts);
  }

  formatTaskReminder(task: Task, timeUntilDue: number) {
    return this.tasks.formatTaskReminder(task, timeUntilDue);
  }

  // ============ LEARNING DELEGATES ============

  async learn(learning: Parameters<LearningManager['learn']>[0]) {
    return this.learnings.learn(learning);
  }

  async getLearnings(opts: Parameters<LearningManager['getLearnings']>[0] = {}) {
    return this.learnings.getLearnings(opts);
  }

  async searchLearnings(...args: Parameters<LearningManager['searchLearnings']>) {
    return this.learnings.searchLearnings(...args);
  }

  async applyLearning(learningId: string) {
    return this.learnings.applyLearning(learningId);
  }

  async detectLearningPatterns() {
    return this.learnings.detectLearningPatterns();
  }

  async getLearningRecommendations(context: string, limit?: number) {
    return this.learnings.getLearningRecommendations(context, limit);
  }

  async findSimilarLearnings(...args: Parameters<LearningManager['findSimilarLearnings']>) {
    return this.learnings.findSimilarLearnings(...args);
  }

  async exportLearningsReport(opts: Parameters<LearningManager['exportLearningsReport']>[0] = {}) {
    return this.learnings.exportLearningsReport(opts);
  }

  async exportLearningsJSON(opts: Parameters<LearningManager['exportLearningsJSON']>[0] = {}) {
    return this.learnings.exportLearningsJSON(opts);
  }

  // ============ MAINTENANCE DELEGATES ============

  async cleanupOldSessions(opts: Parameters<MaintenanceManager['cleanupOldSessions']>[0] = {}) {
    return this.maintenance.cleanupOldSessions(opts);
  }

  async getCleanupStats() {
    return this.maintenance.getCleanupStats();
  }

  // ============ CONTEXT (stays on facade) ============

  /**
   * Get relevant context for a query
   * Combines memories, recent messages, and entities
   */
  async getContext(query: string, opts: {
    userId?: string;
    sessionId?: string;
    maxMemories?: number;
    maxMessages?: number;
  } = {}): Promise<{
    memories: Memory[];
    recentMessages: Message[];
    summary: string;
  }> {
    // Get relevant memories
    const memoriesResult = await this.memories.recall(query, {
      userId: opts.userId,
      limit: opts.maxMemories || 5
    });

    // Get recent messages from current session
    let recentMessages: Message[] = [];
    if (opts.sessionId) {
      recentMessages = await this.sessions.getMessages(opts.sessionId, {
        limit: opts.maxMessages || 20
      });
    }

    // Build context summary
    const memoryText = memoriesResult
      .map(m => `- ${m.content}`)
      .join('\n');

    const summary = memoriesResult.length > 0
      ? `Relevant memories:\n${memoryText}`
      : 'No relevant memories found.';

    return { memories: memoriesResult, recentMessages, summary };
  }

  /**
   * Build an optimized context window with token budgeting
   * Implements smart context selection and lost-in-middle mitigation
   */
  async buildOptimizedContext(opts: {
    query: string;
    sessionId?: string;
    userId?: string;
    modelContextSize?: number;
    model?: string;
    useLostInMiddleFix?: boolean;
    recencyWeight?: number;
    importanceWeight?: number;
    customBudget?: ContextBudget;
  }): Promise<{
    window: ContextWindow;
    formatted: string;
    stats: ReturnType<typeof getContextStats>;
  }> {
    const {
      query,
      sessionId,
      userId,
      modelContextSize,
      model,
      useLostInMiddleFix = true,
      recencyWeight,
      importanceWeight,
      customBudget
    } = opts;

    // Fetch relevant data
    const [messages, memoriesResult, learningsResult, entitiesResult] = await Promise.all([
      sessionId ? this.sessions.getMessages(sessionId) : Promise.resolve([]),
      this.memories.recall(query, { userId, limit: 50 }),
      this.learnings.searchLearnings(query, { limit: 20 }),
      this.entities.searchEntities({ query, limit: 15 })
    ]);

    // Determine budget
    let budget: ContextBudget;
    if (customBudget) {
      budget = customBudget;
    } else if (model) {
      budget = getBudgetForModel(model);
    } else if (modelContextSize) {
      budget = createContextBudget({ modelContextSize });
    } else {
      // Adaptive budget based on available content
      budget = createAdaptiveBudget({
        messageCount: messages.length,
        memoryCount: memoriesResult.length,
        learningCount: learningsResult.length,
        entityCount: entitiesResult.length
      });
    }

    // Build context window
    const window = buildContextWindow({
      messages,
      memories: memoriesResult,
      learnings: learningsResult,
      entities: entitiesResult,
      budget,
      useLostInMiddleFix,
      recencyWeight,
      importanceWeight
    });

    // Format for prompt
    const formatted = formatContextWindow(window, {
      groupByType: true,
      includeMetadata: false
    });

    // Get stats
    const stats = getContextStats(window);

    return { window, formatted, stats };
  }

  /**
   * Get smart context with automatic budget management
   * Simplified version of buildOptimizedContext for common use cases
   */
  async getSmartContext(query: string, opts: {
    sessionId?: string;
    userId?: string;
    model?: string;
  } = {}): Promise<string> {
    const result = await this.buildOptimizedContext({
      query,
      sessionId: opts.sessionId,
      userId: opts.userId,
      model: opts.model || 'default'
    });

    return result.formatted;
  }

  /**
   * Estimate token usage for a session
   */
  async estimateSessionTokenUsage(sessionId: string): Promise<{
    messages: number;
    memories: number;
    total: number;
    contextSize: string;
  }> {
    const stats = await this.sessions.countSessionTokens(sessionId);

    // Get memories from this session
    const { data, error } = await this.supabase
      .from('memories')
      .select()
      .eq('source_session_id', sessionId);

    if (error) throw error;

    const memoryTokens = (data || []).reduce((sum: number, mem: { content: string }) => {
      return sum + (mem.content.length / 4); // Rough estimate
    }, 0);

    const total = stats.totalTokens + memoryTokens;

    // Determine context size needed
    let contextSize = '4k';
    if (total > 4000) contextSize = '8k';
    if (total > 8000) contextSize = '16k';
    if (total > 16000) contextSize = '32k';
    if (total > 32000) contextSize = '64k';
    if (total > 64000) contextSize = '128k';
    if (total > 128000) contextSize = '200k';

    return {
      messages: stats.totalTokens,
      memories: Math.round(memoryTokens),
      total: Math.round(total),
      contextSize
    };
  }

  /**
   * Test context window with different budgets
   * Useful for optimization and debugging
   */
  async testContextBudgets(query: string, opts: {
    sessionId?: string;
    userId?: string;
    models?: string[];
  } = {}): Promise<Array<{
    model: string;
    budget: ContextBudget;
    stats: ReturnType<typeof getContextStats>;
  }>> {
    const models = opts.models || ['gpt-3.5-turbo', 'gpt-4-turbo', 'claude-3.5-sonnet'];
    const results = [];

    for (const model of models) {
      const { window, stats } = await this.buildOptimizedContext({
        query,
        sessionId: opts.sessionId,
        userId: opts.userId,
        model
      });

      results.push({
        model,
        budget: window.budget,
        stats
      });
    }

    return results;
  }
}

// Re-export context manager utilities
export {
  ContextBudget,
  ContextWindow,
  ContextItem,
  createContextBudget,
  createAdaptiveBudget,
  buildContextWindow,
  formatContextWindow,
  getContextStats,
  getBudgetForModel,
  estimateTokens,
  estimateTokensAccurate
} from './context-manager';

// Export Clawdbot integration
export {
  ClawdbotMemoryIntegration,
  ClawdbotConfig,
  MessageContext,
  createClawdbotIntegration,
  createLoggingMiddleware
} from './clawdbot-integration';

// Export error handling utilities
export {
  SupaclawError,
  DatabaseError,
  EmbeddingError,
  ValidationError,
  RateLimitError,
  RetryOptions,
  CircuitBreaker,
  retry,
  wrapDatabaseOperation,
  wrapEmbeddingOperation,
  validateInput,
  safeJsonParse,
  withTimeout,
  gracefulFallback,
  batchWithErrorHandling
} from './error-handling';

export default Supaclaw;
