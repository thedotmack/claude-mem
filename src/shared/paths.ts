import { sep, basename } from 'path';
import { PathDiscovery } from '../services/path-discovery.js';

/**
 * PathResolver utility for managing claude-mem file system paths
 * Now delegates to PathDiscovery service for centralized path management
 */
export class PathResolver {
  private pathDiscovery: PathDiscovery;

  // <Block> 1.1 ====================================
  constructor() {
    this.pathDiscovery = PathDiscovery.getInstance();
  }
  // </Block> =======================================

  // <Block> 1.2 ====================================
  getConfigDir(): string {
    return this.pathDiscovery.getDataDirectory();
  }
  // </Block> =======================================

  // <Block> 1.3 ====================================
  getIndexDir(): string {
    return this.pathDiscovery.getIndexDirectory();
  }
  // </Block> =======================================

  // <Block> 1.4 ====================================
  getIndexPath(): string {
    return this.pathDiscovery.getIndexPath();
  }
  // </Block> =======================================

  // <Block> 1.5 ====================================
  getArchiveDir(): string {
    return this.pathDiscovery.getArchivesDirectory();
  }
  // </Block> =======================================

  // <Block> 1.6 ====================================
  getProjectArchiveDir(projectName: string): string {
    return this.pathDiscovery.getProjectArchiveDirectory(projectName);
  }
  // </Block> =======================================

  // <Block> 1.7 ====================================
  getLogsDir(): string {
    return this.pathDiscovery.getLogsDirectory();
  }
  // </Block> =======================================

  // <Block> 1.8 ====================================
  static ensureDirectory(dirPath: string): void {
    PathDiscovery.getInstance().ensureDirectory(dirPath);
  }
  // </Block> =======================================

  // <Block> 1.9 ====================================
  static ensureDirectories(dirPaths: string[]): void {
    PathDiscovery.getInstance().ensureDirectories(dirPaths);
  }
  // </Block> =======================================

  // <Block> 1.10 ===================================
  static extractProjectName(transcriptPath: string): string {
    return PathDiscovery.extractProjectName(transcriptPath);
  }
  
  // <Block> 1.11 ===================================
  /**
   * DRY utility function: Canonical source for getting the current project prefix
   * Replaces all instances of path.basename(process.cwd()) across the codebase
   * @returns The current project directory name, sanitized for use as a prefix
   */
  static getCurrentProjectPrefix(): string {
    return PathDiscovery.getCurrentProjectName();
  }
  // </Block> =======================================

  // <Block> 1.12 ===================================
  /**
   * DRY utility function: Gets raw project name without sanitization
   * For use in contexts where original directory name is needed (e.g., display)
   * @returns The current project directory name as-is
   */
  static getCurrentProjectName(): string {
    return PathDiscovery.getCurrentProjectName();
  }
  // </Block> =======================================
}