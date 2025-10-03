#!/usr/bin/env node

/**
 * Path resolver utility for Claude Memory hooks
 * Provides proper path handling using environment variables
 */

import { join, basename } from 'path';
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
 * Gets the compact flag file path
 * @returns {string} Compact flag file path
 */
export function getCompactFlagPath() {
  return join(getDataDir(), '.compact-running');
}

/**
 * Gets the claude-mem package root directory
 * @returns {Promise<string>} Package root path
 */
export async function getPackageRoot() {
  // Method 1: Check if we're running from development
  const devPath = join(homedir(), 'Scripts', 'claude-mem-source');
  const { existsSync } = await import('fs');
  if (existsSync(join(devPath, 'package.json'))) {
    return devPath;
  }

  // Method 2: Follow the binary symlink
  try {
    const { execSync } = await import('child_process');
    const { realpathSync } = await import('fs');
    const binPath = execSync('which claude-mem', { encoding: 'utf8' }).trim();
    const realBinPath = realpathSync(binPath);
    // Binary is typically at package_root/dist/claude-mem.min.js
    return join(realBinPath, '../..');
  } catch {}

  throw new Error('Cannot locate claude-mem package root');
}

/**
 * Gets the project root directory
 * Uses CLAUDE_PROJECT_DIR environment variable if available, otherwise falls back to cwd
 * @returns {string} Project root path
 */
export function getProjectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Derives project name from CLAUDE_PROJECT_DIR or current working directory
 * Priority: CLAUDE_PROJECT_DIR > cwd parameter > process.cwd()
 * @param {string} [cwd] - Optional current working directory from hook payload
 * @returns {string} Project name (basename of project directory)
 */
export function getProjectName(cwd) {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR || cwd || process.cwd();
  return basename(projectRoot);
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
    logsDir: getLogsDir(),
    compactFlagPath: getCompactFlagPath()
  };
}