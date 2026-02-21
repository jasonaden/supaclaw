import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import type { SupaclawConfig, Session, Message, Memory, Entity, Task, Learning, EntityRelationship, SupaclawDeps } from './types';

// Domain managers
import { SessionManager } from './sessions';
import { MemoryManager } from './memories';
import { EntityManager } from './entities';
import { TaskManager } from './tasks';
import { LearningManager } from './learnings';
import { MaintenanceManager } from './maintenance';
import { ContextBuilder } from './context-builder';

// Re-export all types for backward compatibility
export type { SupaclawConfig, Session, Message, Memory, Entity, Task, Learning, EntityRelationship, SupaclawDeps } from './types';

// Re-export domain managers
export { SessionManager } from './sessions';
export { MemoryManager } from './memories';
export { EntityManager } from './entities';
export { TaskManager } from './tasks';
export { LearningManager } from './learnings';
export { MaintenanceManager } from './maintenance';
export { ContextBuilder } from './context-builder';

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
  readonly context: ContextBuilder;

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

    // Instantiate MemoryManager first (needed for SessionManager)
    this.memories = new MemoryManager(deps);

    // Instantiate SessionManager with rememberFn callback
    const sessionDeps: SupaclawDeps = {
      ...deps,
      rememberFn: this.memories.remember.bind(this.memories)
    };
    this.sessions = new SessionManager(sessionDeps);

    // Instantiate remaining domain managers
    this.entities = new EntityManager(deps);
    this.tasks = new TaskManager(deps);
    this.learnings = new LearningManager(deps);
    this.maintenance = new MaintenanceManager(deps);

    // Instantiate context builder
    this.context = new ContextBuilder(
      this.supabase,
      this.sessions,
      this.memories,
      this.entities,
      this.learnings
    );
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

  // ============ CONTEXT DELEGATES ============

  async getContext(...args: Parameters<ContextBuilder['getContext']>) {
    return this.context.getContext(...args);
  }

  async buildOptimizedContext(...args: Parameters<ContextBuilder['buildOptimizedContext']>) {
    return this.context.buildOptimizedContext(...args);
  }

  async getSmartContext(...args: Parameters<ContextBuilder['getSmartContext']>) {
    return this.context.getSmartContext(...args);
  }

  async estimateSessionTokenUsage(sessionId: string) {
    return this.context.estimateSessionTokenUsage(sessionId);
  }

  async testContextBudgets(...args: Parameters<ContextBuilder['testContextBudgets']>) {
    return this.context.testContextBudgets(...args);
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
  RateLimitError
} from './error-handling';

export default Supaclaw;
