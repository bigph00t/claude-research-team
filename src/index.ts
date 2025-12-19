/**
 * Claude Research Team
 * Autonomous research agents for Claude Code
 *
 * Provides:
 * - Background research queue with priority management
 * - Passive context injection via Claude Code hooks
 * - Web UI dashboard for monitoring
 * - Optional claude-mem integration for cross-session persistence
 */

// Core exports
export { ResearchService } from './service/server.js';
export { QueueManager } from './queue/manager.js';
export { InjectionManager } from './injection/manager.js';
export { ResearchExecutor } from './crew/research-executor.js';

// New agents and crew
export { getSessionManager, SessionManager } from './service/session-manager.js';
export { getConversationWatcher, ConversationWatcher } from './agents/conversation-watcher.js';
export { getAutonomousCrew, AutonomousResearchCrew } from './crew/autonomous-crew.js';
export { CoordinatorAgent } from './agents/coordinator.js';
export * from './agents/specialists/index.js';

// Database
export { ResearchDatabase, getDatabase, closeDatabase } from './database/index.js';

// Utilities
export { Logger, setLogLevel, setLogFile } from './utils/logger.js';
export { ConfigManager, getConfig } from './utils/config.js';

// Sync
export { ClaudeMemSync, getClaudeMemSync } from './sync/claude-mem-sync.js';

// Types
export type {
  ResearchTask,
  ResearchResult,
  ResearchSource,
  ResearchDepth,
  ResearchStatus,
  TriggerSource,
  PivotSuggestion,
  InjectionRecord,
  InjectionBudget,
  Session,
  QueueStats,
  QueueConfig,
  Config,
  ServiceStatus,
  ApiResponse,
  HookContext,
  HookResult,
  UserPromptSubmitInput,
  PostToolUseInput,
} from './types.js';

export { DEFAULT_CONFIG } from './types.js';
