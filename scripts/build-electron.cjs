#!/usr/bin/env node
/**
 * Build script for Electron desktop app
 *
 * 1. Runs the main build (viewer + worker)
 * 2. Copies plugin output to electron/plugin/
 * 3. Optionally runs electron-builder for installer
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT, 'electron');
const PLUGIN_SRC = path.join(ROOT, 'plugin');
const PLUGIN_DEST = path.join(ELECTRON_DIR, 'plugin');

function log(msg) { console.log(`\x1b[36m[electron-build]\x1b[0m ${msg}`); }
function success(msg) { console.log(`\x1b[32m[electron-build]\x1b[0m ✓ ${msg}`); }
function error(msg) { console.error(`\x1b[31m[electron-build]\x1b[0m ✗ ${msg}`); }

// Step 1: Build main project
log('Building claude-mem...');
try {
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  success('Main build complete');
} catch (e) {
  error('Main build failed');
  process.exit(1);
}

// Step 2: Copy plugin output to electron/plugin/
log('Copying plugin to electron/plugin/...');

// Clean existing
if (fs.existsSync(PLUGIN_DEST)) {
  fs.rmSync(PLUGIN_DEST, { recursive: true, force: true });
}

// Copy recursively
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules
      if (entry.name === 'node_modules') continue;
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

copyDir(PLUGIN_SRC, PLUGIN_DEST);
success('Plugin files copied');

// Step 3: Install electron deps if needed
const electronNodeModules = path.join(ELECTRON_DIR, 'node_modules');
if (!fs.existsSync(electronNodeModules)) {
  log('Installing Electron dependencies...');
  execSync('npm install', { cwd: ELECTRON_DIR, stdio: 'inherit' });
  success('Electron dependencies installed');
}

// Step 4: Check if --dist flag is passed
if (process.argv.includes('--dist')) {
  log('Building Windows installer...');
  execSync('npm run dist:win', { cwd: ELECTRON_DIR, stdio: 'inherit' });
  success('Installer built! Check electron/dist/');
} else {
  success('Ready! Run: cd electron && npm start');
  log('To build installer: node scripts/build-electron.js --dist');
}
