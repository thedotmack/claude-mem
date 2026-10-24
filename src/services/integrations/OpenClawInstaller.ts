
import path from 'path';
import { homedir } from 'os';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { LIBRARY_GROUPS } from '../wire-gateway/library/agent-library-targets.js';
import { applyLibraryForInstaller, removeLibraryForInstaller } from '../wire-gateway/library/library-runtime.js';
import type { ConfigMemberItem, LibraryConfigEdit, LibraryItem, LibraryMigration, LibraryValue, OwnedFileItem } from '../wire-gateway/library/types.js';

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

const OPENCLAW_MARKETPLACE_ROOTS = [
  path.join(
    process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
    'plugins', 'marketplaces', 'thedotmack',
  ),
  process.cwd(),
];

export function findPreBuiltPluginDirectory(): string | null {
  for (const root of OPENCLAW_MARKETPLACE_ROOTS) {
    const openclawDistDirectory = path.join(root, 'openclaw', 'dist');
    const pluginEntryPoint = path.join(openclawDistDirectory, 'index.js');
    if (existsSync(pluginEntryPoint)) {
      return openclawDistDirectory;
    }
  }

  return null;
}

export function findPluginManifestPath(): string | null {
  for (const root of OPENCLAW_MARKETPLACE_ROOTS) {
    const manifestPath = path.join(root, 'openclaw', 'openclaw.plugin.json');
    if (existsSync(manifestPath)) {
      return manifestPath;
    }
  }

  return null;
}

