import { readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { logger } from '../utils/logger.js';
import { stripJsonComments, stripUtf8Bom } from './atomic-json.js';

/**
 * The parts of the host's own OpenCode configuration claude-mem may reuse: the
 * default model, the small model and custom provider definitions. Tools,
 * plugins, MCP servers, permissions and agents are deliberately not carried
 * over; a caller gets exactly these three fields (plus opt-in provenance),
 * whatever else the host file holds. An unreadable or absent file yields
 * nothing, never an error.
 */
export interface OpenCodeHostConfig {
  model?: string;
  smallModel?: string;
  provider?: Record<string, unknown>;
  /**
   * Field-by-field provenance, present only when the caller passes
   * `includeSources: true`; the default shape stays the three fields above.
   */
  sources?: {
    model?: HostConfigSource;
    smallModel?: HostConfigSource;
    provider?: HostConfigSource;
  };
}

/**
 * Where a host config value came from: machine `system`, user `global`,
 * `project`, or an `explicit` file (highest precedence). This is the one
 * definition of the visible source states; labels and readers take it from
 * here (see docs/architecture/state-machines.md). The `system` kind covers both
 * the managed and the machine-wide file; their paths tell them apart.
 */
export type HostConfigSourceKind = 'system' | 'global' | 'project' | 'explicit';

/** The one human wording of each source kind, used by the doctor output in PR 2. */
export const HOST_CONFIG_SOURCE_LABELS: Record<HostConfigSourceKind, string> = {
  system: 'system configuration',
  global: 'global configuration',
  project: 'project configuration',
  explicit: 'explicit OPENCODE_CONFIG file',
};

export interface HostConfigSource {
  kind: HostConfigSourceKind;
  path: string;
}

export interface ReadOpenCodeHostConfigOptions {
  /** Project directory whose own config, and its parents' configs, are read. */
  cwd?: string;
  /** An explicit config directory, ahead of every environment variable. */
  configDir?: string;
  /** Also read the project config found from `cwd` (nearest wins). */
  includeProject?: boolean;
  /**
   * How an explicit `OPENCODE_CONFIG` file combines with the other sources:
   * `merge` (default) overrides their fields one by one; `replace` discards
   * them entirely when the explicit file is readable, as My Work always did.
   */
  explicitConfigMode?: 'merge' | 'replace';
  /** Attach field-by-field provenance to the result; off by default. */
  includeSources?: boolean;
  /**
   * System config directories, first entry highest priority. Overrides the
   * OS-derived list and is ignored entirely when `configDir` is supplied.
   */
  systemConfigDirs?: readonly string[];
}

const CONFIG_FILENAMES = ['opencode.json', 'opencode.jsonc'] as const;

/** Bounded so repeated bad paths can neither spam warnings nor grow without limit. */
const MAX_RECORDED_READ_FAILURES = 64;
const warnedReadFailurePaths = new Set<string>();
const readFailures: Array<{ path: string; reason: string }> = [];

/** Remember a bad path once, evicting the oldest entry when the bound is reached. */
function recordReadFailure(path: string, reason: string): void {
  if (warnedReadFailurePaths.has(path)) return;
  if (warnedReadFailurePaths.size >= MAX_RECORDED_READ_FAILURES) {
    const oldest = warnedReadFailurePaths.values().next().value;
    if (oldest !== undefined) {
      warnedReadFailurePaths.delete(oldest);
      const index = readFailures.findIndex(failure => failure.path === oldest);
      if (index !== -1) readFailures.splice(index, 1);
    }
  }
  warnedReadFailurePaths.add(path);
  readFailures.push({ path, reason });
  logger.warn('SDK', `Cannot read OpenCode config at ${path}: ${reason}`);
}

/** Read failures already reported, in the order they were first seen. */
export function getOpenCodeHostConfigReadFailures(): ReadonlyArray<{ path: string; reason: string }> {
  return readFailures.map(failure => ({ ...failure }));
}

/** Clears the warn-once state; only for tests that need to observe a fresh warning. */
export function resetOpenCodeHostConfigReadFailuresForTesting(): void {
  warnedReadFailurePaths.clear();
  readFailures.length = 0;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** `agents.title.model` is the V2 form of the small model; `small_model` the V1 form. */
function extractConfig(parsed: unknown): OpenCodeHostConfig {
  const record = plainObject(parsed);
  if (!record) return {};
  const titleAgent = plainObject(plainObject(record.agents)?.title);
  const model = nonEmptyString(record.model);
  const smallModel = nonEmptyString(titleAgent?.model) ?? nonEmptyString(record.small_model);
  // V2 renamed `provider` to `providers`; when both are present, V2 wins.
  const provider = plainObject(record.providers) ?? plainObject(record.provider);
  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { smallModel } : {}),
    ...(provider ? { provider } : {}),
  };
}

