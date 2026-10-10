#!/usr/bin/env node
const { spawnSync } = require('child_process');
const path = require('path');

const event = process.argv[2];
const allowed = new Set(['context', 'session-init', 'file-context', 'observation', 'summarize']);
if (!allowed.has(event)) {
  process.stderr.write('claude-mem: unknown Qoder hook event\n');
  process.exit(1);
}

const scripts = __dirname;
const pluginRoot = path.dirname(scripts);
const childEnv = {
  ...process.env,
  CLAUDE_PLUGIN_ROOT: pluginRoot,
  CLAUDE_MEM_CODEX_HOOK: '1',
};

// Qoder has no Claude-style Setup event. Materialize the plugin dependency
// closure on the first SessionStart before the worker is invoked; subsequent
// starts are a fast marker/completeness check inside version-check.js.
if (event === 'context') {
  const setup = spawnSync(
    process.execPath,
    [path.join(scripts, 'version-check.js')],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
      windowsHide: true,
      env: { ...childEnv, CLAUDE_MEM_CODEX_HOOK: '0' },
    },
  );
  if (setup.error || (setup.status != null && setup.status !== 0)) {
    process.stderr.write('claude-mem: Qoder dependency setup failed; continuing without memory\n');
    process.exit(0);
  }
}

const result = spawnSync(
  process.execPath,
  [
    path.join(scripts, 'bun-runner.js'),
    path.join(scripts, 'worker-service.cjs'),
    'hook',
    'codex',
    event,
  ],
  {
    stdio: 'inherit',
    windowsHide: true,
    env: childEnv,
  },
);
if (result.error) {
  process.stderr.write(String(result.error.message || result.error) + '\n');
  process.exit(1);
}
process.exit(result.status == null ? 0 : result.status);
