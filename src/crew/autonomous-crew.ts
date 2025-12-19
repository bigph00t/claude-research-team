/**
 * Autonomous Research Crew
 *
 * Self-directing research crew that coordinates specialists for deep exploration.
 * This is the main orchestration layer that:
 * 1. Receives a research directive
 * 2. Uses the coordinator to plan and evaluate
 * 3. Dispatches work to specialist agents
 * 4. Iterates until confident or max iterations reached
 * 5. Synthesizes final results
 * 6. Stores findings incrementally to memory
 *
 * Key behaviors:
 * - Autonomous exploration without fixed depth (controlled by MAX_ITERATIONS)
 * - Parallel specialist execution where possible
 * - Incremental memory storage (findings saved after each iteration)
 * - Pivot detection and flagging
 * - Cost control through iteration limits
 */

import { EventEmitter } from 'events';
import { Logger } from '../utils/logger.js';
import { getMemoryIntegration } from '../memory/memory-integration.js';
import { getDatabase } from '../database/index.js';
import type { ResearchFinding } from '../types.js';
import { CoordinatorAgent, type PivotSuggestion, type SynthesizedResult, type PriorKnowledge } from '../agents/coordinator.js';
import { getOperationalSpecialists, type Finding, type BaseSpecialistAgent } from '../agents/specialists/index.js';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Types
// ============================================================================

/**
 * Input for autonomous research
 */
export interface CrewDirective {
  query: string;
  context?: string;
  maxIterations?: number;  // Override default
  sessionId?: string;
  depth?: 'quick' | 'medium' | 'deep';  // For manual calls with fixed depth
}

/**
 * Result of autonomous research
 */
export interface CrewResult {
  query: string;
  summary: string;
  keyFindings: string[];
  sources: Array<{
    title: string;
    url: string;
    snippet?: string;
    relevance?: number;
  }>;
  confidence: number;
  iterations: number;
  tokensUsed: number;
  pivot?: PivotSuggestion;
  duration: number;
}

/**
 * Events emitted during research
 */
export interface CrewEvents {
  'iteration:start': (iteration: number) => void;
  'iteration:complete': (iteration: number, findingsCount: number) => void;
  'specialist:dispatch': (specialist: string, query: string) => void;
  'specialist:complete': (specialist: string, resultsCount: number) => void;
  'pivot:detected': (pivot: PivotSuggestion) => void;
  'research:complete': (result: CrewResult) => void;
}

// ============================================================================
// Autonomous Research Crew
// ============================================================================

export class AutonomousResearchCrew extends EventEmitter {
  private coordinator: CoordinatorAgent;
  private specialists: Map<string, BaseSpecialistAgent>;
  private logger: Logger;

  // Configuration
  private readonly DEFAULT_MAX_ITERATIONS = 5;
  private readonly DEPTH_ITERATIONS: Record<string, number> = {
    quick: 1,
    medium: 2,
    deep: 4,
  };
  private readonly PARALLEL_SPECIALISTS = true;

  constructor() {
    super();
    this.logger = new Logger('AutonomousCrew');
    this.coordinator = new CoordinatorAgent();
    this.specialists = getOperationalSpecialists();

    this.logger.info('Crew initialized', {
      specialists: Array.from(this.specialists.keys()),
    });
  }

  /**
   * Main entry point - explore a research directive autonomously
   */
  async explore(directive: CrewDirective): Promise<CrewResult> {
    const startTime = Date.now();
    const maxIterations = this.getMaxIterations(directive);

    this.logger.info(`Starting exploration: "${directive.query}"`, {
      maxIterations,
      sessionId: directive.sessionId,
    });

    // Load relevant past research from memory
    const priorKnowledge = await this.loadPriorKnowledge(directive.query);

    // Get coordinator's initial plan
    const plan = await this.coordinator.plan(
      { query: directive.query, context: directive.context, priorKnowledge },
      priorKnowledge
    );

    // Iterative exploration
    const allFindings: Finding[] = [];
    let currentPlan = plan;
    let iteration = 0;
    let detectedPivot: PivotSuggestion | undefined;

    while (iteration < maxIterations) {
      iteration++;
      this.emit('iteration:start', iteration);
      this.logger.debug(`Iteration ${iteration}/${maxIterations}`);

      // Execute planned steps
      const newFindings = await this.executeSteps(currentPlan.nextSteps);
      allFindings.push(...newFindings);

      this.emit('iteration:complete', iteration, newFindings.length);

      // Store findings incrementally (no token waste if we stop early)
      await this.storeFindings(directive.query, newFindings, directive.sessionId);

      // Evaluate: should we continue?
      const evaluation = await this.coordinator.evaluate(
        { query: directive.query, context: directive.context },
        allFindings
      );

      // Track pivot suggestions
      if (evaluation.pivot) {
        detectedPivot = evaluation.pivot;
        this.emit('pivot:detected', evaluation.pivot);
        this.logger.info('Pivot detected', { pivot: evaluation.pivot });
      }

      // Check completion
      if (evaluation.complete || evaluation.confidence > 0.85) {
        this.logger.debug(`Completing: confidence=${evaluation.confidence}`);
        break;
      }

      // No more steps planned
      if (evaluation.nextSteps.length === 0) {
        this.logger.debug('No more steps planned');
        break;
      }

      // Update plan for next iteration
      currentPlan = {
        strategy: plan.strategy,
        rationale: evaluation.reasoning,
        nextSteps: evaluation.nextSteps,
      };
    }

    // Final synthesis
    const synthesis = await this.coordinator.synthesize(
      { query: directive.query, context: directive.context },
      allFindings,
      detectedPivot
    );

    // Build result
    const result = this.buildResult(directive.query, synthesis, allFindings, iteration, startTime, detectedPivot);

    // Store final result in memory
    await this.storeResult(directive.query, result, directive.sessionId);

    this.emit('research:complete', result);
    this.logger.info('Exploration complete', {
      iterations: iteration,
      findings: allFindings.length,
      confidence: result.confidence,
      duration: result.duration,
    });

    return result;
  }

