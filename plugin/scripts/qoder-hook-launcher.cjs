#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const { createRequire } = require('module');
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

function dependencyClosureComplete(root) {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf-8'),
    );
    const dependencies = Object.keys(packageJson.dependencies || {});
    const nodeModules = path.join(root, 'node_modules');

    for (const dependency of dependencies) {
      if (!fs.existsSync(path.join(nodeModules, ...dependency.split('/'), 'package.json'))) {
        return false;
      }
    }

    if (dependencies.includes('zod')) {
      const requireFromPlugin = createRequire(path.join(nodeModules, 'noop.js'));
      const zodRoot = fs.realpathSync(path.join(nodeModules, 'zod'));
      for (const specifier of ['zod/v3', 'zod/v4', 'zod/v4-mini']) {
        const resolved = fs.realpathSync(requireFromPlugin.resolve(specifier));
        const relative = path.relative(zodRoot, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          return false;
        }
      }
    }

    return true;
  } catch {
    return false;
  }
}

function emitNoop(reason) {
  process.stderr.write(`claude-mem: ${reason}; continuing without memory\n`);
  const output = { continue: true, suppressOutput: true };
  if (event === 'context') {
    output.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext: '',
    };
  }
  process.stdout.write(JSON.stringify(output) + '\n');
}

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
    emitNoop('Qoder dependency setup failed');
    process.exit(0);
  }
}

// version-check.js deliberately exits zero after a failed download so Claude
// Code's Setup event remains non-blocking. Qoder has no Setup event, therefore
// its launcher must verify the declared dependency closure itself before it
// may start the worker. Check every event so a failed SessionStart cannot be
// followed by a crashing UserPromptSubmit or tool hook.
if (!dependencyClosureComplete(pluginRoot)) {
  emitNoop('Qoder plugin dependencies remain incomplete');
  process.exit(0);
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
