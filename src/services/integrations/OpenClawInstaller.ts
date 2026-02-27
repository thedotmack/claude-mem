/**
 * OpenClawInstaller - OpenClaw gateway integration installer for claude-mem
 *
 * Installs the pre-built claude-mem plugin into OpenClaw's extension directory
 * and registers it in ~/.openclaw/openclaw.json.
 *
 * Install strategy: File-based
 * - Copies the pre-built plugin from the npm package's openclaw/dist/ directory
 *   to ~/.openclaw/extensions/claude-mem/dist/
 * - Registers the plugin in openclaw.json under plugins.entries.claude-mem
 * - Sets the memory slot to claude-mem
 *
 * Important: The OpenClaw plugin ships pre-built from the npm package.
 * It must NOT be rebuilt at install time.
 */

import path from 'path';
import { homedir } from 'os';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
  unlinkSync,
} from 'fs';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Resolve the OpenClaw config directory (~/.openclaw).
 */
export function getOpenClawConfigDirectory(): string {
  return path.join(homedir(), '.openclaw');
}

/**
 * Resolve the OpenClaw extensions directory where plugins are installed.
 */
export function getOpenClawExtensionsDirectory(): string {
  return path.join(getOpenClawConfigDirectory(), 'extensions');
}

/**
 * Resolve the claude-mem extension install directory.
 */
export function getOpenClawClaudeMemExtensionDirectory(): string {
  return path.join(getOpenClawExtensionsDirectory(), 'claude-mem');
}

/**
 * Resolve the path to openclaw.json config file.
 */
export function getOpenClawConfigFilePath(): string {
  return path.join(getOpenClawConfigDirectory(), 'openclaw.json');
}

// ============================================================================
// Pre-built Plugin Location
// ============================================================================

/**
 * Find the pre-built OpenClaw plugin bundle in the npm package.
 * Searches in: openclaw/dist/index.js relative to package root,
 * then the marketplace install location.
 */
export function findPreBuiltPluginDirectory(): string | null {
  const possibleRoots = [
    // Marketplace install location (production — after `npx claude-mem install`)
    path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
      'plugins', 'marketplaces', 'thedotmack',
    ),
    // Development location (relative to project root)
    process.cwd(),
  ];

  for (const root of possibleRoots) {
    const openclawDistDirectory = path.join(root, 'openclaw', 'dist');
    const pluginEntryPoint = path.join(openclawDistDirectory, 'index.js');
    if (existsSync(pluginEntryPoint)) {
      return openclawDistDirectory;
    }
  }

  return null;
}

/**
 * Find the openclaw.plugin.json file for copying alongside the plugin.
 */
export function findPluginManifestPath(): string | null {
  const possibleRoots = [
    path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
      'plugins', 'marketplaces', 'thedotmack',
    ),
    process.cwd(),
  ];

  for (const root of possibleRoots) {
    const manifestPath = path.join(root, 'openclaw', 'openclaw.plugin.json');
    if (existsSync(manifestPath)) {
      return manifestPath;
    }
  }

  return null;
}

/**
 * Find the openclaw skills directory for copying alongside the plugin.
 */
export function findPluginSkillsDirectory(): string | null {
  const possibleRoots = [
    path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
      'plugins', 'marketplaces', 'thedotmack',
    ),
    process.cwd(),
  ];

  for (const root of possibleRoots) {
    const skillsDirectory = path.join(root, 'openclaw', 'skills');
    if (existsSync(skillsDirectory)) {
      return skillsDirectory;
    }
  }

  return null;
}

// ============================================================================
// OpenClaw Config (openclaw.json) Management
// ============================================================================

/**
 * Read openclaw.json safely, returning an empty object if missing or invalid.
 */
