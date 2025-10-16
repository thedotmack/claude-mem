import { platform, homedir } from 'os';
import { execSync } from 'child_process';
import { join } from 'path';

const isWindows = platform() === 'win32';

/**
 * Platform-specific utilities for cross-platform compatibility
 * Handles differences between Windows and Unix-like systems
 */
export const Platform = {
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
  }
};
