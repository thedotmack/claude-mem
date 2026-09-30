'use strict';
// Windows half of cmem-build-hook.cmd. PowerShell (Grok Build) and cmd run this
// when bash is not on PATH. The bash half of the .cmd file is the POSIX
// dispatch shell from hook-shell-template.ts; keep the root order and the
// fail-open/fail-loud split aligned with that shell.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

function versionKey(name) {
  const q = name.split('-')[0].split('.');
  return [parseInt(q[0], 10) || 0, parseInt(q[1], 10) || 0, parseInt(q[2], 10) || 0];
}

// Same ordering as compareVersionsDescending / the POSIX cache sort: version
// descending, release before prerelease, then reverse lexicographic.
function newer(a, b) {
  const x = versionKey(a);
  const y = versionKey(b);
  return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2])
    || ((a.indexOf('-') < 0 ? 0 : 1) - (b.indexOf('-') < 0 ? 0 : 1))
    || (a < b ? 1 : a > b ? -1 : 0);
}

function rootIfComplete(candidate, files) {
  if (!candidate) return null;
  const base = fs.existsSync(path.join(candidate, 'plugin', 'scripts'))
    ? path.join(candidate, 'plugin')
    : candidate;
  for (let i = 0; i < files.length; i++) {
    if (!fs.existsSync(path.join(base, 'scripts', files[i]))) return null;
  }
  return base;
}

function resolveRoot(files) {
  const home = os.homedir();
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const roots = [];
  if (process.env.CLAUDE_PLUGIN_ROOT) roots.push(process.env.CLAUDE_PLUGIN_ROOT);
  if (process.env.PLUGIN_ROOT) roots.push(process.env.PLUGIN_ROOT);
  const cache = path.join(configDir, 'plugins', 'cache', 'thedotmack', 'claude-mem');
  try {
    const versions = fs.readdirSync(cache)
      .filter((name) => {
        const ch = name.charAt(0);
        return ch >= '0' && ch <= '9';
      })
      .map((name) => path.join(cache, name))
      .filter((dir) => {
        try {
          return fs.statSync(dir).isDirectory() && !fs.existsSync(path.join(dir, '.orphaned_at'));
        } catch (err) {
          return false;
        }
      })
      .sort((a, b) => newer(path.basename(a), path.basename(b)));
    for (let i = 0; i < versions.length; i++) roots.push(versions[i]);
  } catch (err) {
    // cache directory missing
  }
  roots.push(path.join(configDir, 'plugins', 'marketplaces', 'thedotmack', 'plugin'));
  for (let i = 0; i < roots.length; i++) {
    const found = rootIfComplete(roots[i], files);
    if (found) return found;
  }
  return null;
}

const failLoud = process.argv[2] === 'version-check';
const required = failLoud
  ? ['version-check.js']
  : ['bun-runner.js', 'worker-service.cjs'];
const root = resolveRoot(required);
if (!root) {
  process.stderr.write('claude-mem: plugin scripts not found\n');
  process.exit(failLoud ? 1 : 0);
}

const childArgs = failLoud
  ? [path.join(root, 'scripts', 'version-check.js')]
  : [path.join(root, 'scripts', 'bun-runner.js'), path.join(root, 'scripts', 'worker-service.cjs')].concat(process.argv.slice(2));

const result = spawnSync(process.execPath, childArgs, { stdio: 'inherit', windowsHide: true });
let code = 0;
if (result.error) {
  process.stderr.write(String(result.error.message || result.error) + '\n');
  code = 1;
} else if (result.signal) {
  code = 1;
} else {
  code = result.status == null ? 0 : result.status;
}
if (!failLoud && code !== 0) {
  process.stderr.write('claude-mem: hook command failed (exit ' + code + ')\n');
  process.exit(0);
}
process.exit(code);
