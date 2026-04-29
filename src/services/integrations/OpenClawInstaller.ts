
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
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';

export function getOpenClawConfigDirectory(): string {
  return path.join(homedir(), '.openclaw');
}

export function getOpenClawExtensionsDirectory(): string {
  return path.join(getOpenClawConfigDirectory(), 'extensions');
}

export function getOpenClawClaudeMemExtensionDirectory(): string {
  return path.join(getOpenClawExtensionsDirectory(), 'claude-mem');
}

export function getOpenClawConfigFilePath(): string {
  return path.join(getOpenClawConfigDirectory(), 'openclaw.json');
}

export function findPreBuiltPluginDirectory(): string | null {
  const possibleRoots = [
    path.join(
      process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
      'plugins', 'marketplaces', 'thedotmack',
    ),
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

function readOpenClawConfig(): Record<string, any> {
  const configFilePath = getOpenClawConfigFilePath();
  if (!existsSync(configFilePath)) return {};
  try {
    return JSON.parse(readFileSync(configFilePath, 'utf-8'));
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    logger.error('WORKER', 'Failed to parse openclaw.json', { path: configFilePath }, normalizedError);
    throw normalizedError;
  }
}

function writeOpenClawConfig(config: Record<string, any>): void {
  const configDirectory = getOpenClawConfigDirectory();
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(getOpenClawConfigFilePath(), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function registerPluginInOpenClawConfig(
  workerPort: number,
  project: string = 'openclaw',
  syncMemoryFile: boolean = true,
): void {
  const config = readOpenClawConfig();

  if (!config.plugins) config.plugins = {};
  if (!config.plugins.slots) config.plugins.slots = {};
  if (!config.plugins.entries) config.plugins.entries = {};

  config.plugins.slots.memory = 'claude-mem';

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
    config.plugins.entries['claude-mem'].enabled = true;
    if (!config.plugins.entries['claude-mem'].config) {
      config.plugins.entries['claude-mem'].config = {};
    }
    const existingPluginConfig = config.plugins.entries['claude-mem'].config;
    if (existingPluginConfig.workerPort === undefined) existingPluginConfig.workerPort = workerPort;
    if (existingPluginConfig.project === undefined) existingPluginConfig.project = project;
    if (existingPluginConfig.syncMemoryFile === undefined) existingPluginConfig.syncMemoryFile = syncMemoryFile;
  }

  writeOpenClawConfig(config);
}

function unregisterPluginFromOpenClawConfig(): void {
  const configFilePath = getOpenClawConfigFilePath();
  if (!existsSync(configFilePath)) return;

  const config = readOpenClawConfig();

  if (config.plugins?.entries?.['claude-mem']) {
    delete config.plugins.entries['claude-mem'];
  }

  if (config.plugins?.slots?.memory === 'claude-mem') {
    delete config.plugins.slots.memory;
  }

  writeOpenClawConfig(config);
}

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

  const manifestPath = findPluginManifestPath();
  const skillsDirectory = findPluginSkillsDirectory();

  const extensionPackageJson = {
    name: 'claude-mem',
    version: '1.0.0',
    type: 'module',
    main: 'dist/index.js',
    openclaw: { extensions: ['./dist/index.js'] },
  };

  try {
    mkdirSync(destinationDistDirectory, { recursive: true });
    copyPluginFilesAndRegister(preBuiltDistDirectory, destinationDistDirectory, extensionDirectory, manifestPath, skillsDirectory, extensionPackageJson);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to install OpenClaw plugin: ${message}`);
    return 1;
  }
}

function copyPluginFilesAndRegister(
  preBuiltDistDirectory: string,
  destinationDistDirectory: string,
  extensionDirectory: string,
  manifestPath: string | null,
  skillsDirectory: string | null,
  extensionPackageJson: Record<string, unknown>,
): void {
  cpSync(preBuiltDistDirectory, destinationDistDirectory, { recursive: true, force: true });
  console.log(`  Plugin dist copied to: ${destinationDistDirectory}`);

  if (manifestPath) {
    const destinationManifest = path.join(extensionDirectory, 'openclaw.plugin.json');
    cpSync(manifestPath, destinationManifest, { force: true });
    console.log(`  Plugin manifest copied to: ${destinationManifest}`);
  }

  if (skillsDirectory) {
    const destinationSkills = path.join(extensionDirectory, 'skills');
    cpSync(skillsDirectory, destinationSkills, { recursive: true, force: true });
    console.log(`  Skills copied to: ${destinationSkills}`);
  }

  writeFileSync(
    path.join(extensionDirectory, 'package.json'),
    JSON.stringify(extensionPackageJson, null, 2) + '\n',
    'utf-8',
  );

  const workerPort = SettingsDefaultsManager.getInt('CLAUDE_MEM_WORKER_PORT');
  registerPluginInOpenClawConfig(workerPort);
  console.log(`  Registered in openclaw.json`);

  logger.info('OPENCLAW', 'Plugin installed', { destination: extensionDirectory });
}

export function uninstallOpenClawPlugin(): number {
  let hasErrors = false;

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

export async function installOpenClawIntegration(): Promise<number> {
  console.log('\nInstalling Claude-Mem for OpenClaw...\n');

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
