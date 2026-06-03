#!/usr/bin/env node
/**
 * Windows-compatible hook entry point for claude-mem
 * Replaces complex bash path resolution with cross-platform Node.js logic
 */

const { existsSync } = require('fs');
const { join, resolve } = require('path');
const { homedir } = require('os');
const { spawn } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

function findPluginRoot() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

  // Priority 1: CLAUDE_PLUGIN_ROOT environment variable
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    const root = process.env.CLAUDE_PLUGIN_ROOT;
    if (existsSync(join(root, 'scripts', 'bun-runner.js'))) {
      return root;
    }
  }

  // Priority 2: Cache directory (versioned installations)
  const cacheDir = join(configDir, 'plugins', 'cache', 'thedotmack', 'claude-mem');
  if (existsSync(cacheDir)) {
    const versions = require('fs').readdirSync(cacheDir)
      .filter(v => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => {
        const [aMaj, aMin, aPatch] = a.split('.').map(Number);
        const [bMaj, bMin, bPatch] = b.split('.').map(Number);
        return (bMaj - aMaj) || (bMin - aMin) || (bPatch - aPatch);
      });

    for (const version of versions) {
      const pluginRoot = join(cacheDir, version);
      if (existsSync(join(pluginRoot, 'scripts', 'bun-runner.js'))) {
        return pluginRoot;
      }
    }
  }

  // Priority 3: Marketplace directory
  const marketplaceDir = join(configDir, 'plugins', 'marketplaces', 'thedotmack', 'plugin');
  if (existsSync(join(marketplaceDir, 'scripts', 'bun-runner.js'))) {
    return marketplaceDir;
  }

  console.error('claude-mem: plugin root not found');
  process.exit(1);
}

function main() {
  const pluginRoot = findPluginRoot();
  const bunRunnerPath = join(pluginRoot, 'scripts', 'bun-runner.js');

  // Forward all arguments to bun-runner.js
  const args = process.argv.slice(2);

  const child = spawn(process.execPath, [bunRunnerPath, ...args], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginRoot
    },
    windowsHide: true
  });

  child.on('error', (err) => {
    console.error(`Failed to start bun-runner: ${err.message}`);
    process.exit(1);
  });

  child.on('close', (code) => {
    process.exit(code || 0);
  });
}

main();