  /**
   * Get available specialists
   */
  getSpecialists(): string[] {
    return Array.from(this.specialists.keys());
  }

  /**
   * Check if crew is operational
   */
  isOperational(): boolean {
    return this.specialists.size > 0;
  }

  // ============================================================================
  // Private: Execution
  // ============================================================================

  /**
   * Execute planned steps, potentially in parallel
   */
  private async executeSteps(
    steps: Array<{ specialist: string; query: string; priority: number }>
  ): Promise<Finding[]> {
    if (steps.length === 0) return [];

    const findings: Finding[] = [];

    if (this.PARALLEL_SPECIALISTS) {
      // Execute all steps in parallel
      const promises = steps.map(step => this.executeStep(step));
      const results = await Promise.all(promises);
      findings.push(...results.filter((f): f is Finding => f !== null));
    } else {
      // Execute sequentially by priority
      const sorted = [...steps].sort((a, b) => a.priority - b.priority);
      for (const step of sorted) {
        const finding = await this.executeStep(step);
        if (finding) findings.push(finding);
      }
    }

    return findings;
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    step: { specialist: string; query: string; priority: number }
  ): Promise<Finding | null> {
    const specialist = this.specialists.get(step.specialist);

    if (!specialist) {
      this.logger.warn(`Specialist not available: ${step.specialist}`);
      return null;
    }

    this.emit('specialist:dispatch', step.specialist, step.query);

    try {
      const finding = await specialist.execute({
        query: step.query,
        maxResults: 10,
        scrapeTop: 3,
        timeoutMs: 30000,
      });

      this.emit('specialist:complete', step.specialist, finding.results.length);
      return finding;
    } catch (error) {
      this.logger.error(`Specialist ${step.specialist} failed`, error);
      return null;
    }
  }

  // ============================================================================
  // Private: Memory Integration
  // ============================================================================

  /**
   * Load relevant prior knowledge from local database
   */
  private async loadPriorKnowledge(query: string): Promise<PriorKnowledge[]> {
    try {
      const db = getDatabase();
      const related = db.searchFindings(query, 5);

      return related.map(r => ({
        query: r.query,
        summary: r.summary,
        confidence: r.confidence,
        age: Date.now() - (r.createdAt || Date.now()),
      }));
    } catch (error) {
      this.logger.debug('Failed to load prior knowledge', error);
      return [];
    }
  }