function readOpenClawConfig(): Record<string, any> {
  const configFilePath = getOpenClawConfigFilePath();
  if (!existsSync(configFilePath)) return {};
  try {
    return JSON.parse(readFileSync(configFilePath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Write openclaw.json atomically, creating the directory if needed.
 */
function writeOpenClawConfig(config: Record<string, any>): void {
  const configDirectory = getOpenClawConfigDirectory();
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(getOpenClawConfigFilePath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

/**
 * Register claude-mem in openclaw.json by merging into the existing config.
 * Does NOT overwrite the entire file -- only touches the claude-mem entry
 * and the memory slot.
 */
function registerPluginInOpenClawConfig(
  workerPort: number = 37777,
  project: string = 'openclaw',
  syncMemoryFile: boolean = true,
): void {
  const config = readOpenClawConfig();

  // Ensure the plugins structure exists
  if (!config.plugins) config.plugins = {};
  if (!config.plugins.slots) config.plugins.slots = {};
  if (!config.plugins.entries) config.plugins.entries = {};

  // Set the memory slot to claude-mem
  config.plugins.slots.memory = 'claude-mem';

  // Create or update the claude-mem plugin entry
  if (!config.plugins.entries['claude-mem']) {
    config.plugins.entries['claude-mem'] = {
      enabled: true,
      config: {
        workerPort,
        project,
        syncMemoryFile,
      },
    };
  } else {
    // Merge: enable and update config without losing existing user settings
    config.plugins.entries['claude-mem'].enabled = true;
    if (!config.plugins.entries['claude-mem'].config) {
      config.plugins.entries['claude-mem'].config = {};
    }
    const existingPluginConfig = config.plugins.entries['claude-mem'].config;
    // Only set defaults if not already configured
    if (existingPluginConfig.workerPort === undefined) existingPluginConfig.workerPort = workerPort;
    if (existingPluginConfig.project === undefined) existingPluginConfig.project = project;
    if (existingPluginConfig.syncMemoryFile === undefined) existingPluginConfig.syncMemoryFile = syncMemoryFile;
  }

  writeOpenClawConfig(config);
}

/**
 * Remove claude-mem from openclaw.json without deleting other config.
 */
function unregisterPluginFromOpenClawConfig(): void {
  const configFilePath = getOpenClawConfigFilePath();
  if (!existsSync(configFilePath)) return;

  const config = readOpenClawConfig();

  // Remove claude-mem entry
  if (config.plugins?.entries?.['claude-mem']) {
    delete config.plugins.entries['claude-mem'];
  }

  // Clear memory slot if it points to claude-mem
  if (config.plugins?.slots?.memory === 'claude-mem') {
    delete config.plugins.slots.memory;
  }

  writeOpenClawConfig(config);
}

// ============================================================================
// Plugin Installation
// ============================================================================

/**
 * Install the claude-mem plugin into OpenClaw's extensions directory.
 * Copies the pre-built plugin bundle and registers it in openclaw.json.
 *
 * @returns 0 on success, 1 on failure
 */
export function installOpenClawPlugin(): number {
  const preBuiltDistDirectory = findPreBuiltPluginDirectory();
  if (!preBuiltDistDirectory) {
    console.error('Could not find pre-built OpenClaw plugin bundle.');
    console.error('  Expected at: openclaw/dist/index.js');
    console.error('  Ensure the npm package includes the openclaw directory.');
    return 1;
  }

  const extensionDirectory = getOpenClawClaudeMemExtensionDirectory();
  const destinationDistDirectory = path.join(extensionDirectory, 'dist');

  try {
    // Create the extension directory structure
    mkdirSync(destinationDistDirectory, { recursive: true });

    // Copy pre-built dist files
    cpSync(preBuiltDistDirectory, destinationDistDirectory, { recursive: true, force: true });
    console.log(`  Plugin dist copied to: ${destinationDistDirectory}`);

    // Copy openclaw.plugin.json if available
    const manifestPath = findPluginManifestPath();
    if (manifestPath) {
      const destinationManifest = path.join(extensionDirectory, 'openclaw.plugin.json');
      cpSync(manifestPath, destinationManifest, { force: true });
      console.log(`  Plugin manifest copied to: ${destinationManifest}`);
    }

    // Copy skills directory if available
    const skillsDirectory = findPluginSkillsDirectory();
    if (skillsDirectory) {
      const destinationSkills = path.join(extensionDirectory, 'skills');
      cpSync(skillsDirectory, destinationSkills, { recursive: true, force: true });
      console.log(`  Skills copied to: ${destinationSkills}`);
    }

    // Create a minimal package.json for the extension (OpenClaw expects this)
    const extensionPackageJson = {
      name: 'claude-mem',
      version: '1.0.0',
      type: 'module',
      main: 'dist/index.js',
      openclaw: { extensions: ['./dist/index.js'] },
    };
    writeFileSync(
      path.join(extensionDirectory, 'package.json'),
      JSON.stringify(extensionPackageJson, null, 2) + '\n',
      'utf-8',
    );

    // Register in openclaw.json (merge, not overwrite)
    registerPluginInOpenClawConfig();
    console.log(`  Registered in openclaw.json`);

    logger.info('OPENCLAW', 'Plugin installed', { destination: extensionDirectory });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to install OpenClaw plugin: ${message}`);
    return 1;
  }
}

// ============================================================================
// Uninstallation
// ============================================================================

/**
 * Remove the claude-mem plugin from OpenClaw.
 * Removes extension files and unregisters from openclaw.json.
 *
 * @returns 0 on success, 1 on failure
 */
export function uninstallOpenClawPlugin(): number {
  let hasErrors = false;

  // Remove extension directory
  const extensionDirectory = getOpenClawClaudeMemExtensionDirectory();
  if (existsSync(extensionDirectory)) {
    try {
      rmSync(extensionDirectory, { recursive: true, force: true });
      console.log(`  Removed extension: ${extensionDirectory}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  Failed to remove extension directory: ${message}`);
      hasErrors = true;
    }
  }

  // Unregister from openclaw.json
  try {
    unregisterPluginFromOpenClawConfig();
    console.log(`  Unregistered from openclaw.json`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Failed to update openclaw.json: ${message}`);
    hasErrors = true;
  }

  return hasErrors ? 1 : 0;
}

// ============================================================================
// Status Check
// ============================================================================

/**
 * Check OpenClaw integration status.
 *
 * @returns 0 always (informational only)
 */
export function checkOpenClawStatus(): number {
  console.log('\nClaude-Mem OpenClaw Integration Status\n');

  const configDirectory = getOpenClawConfigDirectory();
  const extensionDirectory = getOpenClawClaudeMemExtensionDirectory();
  const configFilePath = getOpenClawConfigFilePath();
  const pluginEntryPoint = path.join(extensionDirectory, 'dist', 'index.js');

  console.log(`Config directory: ${configDirectory}`);
  console.log(`  Exists: ${existsSync(configDirectory) ? 'yes' : 'no'}`);
  console.log('');

  console.log(`Extension directory: ${extensionDirectory}`);
  console.log(`  Exists: ${existsSync(extensionDirectory) ? 'yes' : 'no'}`);
  console.log(`  Plugin entry: ${existsSync(pluginEntryPoint) ? 'yes' : 'no'}`);
  console.log('');

  console.log(`Config (openclaw.json): ${configFilePath}`);
  if (existsSync(configFilePath)) {
    const config = readOpenClawConfig();
    const isRegistered = config.plugins?.entries?.['claude-mem'] !== undefined;
    const isEnabled = config.plugins?.entries?.['claude-mem']?.enabled === true;
    const isMemorySlot = config.plugins?.slots?.memory === 'claude-mem';

    console.log(`  Exists: yes`);
    console.log(`  Registered: ${isRegistered ? 'yes' : 'no'}`);
    console.log(`  Enabled: ${isEnabled ? 'yes' : 'no'}`);
    console.log(`  Memory slot: ${isMemorySlot ? 'yes' : 'no'}`);

    if (isRegistered) {
      const pluginConfig = config.plugins.entries['claude-mem'].config;
      if (pluginConfig) {
        console.log(`  Worker port: ${pluginConfig.workerPort ?? 'default'}`);
        console.log(`  Project: ${pluginConfig.project ?? 'default'}`);
        console.log(`  Sync MEMORY.md: ${pluginConfig.syncMemoryFile ?? 'default'}`);
      }
    }
  } else {
    console.log(`  Exists: no`);
  }

  console.log('');
  return 0;
}

// ============================================================================
// Full Install Flow (used by npx install command)
// ============================================================================

/**
 * Run the full OpenClaw installation: copy plugin + register in config.
 *
 * @returns 0 on success, 1 on failure
 */
export async function installOpenClawIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem for OpenClaw...\n');

  // Step 1: Install plugin files and register in config
  const pluginResult = installOpenClawPlugin();
  if (pluginResult !== 0) {
    return pluginResult;
  }

  const extensionDirectory = getOpenClawClaudeMemExtensionDirectory();

  console.log(`
Installation complete!

Plugin installed to: ${extensionDirectory}
Config updated: ${getOpenClawConfigFilePath()}

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart OpenClaw to load the plugin
  3. Memory capture is automatic from then on
`);

  return 0;
}
