import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MARKETPLACE_ROOT, DATA_DIR, USER_SETTINGS_PATH, expandHome } from '../../shared/paths.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { writeJsonFileAtomic, readJsonFileWithBom } from '../../shared/atomic-json.js';
import { buildSpawnSyncInvocation, lookupWindowsCommand, spawnHidden } from '../../shared/spawn.js';
import type { TranscriptSchema, TranscriptWatchConfig } from '../transcripts/types.js';

const PACKAGE_NAME = '@claude-mem/dsh';
const WATCH_NAME = 'dsh';
const PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function markerPath(): string { return join(DATA_DIR, 'integrations', 'dsh.json'); }
function readInstallState(): { profiles: string[] } {
  if (!existsSync(markerPath())) return { profiles: [] };
  const state = readJsonFileWithBom<{ profiles: string[] }>(markerPath());
  if (!Array.isArray(state.profiles) || !state.profiles.every(profile => typeof profile === 'string' && PROFILE_NAME.test(profile))) {
    throw new Error('Invalid managed DSH profile state: ' + markerPath());
  }
  return state;
}
export function dshWatchConfigPath(): string {
  const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
  return expandHome(settings.CLAUDE_MEM_TRANSCRIPTS_CONFIG_PATH);
}
export function findDshPackage(): string | null {
  const roots = [MARKETPLACE_ROOT];
  if (process.env.CLAUDE_MEM_DEV_HOOK_SOURCE === '1') roots.push(process.cwd());
  for (const root of roots) {
    const dir = join(root, 'dsh');
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'lib', 'index.js'))) return dir;
  }
  return null;
}

function readWatchConfig(): TranscriptWatchConfig {
  const file = dshWatchConfigPath();
  if (!existsSync(file)) return { version: 1, schemas: {}, watches: [], stateFile: join(DATA_DIR, 'transcript-watch-state.json') };
  const config = readJsonFileWithBom<TranscriptWatchConfig>(file);
  if (config.version !== 1 || !Array.isArray(config.watches) || (config.schemas !== undefined && (!config.schemas || typeof config.schemas !== 'object' || Array.isArray(config.schemas)))) {
    throw new Error('Invalid transcript-watch config; repair ' + file + ' and retry.');
  }
  return config;
}
export function installDshTranscriptWatch(packageDir: string): void {
  const config = readWatchConfig();
  const schema = readJsonFileWithBom<TranscriptSchema>(join(packageDir, 'transcript-schema.json'));
  const sessions = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions');
  // An existing DSH watch is already authoritative; do not add a second writer.
  if (!config.watches.some(watch => watch.schema === 'dsh')) {
    if (config.watches.some(watch => watch.name === WATCH_NAME)) throw new Error('A different watch already uses the name dsh.');
    config.schemas ??= {};
    config.schemas.dsh ??= schema;
    const watch = { name: WATCH_NAME, path: sessions, schema: 'dsh', startAtEnd: true, managedBy: 'claude-mem' };
    config.watches.push(watch);
  }
  writeJsonFileAtomic(dshWatchConfigPath(), config);
}
export function uninstallDshTranscriptWatch(): void {
  if (!existsSync(dshWatchConfigPath())) return;
  const config = readWatchConfig();
  config.watches = config.watches.filter(watch => !(watch.name === WATCH_NAME && (watch as typeof watch & { managedBy?: string }).managedBy === 'claude-mem'));
  // A schema may be used by a user-managed watch; it is harmless to keep it.
  writeJsonFileAtomic(dshWatchConfigPath(), config);
}

async function runDsh(profile: string, operation: 'add' | 'remove', target: string): Promise<number> {
  const command = process.platform === 'win32' ? lookupWindowsCommand('dsh') ?? 'dsh.cmd' : 'dsh';
  const invocation = buildSpawnSyncInvocation(command, ['plugin', '--profile', profile, operation, target], {
    encoding: 'utf8', timeout: 120_000,
  });
  return new Promise(resolve => {
    const child = spawnHidden(invocation.command, invocation.args, { ...invocation.options, stdio: 'pipe' });
    let output = '';
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-16_384); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', error => {
      console.error('DSH could not run: ' + error.message + '. Install dsh and pnpm, then retry.');
      resolve(1);
    });
    child.once('close', code => {
      if (code !== 0 && output) console.error(output);
      resolve(code ?? 1);
    });
  });
}

export async function installDeepSeekHarness(profile = 'tui'): Promise<number> {
  if (!PROFILE_NAME.test(profile)) {
    console.error('Invalid DSH profile name.');
    return 1;
  }
  const packageDir = findDshPackage();
  if (!packageDir) {
    console.error('First-party DSH bundle is missing. Restore the package build and re-run install.');
    return 1;
  }
  // Validate user configuration before running DSH or changing its profile.
  let previous: { profiles: string[] };
  try {
    const config = readWatchConfig();
    if (!config.watches.some(watch => watch.schema === 'dsh') && config.watches.some(watch => watch.name === WATCH_NAME)) {
      throw new Error('A different watch already uses the name dsh.');
    }
    previous = readInstallState();
  } catch (error) { console.error(String(error)); return 1; }
  if (await runDsh(profile, 'add', packageDir) !== 0) return 1;
  try {
    installDshTranscriptWatch(packageDir);
    writeJsonFileAtomic(markerPath(), { profiles: [...new Set([...previous.profiles, profile])] });
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_TRANSCRIPTS_ENABLED === 'false') {
      console.error('DSH recall installed, but automatic capture is disabled by CLAUDE_MEM_TRANSCRIPTS_ENABLED=false.');
      return 2;
    }
    console.log('DSH memory installed in profile ' + profile + '. Context and search use the native plugin; the worker captures transcripts once.');
    console.log('Restart DSH to load the plugin. Start or restart the claude-mem worker to pick up the transcript watch.');
    return 0;
  } catch (error) {
    console.error('DSH plugin installed, but transcript setup is incomplete: ' + String(error));
    return 2;
  }
}
export async function uninstallDeepSeekHarness(): Promise<number> {
  if (!existsSync(markerPath())) return 0;
  try {
    const state = readInstallState();
    for (const profile of state.profiles) {
      if (await runDsh(profile, 'remove', PACKAGE_NAME) !== 0) return 1;
    }
    uninstallDshTranscriptWatch();
    rmSync(markerPath(), { force: true });
    return 0;
  } catch (error) { console.error('DSH uninstall failed: ' + String(error)); return 1; }
}
