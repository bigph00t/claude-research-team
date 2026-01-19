/**
 * Core types for claude-research-team
 * Autonomous research agents for Claude Code
 */

// ============================================================================
// Research Types
// ============================================================================

export type ResearchDepth = 'quick' | 'medium' | 'deep';

export type ResearchStatus =
  | 'queued'      // Waiting to be processed
  | 'running'     // Currently being researched
  | 'completed'   // Successfully completed
  | 'failed'      // Research failed
  | 'injected';   // Results were injected into context

export type TriggerSource =
  | 'user_prompt'   // Detected from user message
  | 'tool_output'   // Detected from tool result
  | 'manual'        // Manually queued via API (by Claude)
  | 'user'          // User-initiated via dashboard search
  | 'scheduled';    // Scheduled background research

export interface ResearchTask {
  id: string;
  query: string;
  context?: string;
  depth: ResearchDepth;
  status: ResearchStatus;
  trigger: TriggerSource;
  sessionId?: string;
  projectPath?: string;    // Project this research is for
  priority: number;        // 1-10, higher = more urgent
  createdAt: number;       // Unix timestamp
  startedAt?: number;
  completedAt?: number;
  result?: ResearchResult;
  error?: string;
}

export interface ResearchResult {
  summary: string;         // Concise summary for injection
  fullContent: string;     // Full research content
  sources: ResearchSource[];
  tokensUsed: number;      // Approximate tokens in summary
  confidence: number;      // 0-1 source quality score (internal metric)
  relevance: number;       // 0-1 relevance to actual task (injection decision)
  findingId?: string;      // ID for progressive disclosure lookup
  pivot?: PivotSuggestion; // Alternative approach detected
}

export interface PivotSuggestion {
  alternative: string;     // Description of different approach
  reason: string;          // Why this might be better
  urgency: 'low' | 'medium' | 'high';
}

export interface ResearchSource {
  title: string;
  url: string;
  snippet?: string;
  relevance: number;       // 0-1 relevance score
}

// ============================================================================
// Injection Types
// ============================================================================

export type InjectionRecordType = 'task' | 'memory-only' | 'research-only' | 'combined' | 'warning';

export interface InjectionRecord {
  id: string;
  taskId: string;          // Reference to research task or synthetic ID
  sessionId: string;
  injectedAt: number;
  content: string;         // What was injected
  tokensUsed: number;
  accepted: boolean;       // Was it useful? (feedback)
  injectionType?: InjectionRecordType;  // Type of injection (unified knowledge)
}

// ============================================================================
// Research Knowledgebase Types (Isolated Learning System)
// ============================================================================

/**
 * Progressive disclosure levels for research content
 * 1 = summary only (short, ~100-200 tokens)
 * 2 = key_points (medium detail)
 * 3 = full_content (complete detail)
 */
export type InjectionLevel = 1 | 2 | 3;

/**
 * Trigger reasons for research injection
 */
export type InjectionTriggerReason =
  | 'error'        // Triggered by error detection
  | 'proactive'    // Proactive research based on context
  | 'manual'       // Manual skill invocation
  | 'followup';    // Auto-injected more detail

/**
 * Thorough research storage with progressive disclosure levels
 * Stored in research.db (isolated from claude-mem)
 */
export interface ResearchFinding {
  id: string;
  query: string;
  summary: string;         // SHORT: what gets injected first (~100-200 tokens)
  keyPoints?: string[];    // MEDIUM: array of bullet points
  fullContent?: string;    // FULL: complete scraped/synthesized info
  sources?: ResearchSourceWithQuality[];  // Sources with quality scores
  domain?: string;         // e.g., 'typescript', 'react', 'devops'
  depth: ResearchDepth;
  confidence: number;      // 0-1 confidence score
  createdAt: number;       // Unix timestamp
  lastAccessedAt?: number;
  projectPath?: string;    // Project this research is associated with
}

/**
 * Extended source info with quality scoring
 */
export interface ResearchSourceWithQuality extends ResearchSource {
  qualityScore?: number;   // 0-1 quality score for this source
}

/**
 * Track what was injected and effectiveness (progressive disclosure)
 * Used for meta-learning and implicit feedback
 */
export interface InjectionLogEntry {
  id?: number;             // Auto-increment
  findingId: string;       // Links to research_findings.id
  sessionId: string;
  injectedAt: number;      // Unix timestamp
  injectionLevel: InjectionLevel;  // 1=summary, 2=key_points, 3=full
  triggerReason?: InjectionTriggerReason;  // Optional: reason for injection
  followupInjected: boolean;  // Did we need to inject more?
  effectivenessScore?: number; // -1 to 1, from implicit feedback
  resolvedIssue: boolean;     // Did this help resolve the issue?
  projectPath?: string;       // Project this injection was for
  injectionType?: InjectionRecordType;  // Type of unified injection (memory/research/combined)
}

