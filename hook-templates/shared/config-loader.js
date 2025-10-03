#!/usr/bin/env node

/**
 * Shared configuration loader utility for Claude Memory hooks
 * Loads CLI command name from config.json with proper fallback handling
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

/**
 * Loads the CLI command name from the hooks config.json file
 * @returns {string} The CLI command name (defaults to 'claude-mem')
 */
export function loadCliCommand() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const configPath = join(__dirname, '..', 'config.json');
  
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return config.cliCommand || 'claude-mem';
  }
  
  return 'claude-mem';
}