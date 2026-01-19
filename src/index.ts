/**
 * Claude Research Team
 * Research agents for Claude Code via /research skill
 *
 * Provides:
 * - Research queue with priority management
 * - Multi-agent research (WebSearch, CodeExpert, DocsExpert, etc.)
 * - Web UI dashboard for monitoring
 * - Research results storage for deduplication and compounding
 */

// Core exports
export { ResearchService } from './service/server.js';
export { QueueManager } from './queue/manager.js';
export { ResearchExecutor } from './crew/research-executor.js';

// Research crew and agents
export { getSessionManager, SessionManager } from './service/session-manager.js';
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
