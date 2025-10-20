import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Bootstrap function to ensure dependencies are installed
 * This runs on first hook execution after plugin installation from GitHub
 *
 * When installed via GitHub Marketplace, files are downloaded but npm install
 * doesn't run automatically. This function checks for node_modules and installs
 * dependencies if needed.
 */
export function ensureDependencies(): void {
  try {
    // Get plugin root from environment variable
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (!pluginRoot) {
      console.error('[bootstrap] CLAUDE_PLUGIN_ROOT not set, skipping dependency check');
      return;
    }

    const scriptsDir = join(pluginRoot, 'scripts');
    const nodeModulesPath = join(scriptsDir, 'node_modules');

    // Check if dependencies are already installed
    if (existsSync(nodeModulesPath)) {
      return; // Already installed
    }

    console.error('[bootstrap] Installing dependencies in plugin/scripts...');

    // Install dependencies using npm
    execSync('npm install', {
      cwd: scriptsDir,
      stdio: 'inherit', // Show install progress
      timeout: 60000 // 60 second timeout
    });

    console.error('[bootstrap] Dependencies installed successfully');
  } catch (error) {
    console.error('[bootstrap] Failed to install dependencies:', error instanceof Error ? error.message : error);
    // Don't throw - allow hook to continue, it will fail on import but with clearer error
  }
}
