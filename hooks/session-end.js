#!/usr/bin/env node

/**
 * Session End Hook - Handles session end events including /clear
 */

import { loadCliCommand } from './shared/config-loader.js';
import { execSync } from 'child_process';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync } from 'fs';

const cliCommand = loadCliCommand();

// Check if save-on-clear is enabled
function isSaveOnClearEnabled() {
  const settingsPath = join(homedir(), '.claude-mem', 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      return settings.saveMemoriesOnClear === true;
    } catch (error) {
      return false;
    }
  }
  return false;
}

// Read input
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
});

process.stdin.on('end', async () => {
  const data = JSON.parse(input);
  
  // Check if this is a clear event and save-on-clear is enabled
  if (data.reason === 'clear' && isSaveOnClearEnabled()) {
    console.error('🧠 Saving memories before clearing context...');
    
    try {
      // Use the CLI to compress current transcript
      execSync(`${cliCommand} compress --output ${homedir()}/.claude-mem/archives`, {
        stdio: 'inherit',
        env: { ...process.env, CLAUDE_MEM_SILENT: 'true' }
      });
      
      console.error('✅ Memories saved successfully');
    } catch (error) {
      console.error('[session-end] Failed to save memories:', error.message);
      // Don't block the clear operation if memory saving fails
    }
  }
  
  // Always continue
  console.log(JSON.stringify({ continue: true }));
});