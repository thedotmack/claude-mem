/**
 * Folder Discovery Service
 * Extracts and filters folder paths from observations
 */

import { dirname, sep } from 'path';
import type { Observation } from '../context/types.js';
import type { FolderIndexConfig } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Extract unique parent folders from observation file paths
 * Processes both files_read and files_modified fields
 *
 * @param observation - Observation record from database
 * @returns Array of unique folder paths (absolute paths)
 */
export function extractFoldersFromObservation(observation: Observation): string[] {
  const folders = new Set<string>();

  try {
    // Parse files_read (stored as JSON string)
    if (observation.files_read) {
      const filesRead: string[] = JSON.parse(observation.files_read);
      filesRead.forEach(filePath => {
        if (filePath && typeof filePath === 'string') {
          const folder = dirname(filePath);
          if (folder && folder !== '.') {
            folders.add(folder);
          }
        }
      });
    }
  } catch (err) {
    logger.warn('Failed to parse files_read from observation', {
      observationId: observation.id,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  try {
    // Parse files_modified (stored as JSON string)
    if (observation.files_modified) {
      const filesModified: string[] = JSON.parse(observation.files_modified);
      filesModified.forEach(filePath => {
        if (filePath && typeof filePath === 'string') {
          const folder = dirname(filePath);
          if (folder && folder !== '.') {
            folders.add(folder);
          }
        }
      });
    }
  } catch (err) {
    logger.warn('Failed to parse files_modified from observation', {
      observationId: observation.id,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return Array.from(folders);
}

/**
 * Calculate the depth of a folder path
 * Depth is the number of path separators
 *
 * @param folderPath - Absolute folder path
 * @returns Depth count (0 for root, 1 for /home, 2 for /home/user, etc.)
 */
function getFolderDepth(folderPath: string): number {
  // Remove leading/trailing slashes and count separators
  const normalized = folderPath.replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    return 0; // Root path
  }
  return normalized.split(sep).length;
}

/**
 * Check if folder should be excluded based on path components
 *
 * @param folderPath - Absolute folder path
 * @param excludeFolders - Array of folder names to exclude
 * @returns true if folder should be excluded
 */
function isExcludedFolder(folderPath: string, excludeFolders: string[]): boolean {
  const pathComponents = folderPath.split(sep);

  // Check if any component matches an excluded folder
  return pathComponents.some(component =>
    excludeFolders.includes(component)
  );
}

/**
 * Filter folders by depth and exclusion rules
 *
 * @param folders - Array of folder paths to filter
 * @param config - Folder index configuration
 * @returns Filtered array of folder paths
 */
export function filterFolders(folders: string[], config: FolderIndexConfig): string[] {
  return folders.filter(folder => {
    // Check depth constraint
    const depth = getFolderDepth(folder);
    if (depth > config.maxDepth) {
      logger.debug('Excluding folder due to depth', {
        folder,
        depth,
        maxDepth: config.maxDepth
      });
      return false;
    }

    // Check exclusion list
    if (isExcludedFolder(folder, config.excludeFolders)) {
      logger.debug('Excluding folder due to exclusion rule', {
        folder,
        excludeFolders: config.excludeFolders
      });
      return false;
    }

    return true;
  });
}

/**
 * Extract and filter folders from multiple observations
 * Returns a map of folder paths to observation count
 *
 * @param observations - Array of observations to process
 * @param config - Folder index configuration
 * @returns Map of folder path to number of observations referencing it
 */
export function extractFoldersFromObservations(
  observations: Observation[],
  config: FolderIndexConfig
): Map<string, number> {
  const folderActivityMap = new Map<string, number>();

  for (const observation of observations) {
    const rawFolders = extractFoldersFromObservation(observation);
    const filteredFolders = filterFolders(rawFolders, config);

    // Count activity per folder
    filteredFolders.forEach(folder => {
      const currentCount = folderActivityMap.get(folder) || 0;
      folderActivityMap.set(folder, currentCount + 1);
    });
  }

  // Filter by minimum activity threshold
  const result = new Map<string, number>();
  for (const [folder, count] of folderActivityMap.entries()) {
    if (count >= config.minActivityThreshold) {
      result.set(folder, count);
    } else {
      logger.debug('Excluding folder due to low activity', {
        folder,
        activityCount: count,
        minThreshold: config.minActivityThreshold
      });
    }
  }

  logger.info('Folder discovery complete', {
    totalFoldersFound: folderActivityMap.size,
    foldersAboveThreshold: result.size,
    minActivityThreshold: config.minActivityThreshold
  });

  return result;
}
