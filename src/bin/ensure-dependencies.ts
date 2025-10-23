/**
 * Cross-platform dependency installer for claude-mem plugin hooks
 * Ensures better-sqlite3 is installed in the plugin/scripts directory
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

function getDirname() {
  return typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
}

const scriptDir = getDirname();

// Determine if we're in the built plugin/scripts directory or src/bin
const isBuilt = scriptDir.includes('plugin/scripts') || scriptDir.includes('plugin\\scripts');
const targetDir = isBuilt ? scriptDir : join(scriptDir, '../../plugin/scripts');

const nodeModulesPath = join(targetDir, 'node_modules');
const packageJsonPath = join(targetDir, 'package.json');

// Check if better-sqlite3 is already installed
if (existsSync(nodeModulesPath)) {
  const betterSqlitePath = join(nodeModulesPath, 'better-sqlite3');
  if (existsSync(betterSqlitePath)) {
    // Dependencies already installed
    process.exit(0);
  }
}

// Ensure target directory exists
if (!existsSync(targetDir)) {
  mkdirSync(targetDir, { recursive: true });
}

// Create minimal package.json if it doesn't exist
if (!existsSync(packageJsonPath)) {
  const packageJson = {
    name: 'claude-mem-scripts',
    version: '4.2.1',
    description: 'Runtime dependencies for claude-mem plugin hooks',
    private: true,
    type: 'module',
    dependencies: {
      'better-sqlite3': '^11.0.0'
    }
  };
  
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
}

// Install dependencies
try {
  console.log('Installing claude-mem dependencies...');
  execSync('npm install --prefer-offline --no-audit --no-fund --loglevel error', {
    cwd: targetDir,
    stdio: 'inherit'
  });
  console.log('Dependencies installed successfully.');
  process.exit(0);
} catch (error: any) {
  console.error('Failed to install dependencies:', error.message);
  process.exit(1);
}
