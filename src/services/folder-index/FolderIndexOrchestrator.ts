/**
 * FolderIndexOrchestrator - Coordinate folder index regeneration after observation save
 *
 * This module provides the high-level orchestration logic to:
 * 1. Extract folders from a newly saved observation
 * 2. Filter folders by configuration rules
 * 3. Regenerate CLAUDE.md files for active folders
 *
 * Integration point: Called from ResponseProcessor after observations are saved to database
 */

import { logger } from '../../utils/logger.js';
import { extractFoldersFromObservation, filterFolders } from './FolderDiscovery.js';
import { compileTimeline } from './FolderTimelineCompiler.js';
import { writeClaudeMd } from './ClaudeMdGenerator.js';
import type { FolderIndexConfig } from './types.js';
import type { ObservationRecord } from '../../types/database.js';

/**
 * Regenerate CLAUDE.md file for a single folder
 *
 * @param project - Project name (for scoping timeline queries)
 * @param folderPath - Absolute path to the folder
 */
export async function regenerateFolderIndex(
  project: string,
  folderPath: string
): Promise<void> {
  try {
    logger.debug('FOLDER_INDEX', 'Regenerating folder index', {
      project,
      folderPath
    });

    // Compile timeline from database observations
    const timeline = await compileTimeline(project, folderPath);

    // Write CLAUDE.md with timeline content
    await writeClaudeMd(folderPath, timeline);

    logger.info('FOLDER_INDEX', 'Folder index regenerated successfully', {
      project,
      folderPath,
      observationCount: timeline.observationCount,
      timelineDays: timeline.timeline.length
    });
  } catch (error) {
    // Non-critical: Log error but don't fail observation save
    logger.warn('FOLDER_INDEX', 'Failed to regenerate folder index (non-critical)', {
      project,
      folderPath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Regenerate CLAUDE.md files for all folders referenced in an observation
 *
 * This is the main integration point called after observation save.
 * Extracts folders from observation, filters by config, regenerates indexes.
 *
 * @param project - Project name
 * @param observation - Newly saved observation record
 * @param config - Folder index configuration
 */
export async function regenerateFolderIndexes(
  project: string,
  observation: ObservationRecord,
  config: FolderIndexConfig
): Promise<void> {
  // Skip if folder indexing is disabled
  if (!config.enabled) {
    logger.debug('FOLDER_INDEX', 'Folder indexing disabled, skipping', { project });
    return;
  }

  try {
    // Extract folders from observation files
    const rawFolders = extractFoldersFromObservation(observation);

    // Filter by depth and exclusion rules
    const filteredFolders = filterFolders(rawFolders, config);

    if (filteredFolders.length === 0) {
      logger.debug('FOLDER_INDEX', 'No folders to index after filtering', {
        project,
        rawFolderCount: rawFolders.length,
        observationId: observation.id
      });
      return;
    }

    logger.info('FOLDER_INDEX', 'Regenerating indexes for folders', {
      project,
      folderCount: filteredFolders.length,
      observationId: observation.id
    });

    // Regenerate each folder index (fire-and-forget, failures are non-critical)
    const regenerationPromises = filteredFolders.map(folder =>
      regenerateFolderIndex(project, folder)
    );

    // Wait for all regenerations to complete (but don't block observation save)
    await Promise.allSettled(regenerationPromises);

  } catch (error) {
    // Non-critical: Log error but don't fail observation save
    logger.warn('FOLDER_INDEX', 'Failed to regenerate folder indexes (non-critical)', {
      project,
      observationId: observation.id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