/**
 * Domain-level source quality tracking
 * Aggregated across all research findings
 */
export interface SourceQualityEntry {
  id?: number;             // Auto-increment
  domain: string;          // e.g., 'stackoverflow.com', 'github.com'
  topicCategory?: string;  // e.g., 'typescript', 'react'
  reliabilityScore: number; // 0-1 reliability score
  citationCount: number;   // How many times cited
  helpfulCount: number;    // How many times marked helpful
  lastCitedAt?: number;    // Unix timestamp (optional until first citation)
}

/**
 * Meta-learning insights derived from research patterns
 */
export interface ApproachInsights {
  successfulPatterns: string[];   // What tends to work
  failedPatterns: string[];       // What tends to fail
  recommendedSources: string[];   // Best sources by domain
  avgConfidenceByDepth: Record<ResearchDepth, number>;
}

export interface InjectionBudget {
  maxPerSession: number;   // Max injections per session
  maxTokensPerInjection: number;
  maxTotalTokensPerSession: number;
  cooldownMs: number;      // Min time between injections
  showInConversation: boolean;  // Show injections visibly in conversation
}

// ============================================================================
// Queue Types
// ============================================================================

export interface QueueStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  totalProcessed: number;
}

export interface QueueConfig {
  maxConcurrent: number;   // Max simultaneous research tasks
  maxQueueSize: number;    // Max pending tasks
  taskTimeoutMs: number;   // Timeout for individual tasks
  retryAttempts: number;   // Retries on failure
}

// ============================================================================
// Session Types
// ============================================================================

export interface Session {
  id: string;
  startedAt: number;
  lastActivityAt: number;
  projectPath?: string;
  injectionsCount: number;
  injectionsTokens: number;
}

// ============================================================================
// Project Context Types (Codebase Understanding)
// ============================================================================

export interface ProjectContext {
  id: string;
  projectPath: string;
  name: string;                    // Project name (from package.json, Cargo.toml, etc.)
  summary: string;                 // AI-generated project summary
  stack: string[];                 // Tech stack (e.g., ['typescript', 'react', 'node'])
  keyFiles: ProjectFile[];         // Important files identified
  patterns: string[];              // Code patterns/conventions detected
  dependencies: string[];          // Key dependencies
  indexedAt: number;               // When last indexed
  lastUpdatedAt: number;           // When project files last changed
  tokenCount: number;              // Approximate tokens in context
}

export interface ProjectFile {
  path: string;
  type: 'config' | 'source' | 'readme' | 'test' | 'types';
  summary?: string;                // AI summary of file purpose
  importance: number;              // 0-1 importance score
}

// ============================================================================
// Research Decision Types (Smart Query Generation)
// ============================================================================

export interface ResearchDecision {
  shouldResearch: boolean;
  query?: string;                  // Generated query if shouldResearch=true
  reason: string;                  // Why research was/wasn't triggered
  knowledgeGap?: string;           // What Claude might be missing
  expectedRelevance: number;       // 0-1 expected relevance to task
  depth: ResearchDepth;
  priority: number;
  alternativeHint?: string;        // Hint for pivot detection
}

export interface ResearchAnalysis {
  taskContext: string;             // Summary of what Claude is doing
  identifiedGaps: string[];        // Knowledge gaps identified
  suggestedQueries: SuggestedQuery[];
}

export interface SuggestedQuery {
  query: string;
  reason: string;                  // Why this would help
  expectedRelevance: number;       // 0-1 expected relevance
  priority: number;                // 1-10
}

// ============================================================================
// Configuration Types
// ============================================================================

export type AIProvider = 'claude' | 'gemini';
export type ClaudeModel = 'haiku' | 'sonnet' | 'opus';
export type GeminiModel = 'gemini-2.0-flash-exp' | 'gemini-1.5-flash' | 'gemini-1.5-pro';

export interface ResearchSettings {
  autonomousEnabled: boolean;      // Enable/disable autonomous research
  confidenceThreshold: number;     // 0.5-0.95, minimum source quality to accept
  relevanceThreshold: number;      // 0.5-0.95, minimum relevance to inject
  sessionCooldownMs: number;       // Cooldown between researches per session
  maxResearchPerHour: number;      // Global hourly limit
  projectIndexingEnabled: boolean; // Enable automatic project indexing
}

export interface AIProviderConfig {
  provider: AIProvider;            // Which provider to use
  claudeModel: ClaudeModel;        // Which Claude model (haiku/sonnet/opus)
  geminiApiKey?: string;           // API key for Gemini (from env or settings)
  geminiModel: GeminiModel;        // Gemini model (default: gemini-2.0-flash-exp)
}

/**
 * Claude-Mem Integration Configuration
 * Controls how research-team integrates with claude-mem's unified knowledge base
 */
export interface ClaudeMemConfig {
  // Database
  enabled: boolean;                  // Enable claude-mem integration
  dbPath: string;                    // Path to claude-mem.db

