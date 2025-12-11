#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';

const ROOT = join(homedir(), '.claude', 'plugins', 'marketplaces', 'thedotmack');
const MARKER = join(ROOT, '.install-version');

function needsInstall() {
  if (!existsSync(join(ROOT, 'node_modules'))) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const marker = JSON.parse(readFileSync(MARKER, 'utf-8'));
    return pkg.version !== marker.version || process.version !== marker.node;
  } catch {
    return true;
  }
}

function install() {
  console.error('Installing dependencies...');
  try {
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
  } catch {
    execSync('npm install --force', { cwd: ROOT, stdio: 'inherit' });
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
  writeFileSync(MARKER, JSON.stringify({ version: pkg.version, node: process.version }));
}

if (needsInstall()) {
  try {
    install();
    console.error('✅ Dependencies installed');
  } catch (e) {
    console.error('❌ npm install failed:', e.message);
    process.exit(1);
  }
}
