// Starts installer-scenarios.ts in a child process with a sandboxed HOME
// (never the real ~/.cursor, ~/.codex, …) and returns its snapshot with every
// machine-specific part replaced by a token, so goldens taken on one machine
// and one Bun compare on another.

import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'fs';
import { join } from 'path';

export interface InstallerSnapshot {
  exitCodes: number[];
  files: Record<string, string>;
}

const SCENARIO_SCRIPT = join(import.meta.dir, 'installer-scenarios.ts');

/** Where the goldens taken from the pre-Library installers live. */
export const GOLDEN_DIRECTORY = join(import.meta.dir, '..', '..', 'fixtures', 'wire-gateway', 'library-golden');

/** A child that has not finished in this time is hung (each scenario runs in well under a second); its output is never trusted. */
const SCENARIO_TIMEOUT_MS = 60_000;

function replaceAll(text: string, from: string, to: string): string {
  return from ? text.split(from).join(to) : text;
}

const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** Kimi's old installer named its backup after the day: `config.toml.bak-20261023`. */
const DAY_STAMPED_BACKUP = /\.bak-\d{8}\b/g;

function normalize(text: string, sandboxRoot: string): string {
  let normalized = text;
  const roots = [...new Set([realpathSync(sandboxRoot), sandboxRoot])].sort((a, b) => b.length - a.length);
  for (const root of roots) normalized = replaceAll(normalized, root, '<SANDBOX>');
  normalized = replaceAll(normalized, process.execPath, '<EXEC_PATH>');
  // The YAML editor quotes a scalar that needs it (a Bun under a path with a
  // space, as a checkout's .scratch/bun-1.4.3/bun can be); the quotes belong
  // to this machine's path, not to the installer's output.
  normalized = normalized.replace(/^(\s*cmd: )"<EXEC_PATH>"$/gm, '$1<EXEC_PATH>');
  return normalized.replace(ISO_TIMESTAMP, '<ISO_TIMESTAMP>').replace(DAY_STAMPED_BACKUP, '.bak-<YYYYMMDD>');
}

/**
 * Run one scenario in a fresh sandbox under `sandboxParent` and return its
 * normalized snapshot. Throws (with the child's output) when the child fails.
 */
export function runInstallerScenario(scenario: string, sandboxParent: string): InstallerSnapshot {
  const sandboxRoot = join(sandboxParent, `${scenario}-${process.pid}-${Date.now()}`);
  rmSync(sandboxRoot, { recursive: true, force: true });
  for (const directory of ['home', 'workspace', 'data', 'bin', 'tmp']) mkdirSync(join(sandboxRoot, directory), { recursive: true });
  const snapshotPath = join(sandboxRoot, 'snapshot.json');
  // A minimal environment: nothing from the caller's shell can point an
  // installer at a real agent home (CODEX_HOME, OPENCODE_CONFIG_DIR, …).
  const environment: Record<string, string> = {
    HOME: join(sandboxRoot, 'home'),
    USERPROFILE: join(sandboxRoot, 'home'),
    PATH: `${join(sandboxRoot, 'bin')}:/usr/bin:/bin`,
    TMPDIR: join(sandboxRoot, 'tmp'),
    CLAUDE_MEM_DATA_DIR: join(sandboxRoot, 'data'),
    CLAUDE_PLUGIN_ROOT: join(sandboxRoot, 'home', '.claude', 'plugins', 'marketplaces', 'thedotmack', 'plugin'),
    // Port 1 refuses at once: the installers' "generate initial context" step never reaches a real worker.
    CLAUDE_MEM_WORKER_PORT: '1',
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    LANG: 'C.UTF-8',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
    // Project names come from git: a sandbox inside a checkout must not take the checkout's name.
    GIT_CEILING_DIRECTORIES: sandboxParent,
  };
  const result = spawnSync(process.execPath, [SCENARIO_SCRIPT, scenario, sandboxRoot, snapshotPath], {
    cwd: join(sandboxRoot, 'workspace'),
    env: environment,
    encoding: 'utf-8',
    timeout: SCENARIO_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(`scenario ${scenario} failed (status ${result.status}, signal ${result.signal}):\n${result.stdout}\n${result.stderr}`);
  }
  const raw = JSON.parse(readFileSync(snapshotPath, 'utf-8')) as InstallerSnapshot;
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(raw.files)) {
    files[normalize(path, sandboxRoot)] = normalize(content, sandboxRoot);
  }
  rmSync(sandboxRoot, { recursive: true, force: true });
  return { exitCodes: raw.exitCodes, files };
}

export function goldenPath(scenario: string): string {
  return join(GOLDEN_DIRECTORY, `${scenario}.json`);
}
