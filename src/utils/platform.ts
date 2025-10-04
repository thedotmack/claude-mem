import { platform, homedir } from 'os';
import { execSync } from 'child_process';
import { chmodSync } from 'fs';
import { join } from 'path';

const isWindows = platform() === 'win32';

/**
 * Platform-specific utilities for cross-platform compatibility
 * Handles differences between Windows and Unix-like systems
 */
export const Platform = {
  /**
   * Returns the appropriate shell for the current platform
   */
  getShell: (): string => {
    return isWindows ? 'powershell' : '/bin/sh';
  },

  /**
   * Returns the file extension for hook scripts
   */
  getHookExtension: (): string => {
    return '.js'; // Both platforms can execute Node.js scripts
  },

  /**
   * Finds the path to an executable command
   * @param name - Name of the executable to find
   * @returns Full path to the executable
   */
  findExecutable: (name: string): string => {
    const cmd = isWindows ? `where ${name}` : `which ${name}`;
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  },

  /**
   * Makes a file executable (Unix only - no-op on Windows)
   * @param path - Path to the file to make executable
   */
  makeExecutable: (path: string): void => {
    if (!isWindows) {
      chmodSync(path, 0o755);
    }
  },

  /**
   * Installs uv package manager using platform-specific method
   */
  installUv: (): void => {
    if (isWindows) {
      execSync('powershell -Command "irm https://astral.sh/uv/install.ps1 | iex"', {
        stdio: 'pipe'
      });
    } else {
      execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', {
        stdio: 'pipe',
        shell: '/bin/sh'
      });
    }
  },

  /**
   * Returns shell configuration file paths for the current platform
   * @returns Array of shell config file paths
   */
  getShellConfigPaths: (): string[] => {
    const home = homedir();

    if (isWindows) {
      return [
        join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
        join(home, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1')
      ];
    }

    return [
      join(home, '.bashrc'),
      join(home, '.zshrc'),
      join(home, '.bash_profile')
    ];
  },

  /**
   * Gets the appropriate alias syntax for the current platform's shell
   * @param aliasName - Name of the alias
   * @param command - Command to alias
   * @returns Alias definition string
   */
  getAliasDefinition: (aliasName: string, command: string): string => {
    if (isWindows) {
      // PowerShell function syntax
      return `function ${aliasName} { ${command} $args }`;
    }

    // Bash/Zsh alias syntax
    return `alias ${aliasName}='${command}'`;
  },

  /**
   * Returns whether the current platform is Windows
   */
  isWindows: (): boolean => isWindows,

  /**
   * Returns whether the current platform is Unix-like (macOS/Linux)
   */
  isUnix: (): boolean => !isWindows
};
