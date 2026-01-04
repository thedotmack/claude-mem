/**
 * Folder Index Service
 * Exports all folder indexing modules
 */

export {
  extractFoldersFromObservation,
  filterFolders,
  extractFoldersFromObservations
} from './FolderDiscovery.js';

export {
  compileTimeline
} from './FolderTimelineCompiler.js';

export {
  writeClaudeMd
} from './ClaudeMdGenerator.js';

export {
  regenerateFolderIndex,
  regenerateFolderIndexes
} from './FolderIndexOrchestrator.js';

export type {
  FolderIndexConfig,
  FolderTimelineContent,
  TimelineObservation
} from './types.js';
