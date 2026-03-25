#!/usr/bin/env node

/**
 * Cross-platform hook runner
 * Handles Claude-mem hooks on Windows and Unix
 */

const { hookCommand } = require('../src/cli/hook-command.js');

const eventMap = {
  'session-init': 'beforeSubmitPrompt',
  'context-inject': 'beforeSubmitPrompt',
  'save-observation': 'afterShellExecution',
  'save-file-edit': 'afterFileEdit',
  'session-summary': 'stop'
};

const hookName = process.argv[2];
if (!hookName) {
  console.error('Usage: node hook-runner.js <hook-name>');
  process.exit(1);
}

const event = eventMap[hookName];
if (!event) {
  console.error(`Unknown hook: ${hookName}`);
  process.exit(1);
}

hookCommand('claude-code', event, { skipExit: false }).catch(error => {
  console.error(`Hook error: ${error.message}`);
  process.exit(1);
});
