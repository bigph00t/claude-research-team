/**
 * Specialist Agents Index
 *
 * Re-exports all specialist agents for easy importing.
 */

export * from './base.js';
export * from './web-search.js';
export * from './code-expert.js';
export * from './docs-expert.js';
export * from './meta-evaluator.js';
export * from './source-assessor.js';

import { WebSearchAgent } from './web-search.js';
import { CodeExpertAgent } from './code-expert.js';
import { DocsExpertAgent } from './docs-expert.js';
import type { BaseSpecialistAgent } from './base.js';

// Also export evaluation agents (these don't extend BaseSpecialistAgent)
export { MetaEvaluatorAgent, getMetaEvaluator } from './meta-evaluator.js';
export { SourceAssessorAgent, getSourceAssessor } from './source-assessor.js';

/**
 * Get all specialist agent instances
 */
export function createAllSpecialists(): Map<string, BaseSpecialistAgent> {
  const map = new Map<string, BaseSpecialistAgent>();
  map.set('web', new WebSearchAgent());
  map.set('code', new CodeExpertAgent());
  map.set('docs', new DocsExpertAgent());
  return map;
}

/**
 * Get operational specialists (those with at least one tool available)
 */
export function getOperationalSpecialists(): Map<string, BaseSpecialistAgent> {
  const all = createAllSpecialists();
  const operational = new Map<string, BaseSpecialistAgent>();

  for (const [key, specialist] of all) {
    if (specialist.isOperational()) {
      operational.set(key, specialist);
    }
  }

  return operational;
}
