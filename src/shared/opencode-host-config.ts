import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { stripJsonComments, stripUtf8Bom } from './atomic-json.js';

/**
 * The parts of the host's own OpenCode configuration claude-mem may reuse: the
 * default model, the small model and custom provider definitions. Tools,
 * plugins, MCP servers, permissions and agents are deliberately not carried
 * over; a caller gets exactly these three fields, whatever else the host file
 * holds. An unreadable or absent file yields nothing, never an error.
 */
export interface OpenCodeHostConfig {
  model?: string;
  smallModel?: string;
  provider?: Record<string, unknown>;
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
}

const CONFIG_FILENAMES = ['opencode.json', 'opencode.jsonc'] as const;

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
  const provider = plainObject(record.provider);
  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { smallModel } : {}),
    ...(provider ? { provider } : {}),
  };
}

function readConfigFile(path: string | undefined): OpenCodeHostConfig | undefined {
  if (!path) return undefined;
  try {
    if (!existsSync(path)) return undefined;
    return extractConfig(JSON.parse(stripJsonComments(stripUtf8Bom(readFileSync(path, 'utf8')))));
  } catch {
    // An unreadable or malformed host config must never fail the caller.
    return undefined;
  }
}

/** The first readable config in `directory`, keeping `opencode.json` ahead of `opencode.jsonc`. */
function readDirectoryConfig(directory: string): OpenCodeHostConfig {
  for (const name of CONFIG_FILENAMES) {
    const config = readConfigFile(join(directory, name));
    if (config) return config;
  }
  return {};
}

/**
 * OpenCode reads both `opencode.json(c)` and `.opencode/opencode.json(c)` in a
 * project; the `.opencode` form overrides the direct one in the same directory.
 */
function readProjectDirectoryConfig(directory: string): OpenCodeHostConfig {
  return mergeConfig(
    readDirectoryConfig(directory),
    readDirectoryConfig(join(directory, '.opencode')),
  );
}

function mergeConfig(base: OpenCodeHostConfig, override: OpenCodeHostConfig | undefined): OpenCodeHostConfig {
  if (!override) return base;
  const merged: OpenCodeHostConfig = { ...base };
  if (override.model !== undefined) merged.model = override.model;
  if (override.smallModel !== undefined) merged.smallModel = override.smallModel;
  if (override.provider !== undefined) merged.provider = override.provider;
  return merged;
}

function configDirectory(explicit: string | undefined): string {
  if (explicit) return explicit;
  if (process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode');
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
 * Sources, lowest precedence first: the global config directory, the project
 * configs found from `cwd` (farthest parent to `cwd`, nearest wins), then an
 * explicit `OPENCODE_CONFIG` file, which always wins. `configDir` replaces the
 * global directory lookup (`OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, then
 * `~/.config/opencode`) without changing any other step. Fields merge one by
 * one: a nearer `model`, `smallModel` or `provider` replaces that whole field.
 * With `explicitConfigMode: 'replace'`, a readable `OPENCODE_CONFIG` replaces
 * every other source outright instead of merging into it.
 */
export function readOpenCodeHostConfig(options: ReadOpenCodeHostConfigOptions = {}): OpenCodeHostConfig {
  let config = readDirectoryConfig(configDirectory(options.configDir));
  if (options.includeProject && options.cwd) {
    for (const directory of ancestorDirectories(options.cwd)) {
      config = mergeConfig(config, readProjectDirectoryConfig(directory));
    }
  }
  const explicit = readConfigFile(process.env.OPENCODE_CONFIG);
  if (explicit && options.explicitConfigMode === 'replace') return explicit;
  return mergeConfig(config, explicit);
}
