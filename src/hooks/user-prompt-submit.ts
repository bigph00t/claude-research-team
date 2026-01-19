/**
 * UserPromptSubmit Hook
 *
 * Simplified - no longer streams to research service.
 * The /research skill handles all research directly.
 *
 * Stdin Input: { prompt, session_id, cwd }
 * Stdout Output: { continue, suppressOutput }
 */

import {
  createHookRunner,
  createContinueResponse,
  type HookResponse,
} from './cli-handler.js';

interface UserPromptSubmitHookInput {
  prompt: string;
  session_id: string;
  cwd?: string;
}

/**
 * Main hook handler - just continue
 */
async function handleUserPromptSubmit(_input: UserPromptSubmitHookInput): Promise<HookResponse> {
  return createContinueResponse();
}

// Entry point - run the hook with stdin/stdout protocol
createHookRunner(handleUserPromptSubmit);
