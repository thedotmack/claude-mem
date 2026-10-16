// SPDX-License-Identifier: Apache-2.0
//
// `claude-mem wire preview <agent> [--disconnect]` (plan Phase 8 task 4).
// The real connect (or disconnect) runs in a subprocess against a copy of the
// agent's config folders and of claude-mem's wiring records, under
// <DATA_DIR>/wire-gateway/tmp/preview-<rand>/ (never the OS temp dir), with
// HOME, XDG_* and the agent home variables pointed into the copy. The copy is
// then diffed against the originals. Modeled on magpie
// internal/agent/preview.go:90-292 (MIT, Copyright (c) 2026 yetone).

import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, sep } from 'path';
import { WIRE_GATEWAY_DIR_MODE, WIRE_GATEWAY_FILE_MODE } from '../../../shared/paths.js';
import { sanitizeEnv } from '../../../supervisor/env-sanitizer.js';
import { readConfigFileBytes } from '../edit/config-file.js';
import { decodeConfigText } from '../edit/text-shape.js';
import type { AgentDescriptor, AgentEnvironment } from '../agents/types.js';
import { diffConfigLines, type ConfigDiffLine } from './config-diff.js';
import { readAppliedRecords, WIRING_RECORDS_VERSION } from './wiring-records.js';
import type { WireGatewayCaptureSource } from '../routes.js';

/** Copied per folder: regular files up to this size. */
const MAX_COPIED_FILE_BYTES = 16 * 1024 * 1024;
/** Databases and logs are never config (magpie preview.go). */
const SKIPPED_FILE_SUFFIXES = ['.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.db-wal', '.db-shm', '.jsonl', '.log'];
const PREVIEW_SUBPROCESS_TIMEOUT_MS = 20_000;

/** The flag the subprocess gets: connect/disconnect without the daemon, OS service or probe. */
export const PREVIEW_SANDBOX_FLAG = '--preview-sandbox';

/**
 * Variables that move into the sandbox (magpie preview.go previewEnv plus
 * internal/agentenv Vars). A value under home is re-rooted at the sandbox
 * home; one outside home is dropped.
 */
export const PREVIEW_RELOCATED_VARIABLES = [
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'CLAUDE_CODE_TMPDIR', 'CODEX_SQLITE_HOME', 'GEMINI_CLI_HOME',
  'CLINE_DIR', 'CLINE_DATA_DIR', 'CLINE_SESSION_DATA_DIR', 'CLINE_MCP_SETTINGS_PATH',
  'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_CONFIG_DIR', 'PI_PROFILE', 'OMO_CODING_AGENT_DIR',
  'SENPI_CODING_AGENT_DIR', 'PRIME_AGENT_CODING_AGENT_DIR', 'STEP_CODING_AGENT_DIR', 'STEPCODE_CONFIG_DIR', 'OMP_PROFILE',
  'QODER_CONFIG_DIR', 'QODERCN_CONFIG_DIR', 'GROK_HOME', 'GROK_BIN_DIR', 'GROK_APP_HOME', 'KIMI_CODE_HOME', 'KIMI_SHARE_DIR', 'QWEN_HOME',
  'ANTE_HOME', 'ASTRBOT_ROOT', 'JCODE_HOME', 'MIMOCODE_HOME', 'MINIMAX_DATA_DIR', 'HANA_HOME', 'HERMES_HOME', 'DSH_HOME',
  'WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'DEVECO_CONFIG_DIR', 'ALMA_DATA_DIR', 'REASONIX_HOME', 'REASONIX_STATE_HOME',
  'PI_DESKTOP_DATA_DIR', 'MISTER_MORPH_CONFIG', 'T3CODE_HOME', 'ATOMCODE_HOME', 'SNOW_CONFIG_DIR',
  'CURSOR_CONFIG_DIR', 'CURSOR_DATA_DIR', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DB', 'OPENCHAMBER_DATA_DIR', 'FACTORY_HOME_OVERRIDE',
  'NVM_DIR', 'FNM_DIR', 'MISE_DATA_DIR', 'ASDF_DIR', 'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUDSDK_CONFIG',
];