  // Knowledge search thresholds (for combined injection decisions)
  minRelevanceScore: number;         // 0-1, minimum to consider for injection
  memoryOnlyThreshold: number;       // Score threshold to inject memory only
  researchOnlyThreshold: number;     // Score threshold to inject research only
  combinedThreshold: number;         // Score for both memory + research

  // Fallback behavior
  enableFallbackMode: boolean;       // Use local DB if claude-mem unavailable

  // Token budgets for combined injections
  memoryOnlyTokens: number;          // Max tokens for memory-only injection
  researchOnlyTokens: number;        // Max tokens for research-only injection
  combinedTokens: number;            // Max tokens for combined injection
  warningTokens: number;             // Max tokens for warning/pivot injection
}

export interface Config {
  // Service
  port: number;
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';

  // Research
  defaultDepth: ResearchDepth;
  engines: string[];       // Which search engines to use

  // Autonomous Research Settings
  research: ResearchSettings;

  // AI Provider Settings
  aiProvider: AIProviderConfig;

  // Injection
  injection: InjectionBudget;

  // Queue
  queue: QueueConfig;

  // Integration (legacy - use claudeMem instead)
  claudeMemSync: boolean;  // Sync findings to claude-mem (deprecated)
  claudeMemUrl?: string;   // URL if sync enabled (deprecated)

  // Claude-Mem Integration (new unified approach)
  claudeMem: ClaudeMemConfig;
}

export const DEFAULT_CONFIG: Config = {
  port: 3200,
  dataDir: '~/.claude-research-team',
  logLevel: 'info',

  defaultDepth: 'medium',
  engines: ['serper', 'brave', 'tavily'],

  // Autonomous research settings (balanced with database deduplication)
  research: {
    autonomousEnabled: true,
    confidenceThreshold: 0.85,     // Balanced - database dedup handles repeats
    relevanceThreshold: 0.8,       // Must be relevant to inject
    sessionCooldownMs: 60000,      // 1 minute between researches per session
    maxResearchPerHour: 15,        // Reasonable limit with deduplication
    projectIndexingEnabled: true,  // Index projects for context
  },

  // AI provider (Claude SDK by default, Gemini optional)
  aiProvider: {
    provider: 'claude',            // Uses Claude Agent SDK (your Claude account)
    claudeModel: 'haiku',          // Default to haiku for efficiency
    geminiModel: 'gemini-2.0-flash-exp',  // Free tier model (detected from env)
  },

  injection: {
    maxPerSession: 5,
    maxTokensPerInjection: 150,
    maxTotalTokensPerSession: 500,
    cooldownMs: 30000,      // 30 seconds between injections
    showInConversation: false,  // Hidden by default (for power users)
  },

  queue: {
    maxConcurrent: 2,
    maxQueueSize: 20,
    taskTimeoutMs: 120000,  // 2 minutes
    retryAttempts: 2,
  },

  claudeMemSync: false,

  // Claude-Mem Integration defaults (matches vision document)
  claudeMem: {
    enabled: true,                          // Enable by default
    dbPath: '~/.claude-mem/claude-mem.db',  // Standard claude-mem location

    // Knowledge search thresholds
    minRelevanceScore: 0.5,                 // Minimum to consider
    memoryOnlyThreshold: 0.8,               // High memory match = memory only
    researchOnlyThreshold: 0.6,             // Research threshold
    combinedThreshold: 0.6,                 // Both must exceed for combined

    // Fallback behavior
    enableFallbackMode: true,               // Use local DB if unavailable

    // Token budgets (from vision document)
    memoryOnlyTokens: 80,                   // ~80 tokens for memory
    researchOnlyTokens: 100,                // ~100 tokens for research
    combinedTokens: 150,                    // ~150 tokens for combined
    warningTokens: 120,                     // ~120 tokens for warnings
  },
};

// ============================================================================
// API Types
// ============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface UrlCacheStats {
  totalCached: number;
  totalHits: number;
  avgHitsPerUrl: number;
  totalContentSize: number;
  oldestEntry: number | null;
  newestEntry: number | null;
}

export interface ServiceStatus {
  running: boolean;
  uptime: number;
  version: string;
  queue: QueueStats;
  activeSessions: number;
  urlCache?: UrlCacheStats;
  config: Partial<Config>;
}

// ============================================================================
// Hook Types
// ============================================================================

export interface HookContext {
  sessionId: string;
  projectPath?: string;
  hookType: 'UserPromptSubmit' | 'PostToolUse' | 'SessionStart' | 'SessionEnd';
}

export interface UserPromptSubmitInput {
  prompt: string;
  sessionId: string;
  projectPath?: string;
}

export interface PostToolUseInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: string;
  sessionId: string;
  projectPath?: string;
}

export interface HookResult {
  continue: boolean;
  suppressOutput?: boolean;
  additionalContext?: string;
}