  /**
   * Store findings incrementally
   */
  private async storeFindings(
    query: string,
    findings: Finding[],
    _sessionId?: string
  ): Promise<void> {
    if (findings.length === 0) return;

    try {
      const db = getDatabase();

      // Store each finding as a partial research finding in local DB
      for (const finding of findings) {
        const partialFinding: ResearchFinding = {
          id: uuidv4(),
          query: query,
          summary: `Partial finding from ${finding.specialist}: ${finding.results.length} results`,
          keyPoints: finding.results.slice(0, 5).map(r => r.title),
          fullContent: finding.scraped.map(s => s.content).join('\n\n').slice(0, 5000),
          sources: finding.results.map((r, i) => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            relevance: r.relevance ?? (1 - i * 0.1),
          })),
          domain: undefined,
          depth: 'deep',
          confidence: 0.3, // Partial findings have low confidence
          createdAt: finding.timestamp,
        };

        db.saveFinding(partialFinding);
      }
    } catch (error) {
      this.logger.debug('Failed to store partial findings', error);
    }
  }

  /**
   * Store final result
   */
  private async storeResult(
    query: string,
    result: CrewResult,
    sessionId?: string
  ): Promise<void> {
    try {
      const db = getDatabase();
      const memory = getMemoryIntegration();

      const fullContent = [
        result.summary,
        '',
        '## Key Findings',
        ...result.keyFindings.map(f => `- ${f}`),
      ].join('\n');

      // Store in local database
      const finding: ResearchFinding = {
        id: uuidv4(),
        query: query,
        summary: result.summary,
        keyPoints: result.keyFindings,
        fullContent: fullContent,
        sources: result.sources.map(s => ({
          title: s.title,
          url: s.url,
          snippet: s.snippet,
          relevance: s.relevance ?? 0.5,
        })),
        domain: this.inferDomain(query),
        depth: 'deep',
        confidence: result.confidence,
        createdAt: Date.now(),
      };

      db.saveFinding(finding);
      this.logger.info(`Stored autonomous research finding: ${finding.id}`);

      // Optionally inject to claude-mem if high quality
      await memory.initialize();
      const injectionResult = await memory.injectFindingIfQualified(finding, sessionId);
      if (injectionResult.injected) {
        this.logger.info(`Injected to claude-mem: observation #${injectionResult.observationId}`);
      } else {
        this.logger.debug(`Not injected to claude-mem: ${injectionResult.reason}`);
      }
    } catch (error) {
      this.logger.debug('Failed to store final result', error);
    }
  }

  /**
   * Infer domain from query
   */
  private inferDomain(queryText: string): string | undefined {
    const lowerQuery = queryText.toLowerCase();

    const domainPatterns: Record<string, RegExp> = {
      typescript: /\b(typescript|ts|tsx)\b/,
      javascript: /\b(javascript|js|node|npm)\b/,
      react: /\b(react|jsx|next\.?js)\b/,
      python: /\b(python|pip|django|flask)\b/,
      rust: /\b(rust|cargo)\b/,
      docker: /\b(docker|container|kubernetes)\b/,
      database: /\b(sql|database|postgres|mysql|mongodb)\b/,
      api: /\b(api|rest|graphql|http)\b/,
      ai: /\b(ai|machine learning|llm|gpt|claude)\b/,
    };

    for (const [domain, pattern] of Object.entries(domainPatterns)) {
      if (pattern.test(lowerQuery)) {
        return domain;
      }
    }

    return undefined;
  }

  // ============================================================================
  // Private: Helpers
  // ============================================================================

  /**
   * Get max iterations based on directive
   */
  private getMaxIterations(directive: CrewDirective): number {
    // Explicit override
    if (directive.maxIterations) {
      return directive.maxIterations;
    }

    // Depth-based (for manual research calls)
    if (directive.depth) {
      return this.DEPTH_ITERATIONS[directive.depth] || this.DEFAULT_MAX_ITERATIONS;
    }

    // Default for autonomous exploration
    return this.DEFAULT_MAX_ITERATIONS;
  }

  /**
   * Build final result
   */
  private buildResult(
    query: string,
    synthesis: SynthesizedResult,
    findings: Finding[],
    iterations: number,
    startTime: number,
    pivot?: PivotSuggestion
  ): CrewResult {
    // Collect all sources
    const allResults = findings.flatMap(f => f.results);
    const uniqueSources = this.deduplicateSources(allResults);

    // Estimate tokens
    const tokensUsed = this.estimateTokens(synthesis.summary) +
                       synthesis.keyFindings.reduce((sum, f) => sum + this.estimateTokens(f), 0);

    return {
      query,
      summary: synthesis.summary,
      keyFindings: synthesis.keyFindings,
      sources: uniqueSources.slice(0, 10).map(s => ({
        title: s.title,
        url: s.url,
        snippet: s.snippet,
        relevance: s.relevance,
      })),
      confidence: synthesis.confidence,
      iterations,
      tokensUsed,
      pivot: pivot || synthesis.pivot,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Deduplicate sources by URL
   */
  private deduplicateSources(
    results: Array<{ title: string; url: string; snippet?: string; relevance?: number }>
  ): Array<{ title: string; url: string; snippet?: string; relevance?: number }> {
    const seen = new Set<string>();
    return results.filter(r => {
      const normalized = r.url.toLowerCase().replace(/\/$/, '');
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  /**
   * Estimate tokens (~4 chars per token)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ============================================================================
// Singleton
// ============================================================================

let crewInstance: AutonomousResearchCrew | null = null;

export function getAutonomousCrew(): AutonomousResearchCrew {
  if (!crewInstance) {
    crewInstance = new AutonomousResearchCrew();
  }
  return crewInstance;
}
