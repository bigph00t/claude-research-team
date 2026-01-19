/**
 * CLI Handler for Claude Code Hooks
 *
 * This module provides the stdin/stdout protocol handling for hooks.
 * Claude Code hooks receive JSON on stdin and must output JSON on stdout.
 */

import { stdin } from 'process';

export interface HookResponse {
  continue: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
  stopReason?: string;
}

export const EXIT_CODES = {
  SUCCESS: 0,           // Shows to user AND Claude
  FAILURE: 1,           // Error
  USER_MESSAGE_ONLY: 3, // Shows to user but NOT in Claude context
};

/**
 * Create a simple continue response
 */
export function createContinueResponse(): HookResponse {
  return {
    continue: true,
    suppressOutput: true,
  };
}

/**
 * Output hook response to stdout and exit
 */
export function outputResponse(response: HookResponse, exitCode: number = EXIT_CODES.SUCCESS): void {
  console.log(JSON.stringify(response));
  process.exit(exitCode);
}

/**
 * Read input from stdin and parse as JSON
 * This is the core stdin/stdout protocol for Claude Code hooks
 */
export async function readStdinInput<T>(): Promise<T | undefined> {
  return new Promise((resolve) => {
    let input = '';

    stdin.setEncoding('utf-8');

    stdin.on('data', (chunk: string) => {
      input += chunk;
    });

    stdin.on('end', () => {
      if (!input.trim()) {
        resolve(undefined);
        return;
      }
      try {
        const parsed = JSON.parse(input) as T;
        resolve(parsed);
      } catch {
        // Invalid JSON, return undefined
        resolve(undefined);
      }
    });

    // Handle case where stdin is already closed (interactive mode)
    if (stdin.isTTY) {
      resolve(undefined);
    }
  });
}

/**
 * Create a hook runner that handles the stdin/stdout protocol
 */
export function createHookRunner<TInput>(
  handler: (input: TInput) => Promise<HookResponse>
): void {
  readStdinInput<TInput>()
    .then(async (input) => {
      if (!input) {
        // No input or invalid JSON, just continue
        outputResponse(createContinueResponse());
        return;
      }

      try {
        const response = await handler(input);
        outputResponse(response);
      } catch (error) {
        // On error, still continue but log to stderr
        console.error('[claude-research-team] Hook error:', error);
        outputResponse(createContinueResponse());
      }
    })
    .catch((error) => {
      console.error('[claude-research-team] Fatal hook error:', error);
      outputResponse(createContinueResponse());
    });
}
