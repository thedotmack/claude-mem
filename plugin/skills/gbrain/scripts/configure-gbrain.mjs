#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const USAGE = 'usage: configure-gbrain.mjs [--enabled true|false] [--cli-path <path>] [--source <id>] [--slug-prefix <prefix>] [--projects <csv>] [--backfill true|false]';

function fail(message) {
  console.error(`gbrain setup: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const value = argv[index + 1];
    if (!token?.startsWith('--') || value === undefined) fail(USAGE);
    result[token.slice(2)] = value;
  }
  return result;
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value?.startsWith('~/') || value?.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  return value;
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`could not parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveDataDir() {
  if (process.env.CLAUDE_MEM_DATA_DIR) return expandHome(process.env.CLAUDE_MEM_DATA_DIR);
  const defaultDir = path.join(homedir(), '.claude-mem');
  const defaultSettings = path.join(defaultDir, 'settings.json');
  if (!existsSync(defaultSettings)) return defaultDir;
  const parsed = readJson(defaultSettings);
  const flat = parsed.env && typeof parsed.env === 'object' ? parsed.env : parsed;
  return flat.CLAUDE_MEM_DATA_DIR ? expandHome(flat.CLAUDE_MEM_DATA_DIR) : defaultDir;
}

function requireBoolean(name, value) {
  if (value !== 'true' && value !== 'false') fail(`--${name} must be "true" or "false"`);
  return value;
}

function atomicWriteJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tempPath, 0o600);
  renameSync(tempPath, filePath);
}

const args = parseArgs(process.argv.slice(2));
const KNOWN_FLAGS = ['enabled', 'cli-path', 'source', 'slug-prefix', 'projects', 'backfill'];
for (const flag of Object.keys(args)) {
  if (!KNOWN_FLAGS.includes(flag)) fail(`unknown flag --${flag}\n${USAGE}`);
}
if (Object.keys(args).length === 0) fail(USAGE);

// Only write keys for flags that were provided (merge, never clobber).
const updates = {};
if (args.enabled !== undefined) updates.CLAUDE_MEM_GBRAIN_ENABLED = requireBoolean('enabled', args.enabled);
if (args['cli-path'] !== undefined) updates.CLAUDE_MEM_GBRAIN_CLI_PATH = args['cli-path'];
if (args.source !== undefined) updates.CLAUDE_MEM_GBRAIN_SOURCE = args.source;
if (args['slug-prefix'] !== undefined) updates.CLAUDE_MEM_GBRAIN_SLUG_PREFIX = args['slug-prefix'];
if (args.projects !== undefined) updates.CLAUDE_MEM_GBRAIN_PROJECTS = args.projects;
if (args.backfill !== undefined) updates.CLAUDE_MEM_GBRAIN_BACKFILL_ENABLED = requireBoolean('backfill', args.backfill);

const dataDir = resolveDataDir();
const settingsPath = path.join(dataDir, 'settings.json');
const parsed = existsSync(settingsPath) ? readJson(settingsPath) : {};
const settings = parsed.env && typeof parsed.env === 'object' ? parsed.env : parsed;

Object.assign(settings, updates);
atomicWriteJson(settingsPath, parsed === settings ? settings : parsed);

console.log(JSON.stringify({
  ok: true,
  settingsPath,
  updatedKeys: Object.keys(updates),
}, null, 2));