interface ReadConfigFileResult {
  config: OpenCodeHostConfig;
  source: HostConfigSource;
}

function readConfigFile(
  path: string | undefined,
  kind: HostConfigSourceKind,
): ReadConfigFileResult | undefined {
  if (!path) return undefined;
  let raw: string;
  try {
    // Read directly: existsSync also returns false when a parent directory is
    // unreadable, which would hide a real permission failure from diagnostics.
    raw = readFileSync(path, 'utf8');
  } catch (error: unknown) {
    // A missing path is normal: several candidates are probed in order.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // Other filesystem errors name the path but not the file's contents.
    const reason = error instanceof Error ? error.message : String(error);
    recordReadFailure(path, reason);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(stripUtf8Bom(raw)));
  } catch {
    // JSON/JSONC errors can quote nearby text (e.g. an unquoted key whose value
    // is an API key). Keep the path for diagnosis, never the parser's message.
    recordReadFailure(path, 'invalid JSON (parse details omitted to avoid leaking file contents)');
    return undefined;
  }
  return { config: extractConfig(parsed), source: { kind, path } };
}

/** Both configs in `directory` merged, with `opencode.jsonc` winning each conflict. */
function readDirectoryConfig(directory: string, kind: HostConfigSourceKind): OpenCodeHostConfig {
  let config: OpenCodeHostConfig = {};
  for (const name of CONFIG_FILENAMES) {
    const file = readConfigFile(join(directory, name), kind);
    config = mergeConfig(config, file?.config, file?.source);
  }
  return config;
}

/**
 * OpenCode reads both `opencode.json(c)` and `.opencode/opencode.json(c)` in a
 * project; the `.opencode` form overrides the direct one in the same directory.
 */
function readProjectDirectoryConfig(directory: string): OpenCodeHostConfig {
  return mergeConfig(
    readDirectoryConfig(directory, 'project'),
    readDirectoryConfig(join(directory, '.opencode'), 'project'),
  );
}

/** Merge provider entries by id, and their `models` maps by key; the override wins on collisions. */
function mergeProviders(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [id, value] of Object.entries(override)) {
    const baseEntry = plainObject(merged[id]);
    const overrideEntry = plainObject(value);
    if (!baseEntry || !overrideEntry) {
      merged[id] = value;
      continue;
    }
    const entry: Record<string, unknown> = { ...baseEntry, ...overrideEntry };
    const baseModels = plainObject(baseEntry.models);
    const overrideModels = plainObject(overrideEntry.models);
    if (baseModels && overrideModels) entry.models = { ...baseModels, ...overrideModels };
    merged[id] = entry;
  }
  return merged;
}

type HostConfigSources = NonNullable<OpenCodeHostConfig['sources']>;

/**
 * Merge fields one by one, providers by id and their models by key. An explicit
 * `source` is the file the override was read from; a config merged earlier
 * already carries its own per-field sources, used as the fallback.
 */