/** Profile names, not paths: they keep their value. */
const NAME_VALUED_VARIABLES = new Set(['PI_PROFILE', 'OMP_PROFILE', 'PI_CONFIG_DIR']);

export interface PreviewOptions {
  descriptor: AgentDescriptor;
  disconnect: boolean;
  /** Passed to the sandboxed connect, so it keeps the capture source the real one would pick. */
  captureSource?: WireGatewayCaptureSource;
  /** The real environment (its home is what gets copied). */
  environment: AgentEnvironment;
  /** <DATA_DIR> and <DATA_DIR>/wire-gateway of the real install. */
  dataDirectory: string;
  wireGatewayDirectory: string;
  bunPath: string;
  scriptPath: string;
}

export interface PreviewFileChange {
  /** `~/…` for display. */
  displayPath: string;
  created: boolean;
  removed: boolean;
  lines: ConfigDiffLine[];
}

export interface PreviewResult {
  changes: PreviewFileChange[];
  /** What the sandboxed command printed. */
  commandOutput: string;
}

function isInside(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

class PreviewSandbox {
  readonly root: string;
  readonly home: string;
  readonly dataDirectory: string;

  constructor(private readonly realHome: string, wireGatewayDirectory: string) {
    this.root = join(wireGatewayDirectory, 'tmp', `preview-${randomBytes(8).toString('hex')}`);
    this.home = join(this.root, 'home');
    this.dataDirectory = join(this.root, 'data');
    mkdirSync(this.home, { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
    mkdirSync(this.dataDirectory, { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
  }

  /** A real path under home, in the sandbox home. Refuses one outside home. */
  mirror(realPath: string): string {
    if (!isInside(this.realHome, realPath)) {
      throw new Error(`wire preview copies files under your home only; ${realPath} is outside it`);
    }
    return join(this.home, relative(this.realHome, realPath));
  }

  displayPath(realPath: string): string {
    return `~/${relative(this.realHome, realPath).split(sep).join('/')}`;
  }
}

function copyRegularFile(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
  copyFileSync(source, destination);
}

/** The top-level regular files of a folder (magpie: subfolders are not config). */
function configFilesIn(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => !SKIPPED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix)))
    .map((name) => join(directory, name))
    .filter((path) => {
      const stats = statSync(path);
      return stats.isFile() && stats.size <= MAX_COPIED_FILE_BYTES;
    });
}

/** The env the sandboxed command runs with. A user descriptor's own path variables move too. */
function previewEnvironment(realEnvironment: AgentEnvironment, sandbox: PreviewSandbox, descriptor: AgentDescriptor): Record<string, string> {
  const relocated = new Set([...PREVIEW_RELOCATED_VARIABLES, ...(descriptor.pathVariables ?? [])]);
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(sanitizeEnv({ ...realEnvironment.env }))) {
    if (value === undefined || name === 'HOME' || name === 'USERPROFILE' || name === 'TMPDIR') continue;
    if (relocated.has(name) && !NAME_VALUED_VARIABLES.has(name)) {
      if (isAbsolute(value) && isInside(realEnvironment.home, value)) environment[name] = sandbox.mirror(value);
      continue;
    }
    environment[name] = value;
  }
  environment.HOME = sandbox.home;
  environment.USERPROFILE = sandbox.home;
  environment.TMPDIR = join(sandbox.root, 'tmp');
  environment.CLAUDE_MEM_DATA_DIR = sandbox.dataDirectory;
  delete environment.CLAUDE_MEM_INTERNAL;
  return environment;
}

/** settings.json, routes.json, wiring/* and agents/*.json into the sandbox data dir; applied paths re-rooted. */
function copyClaudeMemState(options: PreviewOptions, sandbox: PreviewSandbox): void {
  const sandboxWireGatewayDirectory = join(sandbox.dataDirectory, 'wire-gateway');
  const copies: Array<[string, string]> = [
    [join(options.dataDirectory, 'settings.json'), join(sandbox.dataDirectory, 'settings.json')],
    [join(options.wireGatewayDirectory, 'routes.json'), join(sandboxWireGatewayDirectory, 'routes.json')],
    [join(options.wireGatewayDirectory, 'wiring', 'stash.json'), join(sandboxWireGatewayDirectory, 'wiring', 'stash.json')],
    ...configFilesIn(join(options.wireGatewayDirectory, 'agents')).map((path): [string, string] => [path, join(sandboxWireGatewayDirectory, 'agents', relative(join(options.wireGatewayDirectory, 'agents'), path))]),
  ];
  for (const [source, destination] of copies) {
    if (existsSync(source)) copyRegularFile(source, destination);
  }
  // The record names the agent's real files; the sandboxed disconnect must edit the copies.
  const applied = readAppliedRecords(join(options.wireGatewayDirectory, 'wiring'));
  for (const record of Object.values(applied)) {
    for (const file of Object.values(record.files)) file.path = sandbox.mirror(file.path);
  }
  const sandboxWiringDirectory = join(sandboxWireGatewayDirectory, 'wiring');
  mkdirSync(sandboxWiringDirectory, { recursive: true, mode: WIRE_GATEWAY_DIR_MODE });
  writeFileSync(join(sandboxWiringDirectory, 'applied.json'), JSON.stringify({ version: WIRING_RECORDS_VERSION, agents: applied }, null, 2), { mode: WIRE_GATEWAY_FILE_MODE });
}

/** Every file a preview compares: the descriptor's candidates and the record's files, plus their folders' config files. */
function filesToCompare(options: PreviewOptions): string[] {
  const paths = new Set<string>();
  for (const file of options.descriptor.files) {
    for (const candidate of file.candidatePaths(options.environment)) paths.add(candidate);
  }
  const record = readAppliedRecords(join(options.wireGatewayDirectory, 'wiring'))[options.descriptor.id];
  for (const file of Object.values(record?.files ?? {})) paths.add(file.path);
  // Files beside them, which a connect may also touch; not the home folder's own (shell history, .netrc, …).
  for (const path of [...paths]) {
    if (dirname(path) === options.environment.home) continue;
    for (const sibling of configFilesIn(dirname(path))) paths.add(sibling);
  }
  return [...paths].sort();
}

export function runWirePreview(options: PreviewOptions): PreviewResult {
  const sandbox = new PreviewSandbox(options.environment.home, options.wireGatewayDirectory);
  try {
    const compared = filesToCompare(options);
    const before = new Map<string, Uint8Array | null>();
    for (const path of compared) {
      const bytes = readConfigFileBytes(path);
      before.set(path, bytes);
      if (bytes !== null) copyRegularFile(path, sandbox.mirror(path));
      else sandbox.mirror(path); // refuses a path outside home up front
    }
    copyClaudeMemState(options, sandbox);

    const commandArguments = [options.scriptPath, options.disconnect ? 'disconnect' : 'connect', options.descriptor.id, PREVIEW_SANDBOX_FLAG];
    if (!options.disconnect && options.captureSource) commandArguments.push('--capture', options.captureSource);
    const result = spawnSync(options.bunPath, commandArguments, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PREVIEW_SUBPROCESS_TIMEOUT_MS,
      windowsHide: true,
      env: previewEnvironment(options.environment, sandbox, options.descriptor),
    });
    const commandOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    if (result.error) throw new Error(`the preview run could not start: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`the ${options.disconnect ? 'disconnect' : 'connect'} would fail:\n${commandOutput}`);

    const changes: PreviewFileChange[] = [];
    for (const path of compared) {
      const original = before.get(path) ?? null;
      const changed = readConfigFileBytes(sandbox.mirror(path));
      const displayPath = sandbox.displayPath(path);
      if (original !== null && changed === null) {
        changes.push({ displayPath, created: false, removed: true, lines: [] });
        continue;
      }
      if (changed === null) continue;
      const lines = diffConfigLines(original === null ? '' : decodeConfigText(original), decodeConfigText(changed));
      if (original === null) changes.push({ displayPath, created: true, removed: false, lines });
      else if (lines.length > 0) changes.push({ displayPath, created: false, removed: false, lines });
    }
    return { changes, commandOutput };
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}