export function findPluginSkillsDirectory(): string | null {
  for (const root of OPENCLAW_MARKETPLACE_ROOTS) {
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

const ENTRY_PATH = ['plugins', 'entries', 'claude-mem'];

/**
 * claude-mem in openclaw.json: the memory slot, and the plugin entry enabled
 * with its config defaults. A value the user already set in the plugin's
 * config is kept (each default is written only where absent).
 */
function openclawConfigItems(workerPort: number, project: string = 'openclaw', syncMemoryFile: boolean = true): LibraryItem[] {
  const file = getOpenClawConfigFilePath();
  // Everything under claude-mem's own plugin entry is claude-mem's, and so is a
  // memory slot naming claude-mem: found before the first write, it came from
  // an install before the record, so a remove takes it out (with the
  // pre-Library cleanup below) instead of putting it back.
  const setting = (id: string, keyPath: string[], value: LibraryValue, onlyWhenAbsent = false): ConfigMemberItem => ({
    kind: 'setting', id: `setting:${id}`, group: LIBRARY_GROUPS.settings, place: 'member', file, format: 'json',
    keyPath, value, whenUnrecorded: 'replace-and-stash', ...(onlyWhenAbsent ? { onlyWhenAbsent: true } : {}),
    isPreLibraryValue: () => true,
  });
  return [
    { ...setting('memory-slot', ['plugins', 'slots', 'memory'], 'claude-mem'), isPreLibraryValue: (current) => current === 'claude-mem' },
    setting('enabled', [...ENTRY_PATH, 'enabled'], true),
    setting('worker-port', [...ENTRY_PATH, 'config', 'workerPort'], workerPort, true),
    setting('project', [...ENTRY_PATH, 'config', 'project'], project, true),
    setting('sync-memory-file', [...ENTRY_PATH, 'config', 'syncMemoryFile'], syncMemoryFile, true),
  ];
}

/** Every file of a folder, relative path → bytes, in a stable order. */
function filesUnder(directory: string, prefix = ''): Array<[string, Uint8Array]> {
  const found: Array<[string, Uint8Array]> = [];
  for (const name of readdirSync(directory).sort()) {
    const source = path.join(directory, name);
    const relativePath = prefix ? path.join(prefix, name) : name;
    if (statSync(source).isDirectory()) found.push(...filesUnder(source, relativePath));
    else found.push([relativePath, readFileSync(source)]);
  }
  return found;
}

/** The extension folder's files: the built dist, the manifest, the skills and a package.json, all claude-mem's. */
function openclawBundleItems(preBuiltDistDirectory: string, manifestPath: string | null, skillsDirectory: string | null): OwnedFileItem[] {
  const extensionDirectory = getOpenClawClaudeMemExtensionDirectory();
  const extensionPackageJson = {
    name: 'claude-mem',
    version: '1.0.0',
    type: 'module',
    main: 'dist/index.js',
    openclaw: { extensions: ['./dist/index.js'] },
  };
  const files: Array<[string, Uint8Array]> = filesUnder(preBuiltDistDirectory).map(([relativePath, bytes]) => [path.join('dist', relativePath), bytes]);
  if (manifestPath) files.push(['openclaw.plugin.json', readFileSync(manifestPath)]);
  if (skillsDirectory) files.push(...filesUnder(skillsDirectory).map(([relativePath, bytes]): [string, Uint8Array] => [path.join('skills', relativePath), bytes]));
  files.push(['package.json', new TextEncoder().encode(JSON.stringify(extensionPackageJson, null, 2) + '\n')]);
  return files.map(([relativePath, contents]) => ({
    kind: 'bundle', id: `bundle:${relativePath}`, group: LIBRARY_GROUPS.bundle, place: 'file',
    path: path.join(extensionDirectory, relativePath), contents, bundleRoot: extensionDirectory,
  }));
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
  const manifestPath = findPluginManifestPath();
  const skillsDirectory = findPluginSkillsDirectory();

  try {
    readOpenClawConfig(); // an openclaw.json that does not parse stops the install before anything is copied
    applyLibraryForInstaller({
      agentId: 'openclaw',
      items: [...openclawBundleItems(preBuiltDistDirectory, manifestPath, skillsDirectory), ...openclawConfigItems(getWorkerPort())],
      ownedGroups: [LIBRARY_GROUPS.bundle, LIBRARY_GROUPS.settings],
    });
    console.log(`  Plugin dist copied to: ${path.join(extensionDirectory, 'dist')}`);
    if (manifestPath) console.log(`  Plugin manifest copied to: ${path.join(extensionDirectory, 'openclaw.plugin.json')}`);
    if (skillsDirectory) console.log(`  Skills copied to: ${path.join(extensionDirectory, 'skills')}`);
    console.log(`  Registered in openclaw.json`);
    logger.info('OPENCLAW', 'Plugin installed', { destination: extensionDirectory });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to install OpenClaw plugin: ${message}`);
    return 1;
  }
}

/**
 * openclaw.json as an install from before the Library left it: the memory
 * slot when it names claude-mem, and claude-mem's plugin entry.
 */
function openclawPreLibraryRemoval(): LibraryMigration {
  return {
    file: getOpenClawConfigFilePath(),
    format: 'json',
    compute: (document) => {
      const plugins = (document as { plugins?: { slots?: Record<string, unknown>; entries?: Record<string, unknown> } }).plugins;
      const edits: LibraryConfigEdit[] = [];
      if (plugins?.entries && Object.hasOwn(plugins.entries, 'claude-mem')) edits.push({ op: 'delete', keyPath: ENTRY_PATH });
      if (plugins?.slots?.memory === 'claude-mem') edits.push({ op: 'delete', keyPath: ['plugins', 'slots', 'memory'] });
      return edits;
    },
  };
}

export function uninstallOpenClawPlugin(): number {
  const extensionDirectory = getOpenClawClaudeMemExtensionDirectory();
  try {
    const result = removeLibraryForInstaller({
      agentId: 'openclaw',
      // Files in claude-mem's own extension folder that an install before the Library record copied.
      items: existsSync(extensionDirectory)
        ? filesUnder(extensionDirectory).map(([relativePath]): OwnedFileItem => ({
          kind: 'bundle', id: `bundle:${relativePath}`, group: LIBRARY_GROUPS.bundle, place: 'file',
          path: path.join(extensionDirectory, relativePath), contents: new Uint8Array(0), bundleRoot: extensionDirectory,
        }))
        : [],
      migrations: [openclawPreLibraryRemoval()],
    });
    const bundleFilesRemoved = result.items.some((item) => item.kind === 'bundle' && (item.outcome === 'removed' || item.outcome === 'restored'));
    console.log(bundleFilesRemoved ? `  Removed extension: ${extensionDirectory}` : `  No claude-mem extension files to remove in ${extensionDirectory}`);
    console.log(result.filesWritten.includes(getOpenClawConfigFilePath()) ? `  Unregistered from openclaw.json` : `  openclaw.json held no claude-mem entries`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  Failed to uninstall OpenClaw plugin: ${message}`);
    return 1;
  }
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
