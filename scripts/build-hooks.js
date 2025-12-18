#!/usr/bin/env node

/**
 * Build hooks as standalone JavaScript files
 * These need to be self-contained for Claude Code to execute them
 */

import { build } from 'esbuild';
import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const hooksDir = join(rootDir, 'dist', 'hooks');

// Ensure hooks directory exists
if (!existsSync(hooksDir)) {
  mkdirSync(hooksDir, { recursive: true });
}

const hooks = [
  {
    entry: join(rootDir, 'src', 'hooks', 'session-start.ts'),
    out: join(hooksDir, 'session-start.js'),
  },
  {
    entry: join(rootDir, 'src', 'hooks', 'session-end.ts'),
    out: join(hooksDir, 'session-end.js'),
  },
  {
    entry: join(rootDir, 'src', 'hooks', 'user-prompt-submit.ts'),
    out: join(hooksDir, 'user-prompt-submit.js'),
  },
  {
    entry: join(rootDir, 'src', 'hooks', 'post-tool-use.ts'),
    out: join(hooksDir, 'post-tool-use.js'),
  },
];

async function buildHooks() {
  console.log('Building hooks...');

  for (const hook of hooks) {
    try {
      await build({
        entryPoints: [hook.entry],
        outfile: hook.out,
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'esm',
        minify: false,
        sourcemap: false,
        // Bundle everything except node built-ins
        external: [
          'fs',
          'path',
          'os',
          'crypto',
          'http',
          'https',
          'url',
          'util',
          'stream',
          'events',
          'buffer',
          'child_process',
        ],
        banner: {
          js: '#!/usr/bin/env node\n// Claude Research Team Hook - Auto-generated',
        },
      });
      console.log(`  Built: ${hook.out}`);
    } catch (error) {
      console.error(`  Failed to build ${hook.entry}:`, error);
      process.exit(1);
    }
  }

  console.log('Hooks built successfully!');
}

buildHooks();
