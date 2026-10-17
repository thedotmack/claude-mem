// SPDX-License-Identifier: Apache-2.0
//
// Path helpers for agent descriptors. Everything resolves against an
// AgentEnvironment (never os.homedir() or process.env directly), so tests and
// `wire preview` can point every agent at a sandbox home.

import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import { homedir } from 'os';
import { expandHome } from '../../../shared/expand-home.js';
import type { AgentEnvironment } from './types.js';

export function currentAgentEnvironment(): AgentEnvironment {
  return { home: homedir(), env: process.env, platform: process.platform };
}

/** An env var naming a directory: `~` expanded; unset, empty or relative values are ignored (magpie agents.go:867-875). */
export function directoryFromEnv(environment: AgentEnvironment, variable: string): string | null {
  const value = environment.env[variable];
  if (!value) return null;
  const expanded = expandHome(value, environment.platform, environment.home);
  return isAbsolute(expanded) ? expanded : null;
}

/** `$XDG_CONFIG_HOME`, else `~/.config`. */
export function xdgConfigHome(environment: AgentEnvironment): string {
  return directoryFromEnv(environment, 'XDG_CONFIG_HOME') ?? join(environment.home, '.config');
}

/** `$XDG_DATA_HOME`, else `~/.local/share`. */
export function xdgDataHome(environment: AgentEnvironment): string {
  return directoryFromEnv(environment, 'XDG_DATA_HOME') ?? join(environment.home, '.local', 'share');
}

/** Whether an executable is on the environment's PATH (a lookup, never a spawn). */
export function isExecutableOnPath(environment: AgentEnvironment, executable: string): boolean {
  const searchPath = environment.env.PATH ?? environment.env.Path;
  if (!searchPath) return false;
  return Bun.which(executable, { PATH: searchPath }) !== null;
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}
