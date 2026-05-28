#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const { readFileSync } = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const scriptsDir = path.join(root, 'scripts');
const bunRunner = path.join(scriptsDir, 'bun-runner.js');
const versionCheck = path.join(scriptsDir, 'version-check.js');
const workerService = path.join(scriptsDir, 'worker-service.cjs');

function maybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractContext(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';

  const parsed = maybeJson(text);
  if (!parsed || typeof parsed !== 'object') {
    return text;
  }

  const hookSpecificOutput = parsed.hookSpecificOutput;
  if (
    hookSpecificOutput &&
    typeof hookSpecificOutput === 'object' &&
    hookSpecificOutput.hookEventName === 'SessionStart' &&
    typeof hookSpecificOutput.additionalContext === 'string'
  ) {
    return hookSpecificOutput.additionalContext.trim();
  }

  const candidate =
    parsed.additionalContext ??
    parsed.context ??
    parsed.warning ??
    parsed.output ??
    '';

  return typeof candidate === 'string' ? candidate.trim() : '';
}

function buildSessionStartOutput(additionalContext) {
  const context = String(additionalContext || '').trim();
  if (!context) return '';

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  });
}

function readStdinPayload() {
  try {
    if (process.stdin.isTTY) return '{}';

    const input = readFileSync(0, 'utf8');
    return input.trim() ? input : '{}';
  } catch {
    return '{}';
  }
}

function runNode(args, input, timeout) {
  return spawnSync(process.execPath, args, {
    input,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_MEM_CODEX_HOOK: '1',
    },
  });
}

function forwardStderr(result) {
  if (result.stderr) {
    process.stderr.write(result.stderr);
    if (!result.stderr.endsWith('\n')) {
      process.stderr.write('\n');
    }
  }
}

function fail(label, result) {
  forwardStderr(result);
  if (result.error) {
    process.stderr.write(`claude-mem Codex SessionStart wrapper failed at ${label}: ${result.error.message}\n`);
  } else {
    process.stderr.write(`claude-mem Codex SessionStart wrapper failed at ${label}\n`);
  }
  const status = typeof result.status === 'number' ? result.status : 1;
  process.exit(status || 1);
}

function runSessionStart() {
  const input = readStdinPayload();
  const contextParts = [];

  const version = runNode([versionCheck], '', 5000);
  if (version.status !== 0) fail('version-check', version);
  forwardStderr(version);
  const versionContext = extractContext(version.stdout);
  if (versionContext) contextParts.push(versionContext);

  const start = runNode([bunRunner, workerService, 'start'], input, 25000);
  if (start.status !== 0) fail('worker-start', start);
  forwardStderr(start);

  const context = runNode([bunRunner, workerService, 'hook', 'codex', 'context'], input, 35000);
  if (context.status !== 0) fail('codex-context', context);
  forwardStderr(context);
  const hookContext = extractContext(context.stdout);
  if (hookContext) contextParts.push(hookContext);

  const output = buildSessionStartOutput(contextParts.join('\n\n'));
  if (output) {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  runSessionStart();
}

module.exports = {
  buildSessionStartOutput,
  extractContext,
};