function mergeConfig(
  base: OpenCodeHostConfig,
  override: OpenCodeHostConfig | undefined,
  source?: HostConfigSource,
): OpenCodeHostConfig {
  if (!override) return base;
  const merged: OpenCodeHostConfig = { ...base };
  const sources: HostConfigSources = { ...base.sources };
  const from = (field: keyof HostConfigSources): HostConfigSource | undefined =>
    source ?? override.sources?.[field];

  if (override.model !== undefined) {
    merged.model = override.model;
    const modelSource = from('model');
    if (modelSource) sources.model = modelSource;
  }
  if (override.smallModel !== undefined) {
    merged.smallModel = override.smallModel;
    const smallModelSource = from('smallModel');
    if (smallModelSource) sources.smallModel = smallModelSource;
  }
  if (override.provider !== undefined) {
    const baseProvider = plainObject(base.provider);
    const overrideProvider = plainObject(override.provider);
    merged.provider = baseProvider && overrideProvider
      ? mergeProviders(baseProvider, overrideProvider)
      : override.provider;
    // Even a merged provider map is attributed to the last file that wrote it.
    const providerSource = from('provider');
    if (providerSource) sources.provider = providerSource;
  }
  merged.sources = sources;
  return merged;
}

function configDirectory(explicit: string | undefined): string {
  if (explicit) return explicit;
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
}

/**
 * Machine-wide config locations, first entry highest priority. Dependency on
 * the OS comes from the argument, never from mutating `process.platform`.
 */
export function systemConfigDirectories(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'linux') return ['/etc/opencode'];
  if (platform === 'darwin') {
    return ['/Library/Managed Preferences/opencode', '/Library/Application Support/opencode'];
  }
  if (platform === 'win32') {
    return [join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'opencode')];
  }
  return [];
}

/** Sources are internal bookkeeping until the caller opts into seeing them. */
function withoutSources(config: OpenCodeHostConfig, includeSources: boolean | undefined): OpenCodeHostConfig {
  if (includeSources === true) return config;
  const visible: OpenCodeHostConfig = { ...config };
  delete visible.sources;
  return visible;
}

/** `directory` and every parent, farthest first, so a nearer config wins when merged. */
function ancestorDirectories(directory: string): string[] {
  const directories: string[] = [];
  let current = resolve(directory);
  for (;;) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current) return directories.reverse();
    current = parent;
  }
}

/**
 * The host's effective OpenCode model, small model and providers.
 *
 * Sources, lowest precedence first: the global config directory, the machine's
 * system config directories, the project configs found from `cwd` (farthest
 * parent to `cwd`, nearest wins), then an explicit `OPENCODE_CONFIG` file, which
 * always wins. That order is the 2026-11-26 ruling and keeps a project config
 * ahead of the global one. `systemConfigDirs` is highest priority first and is
 * merged in reverse; supplying `configDir` skips system locations altogether.
 * `configDir` also replaces the global lookup (`OPENCODE_CONFIG_DIR`,
 * `XDG_CONFIG_HOME`, then `~/.config/opencode`) without changing other steps.
 * `model` and `smallModel` merge one by one; providers merge by provider id and
 * model key, with the nearest level winning each collision. With
 * `explicitConfigMode: 'replace'`, a readable `OPENCODE_CONFIG` replaces every
 * other source outright instead of merging into it. `sources` is returned only
 * when `includeSources` is true.
 */
export function readOpenCodeHostConfig(options: ReadOpenCodeHostConfigOptions = {}): OpenCodeHostConfig {
  let config = readDirectoryConfig(configDirectory(options.configDir), 'global');
  if (!options.configDir) {
    const directories = options.systemConfigDirs ?? systemConfigDirectories();
    for (const directory of [...directories].reverse()) {
      config = mergeConfig(config, readDirectoryConfig(directory, 'system'));
    }
  }
  if (options.includeProject && options.cwd) {
    for (const directory of ancestorDirectories(options.cwd)) {
      config = mergeConfig(config, readProjectDirectoryConfig(directory));
    }
  }
  const explicit = readConfigFile(process.env.OPENCODE_CONFIG, 'explicit');
  if (explicit && options.explicitConfigMode === 'replace') {
    return withoutSources(mergeConfig({}, explicit.config, explicit.source), options.includeSources);
  }
  return withoutSources(mergeConfig(config, explicit?.config, explicit?.source), options.includeSources);
}
