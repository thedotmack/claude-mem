/**
 * Runtime Launcher - selects bun or node and executes the target script
 * Usage: node run.js <script-path> [args...]
 */

import { spawn } from 'child_process';
import { getRuntime } from '../shared/runtime.js';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node run.js <script-path> [args...]');
  process.exit(1);
}

const runtime = getRuntime();
const [scriptPath, ...scriptArgs] = args;

const child = spawn(runtime, [scriptPath, ...scriptArgs], {
  stdio: 'inherit',
  env: process.env
});

child.on('error', (err) => {
  console.error(`Failed to start ${runtime}: ${err.message}`);
  process.exit(1);
});

child.on('close', (code) => {
  process.exit(code ?? 0);
});
