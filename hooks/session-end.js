#!/usr/bin/env node

/**
 * Session End Hook - Handles session end events including /clear
 */

import { loadCliCommand } from './shared/config-loader.js';
import { getSettingsPath, getArchivesDir } from './shared/path-resolver.js';
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';

const cliCommand = loadCliCommand();

// Check if save-on-clear is enabled
function isSaveOnClearEnabled() {
  const settingsPath = getSettingsPath();
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

// Set up stdin immediately before any async operations
process.stdin.setEncoding('utf8');
process.stdin.resume(); // Explicitly enter flowing mode to prevent data loss

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
      execSync(`${cliCommand} compress --output ${getArchivesDir()}`, {
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