#!/usr/bin/env node

/**
 * Path resolver utility for Claude Memory hooks
 * Provides proper path handling using environment variables
 */

import { join } from 'path';
import { homedir } from 'os';

/**
 * Gets the base data directory for claude-mem
 * @returns {string} Data directory path
 */
export function getDataDir() {
  return process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
}

/**
 * Gets the settings file path
 * @returns {string} Settings file path
 */
export function getSettingsPath() {
  return join(getDataDir(), 'settings.json');
}

/**
 * Gets the archives directory path
 * @returns {string} Archives directory path
 */
export function getArchivesDir() {
  return process.env.CLAUDE_MEM_ARCHIVES_DIR || join(getDataDir(), 'archives');
}

/**
 * Gets the logs directory path
 * @returns {string} Logs directory path
 */
export function getLogsDir() {
  return process.env.CLAUDE_MEM_LOGS_DIR || join(getDataDir(), 'logs');
}

/**
 * Gets all common paths used by hooks
 * @returns {Object} Object containing all common paths
 */
export function getPaths() {
  return {
    dataDir: getDataDir(),
    settingsPath: getSettingsPath(),
    archivesDir: getArchivesDir(),
    logsDir: getLogsDir()
  };
}