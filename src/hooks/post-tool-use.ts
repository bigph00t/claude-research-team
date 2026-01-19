/**
 * PostToolUse Hook
 *
 * Simplified - no longer streams to research service.
 * The /research skill handles all research directly.
 *
 * Stdin Input: { tool_name, tool_input, tool_response, session_id, cwd }
 * Stdout Output: { continue, suppressOutput }
 */

import {
  createHookRunner,
  createContinueResponse,
  type HookResponse,
} from './cli-handler.js';

interface PostToolUseHookInput {
  tool_name: string;
  tool_input: string | Record<string, unknown>;
  tool_response: string;
  session_id: string;
  cwd?: string;
}

/**
 * Main hook handler - just continue
 */
async function handlePostToolUse(_input: PostToolUseHookInput): Promise<HookResponse> {
  return createContinueResponse();
}

// Entry point - run the hook with stdin/stdout protocol
createHookRunner(handlePostToolUse);
