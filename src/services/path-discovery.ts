import { join, dirname, sep } from 'path';
import { homedir } from 'os';
import { existsSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * PathDiscovery Service - Central path resolution for claude-mem
 * 
 * Handles dynamic discovery of all required paths across different installation scenarios:
 * - npm global installs, local installs, and development environments
 * - Cross-platform path resolution (Windows, macOS, Linux)  
 * - Environment variable overrides for customization
 * - Package resource discovery (hooks, commands)
 */
export class PathDiscovery {
  private static instance: PathDiscovery | null = null;
  
  // Cached paths for performance
  private _dataDirectory: string | null = null;
  private _packageRoot: string | null = null;
  private _claudeConfigDirectory: string | null = null;

  /**
   * Get singleton instance
   */
  static getInstance(): PathDiscovery {
    if (!PathDiscovery.instance) {
      PathDiscovery.instance = new PathDiscovery();
    }
    return PathDiscovery.instance;
  }

  // =============================================================================
  // DATA DIRECTORIES - Where claude-mem stores its data
  // =============================================================================

  /**
   * Base data directory for claude-mem
   * Environment override: CLAUDE_MEM_DATA_DIR
   */
  getDataDirectory(): string {
    if (this._dataDirectory) return this._dataDirectory;
    
    this._dataDirectory = process.env.CLAUDE_MEM_DATA_DIR || join(homedir(), '.claude-mem');
    return this._dataDirectory;
  }

  /**
   * Archives directory for compressed sessions
   */
  getArchivesDirectory(): string {
    return join(this.getDataDirectory(), 'archives');
  }


  /**
   * Logs directory for claude-mem operation logs
   */
  getLogsDirectory(): string {
    return join(this.getDataDirectory(), 'logs');
  }

  /**
   * Index directory for memory indexing
   */
  getIndexDirectory(): string {
    return this.getDataDirectory();
  }

  /**
   * Index file path for memory indexing
   */
  getIndexPath(): string {
    return join(this.getIndexDirectory(), 'claude-mem-index.jsonl');
  }

  /**
   * Trash directory for smart trash feature
   */
  getTrashDirectory(): string {
    return join(this.getDataDirectory(), 'trash');
  }

  /**
   * Backups directory for configuration backups
   */
  getBackupsDirectory(): string {
    return join(this.getDataDirectory(), 'backups');
  }

  /**
   * Chroma database directory
   */
  getChromaDirectory(): string {
    return join(this.getDataDirectory(), 'chroma');
  }

  /**
   * Project-specific archive directory
   */
  getProjectArchiveDirectory(projectName: string): string {
    return join(this.getArchivesDirectory(), projectName);
  }

  /**
   * User settings file path
   */
  getUserSettingsPath(): string {
    return join(this.getDataDirectory(), 'settings.json');
  }

  // =============================================================================
  // CLAUDE INTEGRATION PATHS - Where Claude Code expects configuration
  // =============================================================================

  /**
   * Claude configuration directory
   * Environment override: CLAUDE_CONFIG_DIR
   */
  getClaudeConfigDirectory(): string {
    if (this._claudeConfigDirectory) return this._claudeConfigDirectory;
    
    this._claudeConfigDirectory = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return this._claudeConfigDirectory;
  }

  /**
   * Claude settings file path
   */
  getClaudeSettingsPath(): string {
    return join(this.getClaudeConfigDirectory(), 'settings.json');
  }

  /**
   * Claude commands directory where custom commands are installed
   */
  getClaudeCommandsDirectory(): string {
    return join(this.getClaudeConfigDirectory(), 'commands');
  }

  /**
   * CLAUDE.md instructions file path
   */
  getClaudeMdPath(): string {
    return join(this.getClaudeConfigDirectory(), 'CLAUDE.md');
  }

  /**
   * MCP configuration file path (user-level)
   */
  getMcpConfigPath(): string {
    return join(homedir(), '.claude.json');
  }

  /**
   * MCP configuration file path (project-level)
   */
  getProjectMcpConfigPath(): string {
    return join(process.cwd(), '.mcp.json');
  }

  // =============================================================================
  // PACKAGE DISCOVERY - Find claude-mem package resources
  // =============================================================================

  /**
   * Discover the claude-mem package root directory
   */
  getPackageRoot(): string {
    if (this._packageRoot) return this._packageRoot;

    // Method 1: Try require.resolve for package.json
    try {
      const packageJsonPath = require.resolve('claude-mem/package.json');
      this._packageRoot = dirname(packageJsonPath);
      return this._packageRoot;
    } catch {
      // Continue to next method
    }

    // Method 2: Walk up from current module location
    const currentFile = fileURLToPath(import.meta.url);
    let currentDir = dirname(currentFile);

    for (let i = 0; i < 10; i++) {
      const packageJsonPath = join(currentDir, 'package.json');
      if (existsSync(packageJsonPath)) {
        const packageJson = require(packageJsonPath);
        if (packageJson.name === 'claude-mem') {
          this._packageRoot = currentDir;
          return this._packageRoot;
        }
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }

    throw new Error('Cannot locate claude-mem package root. Ensure claude-mem is properly installed.');
  }


  /**
   * Find commands directory in the installed package
   */
  findPackageCommandsDirectory(): string {
    const packageRoot = this.getPackageRoot();
    const commandsDir = join(packageRoot, 'commands');
    
    // Verify it contains expected command files
    const requiredCommands = ['save.md'];
    for (const commandFile of requiredCommands) {
      if (!existsSync(join(commandsDir, commandFile))) {
        throw new Error(`Package commands directory missing required file: ${commandFile}`);
      }
    }
    
    return commandsDir;
  }

  // =============================================================================
  // UTILITY METHODS
  // =============================================================================

  /**
   * Ensure a directory exists, creating it if necessary
   */
  ensureDirectory(dirPath: string): void {
    if (!existsSync(dirPath)) {
      require('fs').mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Ensure multiple directories exist
   */
  ensureDirectories(dirPaths: string[]): void {
    dirPaths.forEach(dirPath => this.ensureDirectory(dirPath));
  }

  /**
   * Create all claude-mem data directories
   */
  ensureAllDataDirectories(): void {
    this.ensureDirectories([
      this.getDataDirectory(),
      this.getArchivesDirectory(),
      this.getLogsDirectory(),
      this.getTrashDirectory(),
      this.getBackupsDirectory(),
      this.getChromaDirectory()
    ]);
  }

  /**
   * Create all Claude integration directories
   */
  ensureAllClaudeDirectories(): void {
    this.ensureDirectories([
      this.getClaudeConfigDirectory(),
      this.getClaudeCommandsDirectory()
    ]);
  }

  /**
   * Extract project name from a file path (improved from PathResolver)
   */
  static extractProjectName(filePath: string): string {
    const pathParts = filePath.split(sep);
    
    // Look for common project indicators
    const projectIndicators = ['src', 'lib', 'app', 'project', 'workspace'];
    for (let i = pathParts.length - 1; i >= 0; i--) {
      if (projectIndicators.includes(pathParts[i]) && i > 0) {
        return pathParts[i - 1];
      }
    }
    
    // Fallback to directory containing the file
    if (pathParts.length > 1) {
      return pathParts[pathParts.length - 2];
    }
    
    return 'unknown-project';
  }

  /**
   * Get current project directory name
   * Uses git repository root's basename if in a git repo, otherwise falls back to cwd basename
   */
  static getCurrentProjectName(): string {
    try {
      const gitRoot = execSync('git rev-parse --show-toplevel', {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      return require('path').basename(gitRoot);
    } catch {
      return require('path').basename(process.cwd());
    }
  }

  /**
   * Create a timestamped backup filename
   */
  static createBackupFilename(originalPath: string): string {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19);
    
    return `${originalPath}.backup.${timestamp}`;
  }

  /**
   * Check if a path exists and is accessible
   */
  static isPathAccessible(path: string): boolean {
    return existsSync(path) && statSync(path).isDirectory();
  }

}