/**
 * The installer fixes that ship inside this npm package, and the only
 * commands the install advisor may ever suggest.
 *
 * `npx claude-mem fix <id>` runs a function from FIX_CATALOG and nothing else,
 * so the server can point at a fix but can never add a new action. The
 * advisor's `command` strings must pass isAllowedAdvisorCommand here AND on
 * the server (claude-mem-pro src/lib/installer-advisor/fix-catalog.ts keeps a
 * copy pinned to FIX_CATALOG_VERSION); anything else is dropped before it is
 * printed.
 */

import { installBunFromNpmPackage } from './bun-npm-fallback.js';
import { clearAttempts } from './attempt-guard.js';
import { KNOWN_AI_TOOL_IDS } from './snapshot.js';

export const FIX_CATALOG_VERSION = 1;

export interface FixDefinition {
  id: string;
  title: string;
  run: () => Promise<boolean>;
}

export const FIX_CATALOG: Record<string, FixDefinition> = {
  'fix.bun.npm-package': {
    id: 'fix.bun.npm-package',
    title: 'Install Bun from the npm registry and put it in ~/.bun/bin',
    run: async () => installBunFromNpmPackage() !== null,
  },
  'fix.attempts.reset': {
    id: 'fix.attempts.reset',
    title: 'Forget earlier install failures so the next install runs every step again',
    run: async () => {
      clearAttempts();
      return true;
    },
  },
};

export const FIX_IDS = Object.keys(FIX_CATALOG);

export function isKnownFixId(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(FIX_CATALOG, id);
}

const SUBCOMMANDS_NO_ARGS = new Set(['update', 'repair', 'start', 'stop', 'restart', 'status', 'doctor']);
const PROVIDERS = new Set(['claude', 'gemini', 'openrouter', 'host']);
const RUNTIMES = new Set(['worker', 'server']);
const IDE_IDS = new Set<string>(KNOWN_AI_TOOL_IDS);

/**
 * `npx claude-mem <subcommand> [flags]` with a fixed flag list, or
 * `npx claude-mem fix <catalog id>`. Exact tokens only: no shell syntax, no
 * paths, no URLs, nothing that is not in these lists.
 */
export function isAllowedAdvisorCommand(command: unknown): boolean {
  if (typeof command !== 'string' || command.length > 200) return false;
  const tokens = command.trim().split(/ +/);
  if (tokens[0] !== 'npx' || tokens[1] !== 'claude-mem' || tokens.length < 3) return false;
  const [sub, ...rest] = tokens.slice(2);
  if (sub === 'fix') return rest.length === 1 && isKnownFixId(rest[0]);
  if (SUBCOMMANDS_NO_ARGS.has(sub)) return rest.length === 0;
  if (sub === 'login') {
    const mode = rest.filter((t) => t === '--request' || t === '--check' || t === '--dismiss');
    const extras = rest.filter((t) => t === '--json' || t === '--no-browser');
    return mode.length === 1 && mode.length + extras.length === rest.length && new Set(rest).size === rest.length;
  }
  if (sub === 'install') {
    const seen = new Set<string>();
    for (let i = 0; i < rest.length; i++) {
      const flag = rest[i];
      if (seen.has(flag)) return false;
      seen.add(flag);
      if (flag === '--no-browser' || flag === '--no-auto-start' || flag === '--disable-auto-memory') continue;
      const value = rest[i + 1];
      if (flag === '--provider' && PROVIDERS.has(value)) { i++; continue; }
      if (flag === '--ide' && IDE_IDS.has(value)) { i++; continue; }
      if (flag === '--runtime' && RUNTIMES.has(value)) { i++; continue; }
      return false;
    }
    return true;
  }
  return false;
}
