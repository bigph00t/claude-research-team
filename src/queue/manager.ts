/**
 * Queue Manager
 * Manages the research task queue with priority handling and concurrency control
 */

import { randomUUID } from 'crypto';
import type {
  ResearchTask,
  QueueConfig,
  QueueStats,
  TriggerSource,
  ResearchDepth,
} from '../types.js';
import { ResearchDatabase, getDatabase } from '../database/index.js';
import { ResearchExecutor } from '../crew/research-executor.js';
import { Logger } from '../utils/logger.js';
import { EventEmitter } from 'events';

export class QueueManager extends EventEmitter {
  private db: ResearchDatabase;
  private executor: ResearchExecutor;
  private logger: Logger;
  private config: QueueConfig;
  private running: Map<string, Promise<void>> = new Map();
  private processInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(config?: Partial<QueueConfig>) {
    super();
    this.db = getDatabase();
    this.executor = new ResearchExecutor();
    this.logger = new Logger('QueueManager');
    this.config = {
      maxConcurrent: config?.maxConcurrent ?? 2,
      maxQueueSize: config?.maxQueueSize ?? 20,
      taskTimeoutMs: config?.taskTimeoutMs ?? 120000,
      retryAttempts: config?.retryAttempts ?? 2,
    };
  }

  /**
   * Get the database instance
   */
  getDatabase(): ResearchDatabase {
    return this.db;
  }

  /**
   * Start the queue processor
   */
  start(): void {
    if (this.processInterval) {
      this.logger.warn('Queue already started');
      return;
    }

    this.logger.info('Starting queue processor', this.config);

    // Process queue every 2 seconds
    this.processInterval = setInterval(() => this.processQueue(), 2000);

    // Initial process
    this.processQueue();
  }

  /**
   * Stop the queue processor
   */
  stop(): void {
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
      this.logger.info('Queue processor stopped');
    }
  }

  /**
   * Queue a new research task
   */
  async queue(params: {
    query: string;
    context?: string;
    depth?: ResearchDepth;
    trigger: TriggerSource;
    sessionId?: string;
    priority?: number;
  }): Promise<ResearchTask> {
    const stats = this.db.getQueueStats();

    // Check queue size limit
    if (stats.queued >= this.config.maxQueueSize) {
      this.logger.warn('Queue is full, dropping task', { query: params.query });
      throw new Error('Queue is full');
    }

    // Check for duplicate queries (avoid redundant research)
    const existingTasks = this.db.searchTasks(params.query, 5);
    const recentDuplicate = existingTasks.find(
      (t) =>
        t.status !== 'failed' &&
        t.createdAt > Date.now() - 300000 && // Within 5 minutes
        this.isSimilarQuery(t.query, params.query)
    );

    if (recentDuplicate) {
      this.logger.info('Duplicate task found, reusing', { existingId: recentDuplicate.id });
      return recentDuplicate;
    }

    // Create the task
    const task = this.db.createTask({
      id: randomUUID(),
      query: params.query,
      context: params.context,
      depth: params.depth || 'medium',
      status: 'queued',
      trigger: params.trigger,
      sessionId: params.sessionId,
      priority: params.priority || 5,
    });

    this.logger.info('Task queued', { id: task.id, query: task.query });
    this.emit('taskQueued', task);

    return task;
  }

  /**
   * Process the queue
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      // Check how many slots are available
      const availableSlots = this.config.maxConcurrent - this.running.size;
      if (availableSlots <= 0) return;

      // Get queued tasks
      const queuedTasks = this.db.getQueuedTasks(availableSlots);
      if (queuedTasks.length === 0) {
        if (this.running.size === 0) {
          // Queue is completely drained
          this.emit('queueDrained');
        }
        return;
      }

      // Start tasks
      for (const task of queuedTasks) {
        const promise = this.processTask(task);
        this.running.set(task.id, promise);

        // Clean up when done
        promise.finally(() => {
          this.running.delete(task.id);
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single task
   */
  private async processTask(task: ResearchTask): Promise<void> {
    this.logger.info('Starting task', { id: task.id, query: task.query });

    // Update status to running
    this.db.updateTaskStatus(task.id, 'running', { startedAt: Date.now() });
    task.status = 'running';
    this.emit('taskStarted', task);

    let attempts = 0;
    let lastError: Error | null = null;

    while (attempts < this.config.retryAttempts) {
      attempts++;

      try {
        // Execute with timeout
        const result = await Promise.race([
          this.executor.execute(task),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Task timeout')), this.config.taskTimeoutMs)
          ),
        ]);

        // Save result
        this.db.saveTaskResult(task.id, result);
        task.result = result;
        task.status = 'completed';

        this.logger.info('Task completed', { id: task.id, tokensUsed: result.tokensUsed });
        this.emit('taskCompleted', task, result);

        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(`Task attempt ${attempts} failed`, { id: task.id, error: lastError.message });

        if (attempts < this.config.retryAttempts) {
          // Wait before retry (exponential backoff)
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
        }
      }
    }

    // All retries failed
    this.db.updateTaskStatus(task.id, 'failed', {
      completedAt: Date.now(),
      error: lastError?.message || 'Unknown error',
    });
    task.status = 'failed';
    task.error = lastError?.message;

    this.logger.error('Task failed after retries', { id: task.id, error: lastError?.message });
    this.emit('taskFailed', task, lastError!);
  }

  /**
   * Check if two queries are similar (basic duplicate detection)
   */
  private isSimilarQuery(q1: string, q2: string): boolean {
    // Normalize queries
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .sort()
        .join(' ');

    const n1 = normalize(q1);
    const n2 = normalize(q2);

    // Exact match after normalization
    if (n1 === n2) return true;

    // Check word overlap (Jaccard similarity)
    const words1 = new Set(n1.split(' '));
    const words2 = new Set(n2.split(' '));
    const intersection = new Set([...words1].filter((w) => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    const similarity = intersection.size / union.size;

    return similarity > 0.8;
  }

  /**
   * Get current queue statistics
   */
  getStats(): QueueStats {
    return this.db.getQueueStats();
  }

  /**
   * Get a specific task
   */
  getTask(id: string): ResearchTask | null {
    return this.db.getTask(id);
  }

  /**
   * Get recent tasks
   */
  getRecentTasks(limit: number = 50): ResearchTask[] {
    return this.db.getRecentTasks(limit);
  }

  /**
   * Search tasks by query
   */
  searchTasks(query: string, limit: number = 20): ResearchTask[] {
    return this.db.searchTasks(query, limit);
  }

  /**
   * Get tasks ready for injection (completed but not yet injected)
   */
  getInjectableTasks(sessionId: string): ResearchTask[] {
    return this.db
      .getRecentTasks(20)
      .filter(
        (t) =>
          t.status === 'completed' &&
          t.sessionId === sessionId &&
          t.result
      );
  }
}
