/**
 * Project-level memory control via global settings
 *
 * Supports disabling memory capture at the project level through
 * CLAUDE_MEM_IGNORED_PROJECTS setting in ~/.claude-mem/settings.json
 */

import { logger } from '../utils/logger.js';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from './paths.js';
import path from 'path';

/**
 * Check if a project is in the ignored projects list
 *
 * @param cwd - Current working directory (project root)
 * @returns true if the project should be ignored (memory disabled)
 */
export function isProjectIgnored(cwd: string): boolean {
  try {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const ignoredProjects = settings.CLAUDE_MEM_IGNORED_PROJECTS || '';
    
    if (!ignoredProjects || ignoredProjects.trim() === '') {
      return false;
    }

    // Get project name from cwd (basename of directory)
    const projectName = path.basename(cwd);
    
    // Parse comma-separated list of ignored projects
    const ignoredList = ignoredProjects
      .split(',')
      .map(p => p.trim())
      .filter(p => p.length > 0);
    
    const ignored = ignoredList.includes(projectName);
    
    if (ignored) {
      logger.debug('PROJECT', 'Project is in ignored list', {
        project: projectName,
        cwd,
        ignoredProjects: ignoredList
      });
    }
    
    return ignored;
  } catch (error) {
    logger.warn('PROJECT', 'Failed to check if project is ignored', { cwd }, error);
    return false; // Default to not ignored if there's an error
  }
}

/**
 * Check if memory capture is enabled for a project
 *
 * @param cwd - Current working directory (project root)
 * @returns true if memory capture is enabled
 */
export function isMemoryEnabled(cwd: string): boolean {
  return !isProjectIgnored(cwd);
}

/**
 * Check if observation capture is enabled for a project
 *
 * @param cwd - Current working directory (project root)
 * @returns true if observation capture is enabled
 */
export function canCaptureObservations(cwd: string): boolean {
  return !isProjectIgnored(cwd);
}

/**
 * Check if session capture is enabled for a project
 *
 * @param cwd - Current working directory (project root)
 * @returns true if session capture is enabled
 */
export function canCaptureSessions(cwd: string): boolean {
  return !isProjectIgnored(cwd);
}

/**
 * Check if prompt capture is enabled for a project
 *
 * @param cwd - Current working directory (project root)
 * @returns true if prompt capture is enabled
 */
export function canCapturePrompts(cwd: string): boolean {
  return !isProjectIgnored(cwd);
}

/**
 * Clear the configuration cache (useful for testing)
 * Note: No-op since we load settings on each check
 */
export function clearConfigCache(): void {
  // No cache to clear - settings are loaded fresh each time
}

