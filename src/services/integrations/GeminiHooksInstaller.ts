import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { getBunAbsolutePath, getWorkerServiceAbsolutePath } from './install-paths.js';
import { resolveWorkerScript, type WorkerScriptSearchRoots } from '../../shared/worker-utils.js';
import { GEMINI_HOOK_TIMEOUT_MS } from '../../shared/host-hook-limits.js';

type Command = { type?: string; name?: string; command?: string; timeout?: number; [key: string]: unknown };
type Rule = { hooks?: Command[]; [key: string]: unknown };
type Hooks = Record<string, Rule[]>;
type Settings = { hooks?: Hooks; [key: string]: unknown };
const EVENTS: Record<string, string> = {
  SessionStart: 'context', BeforeAgent: 'session-init', AfterTool: 'observation',
  AfterAgent: 'summarize', SessionEnd: 'session-end',
};
/** GEMINI_CLI_HOME names the parent of `.gemini`, the same rule the Gemini transcript importer follows. */
export function geminiSettingsPath(environment: NodeJS.ProcessEnv = process.env): string {
  const configuredHome = environment.GEMINI_CLI_HOME?.trim();
  return path.join(configuredHome ? path.resolve(configuredHome) : homedir(), '.gemini', 'settings.json');
}

/**
 * Hooks older releases wrote into this same file: the Gemini CLI integration
 * removed in 26fe40a6c (`hook gemini-cli <event>`) and Antigravity installs
 * before #4057 (`hook antigravity-cli <event>`). Gemini CLI still runs them, so
 * leaving them next to the new hooks would capture every tool call twice.
 */
const LEGACY_COMMAND = /^"[^"\n]+" "[^"\n]+worker-service\.cjs" hook (gemini-cli|antigravity-cli) [a-z-]+$/;

export function isLegacyClaudeMemHook(command: Command): boolean {
  return typeof command?.command === 'string' && LEGACY_COMMAND.test(command.command);
}

function countHooks(hooks: Hooks | undefined, matches: (command: Command) => boolean): number {
  return Object.values(hooks ?? {}).reduce((total, rules) => total
    + (Array.isArray(rules) ? rules : []).reduce((count, rule) => count
      + (Array.isArray(rule?.hooks) ? rule.hooks.filter(matches).length : 0), 0), 0);
}

/** Gemini CLI runs hook commands through PowerShell on Windows, which runs a quoted path only after the `&` call operator. */
export function buildGeminiHooks(bun: string, worker: string, platform: NodeJS.Platform = process.platform): Hooks {
  const callOperator = platform === 'win32' ? '& ' : '';
  return Object.fromEntries(Object.entries(EVENTS).map(([event, handler]) => [event, [{
    hooks: [{ type: 'command', name: `claude-mem-${event}`, timeout: GEMINI_HOOK_TIMEOUT_MS,
      command: `${callOperator}"${bun}" "${worker}" hook gemini ${handler}` }],
  }]]));
}

function isOwn(command: Command): boolean {
  return command?.type === 'command' && typeof command.name === 'string'
    && Object.keys(EVENTS).some(event => command.name === `claude-mem-${event}`)
    && typeof command.command === 'string'
    && /^(?:& )?"[^"\n]+" "[^"\n]+[\\/]scripts[\\/]worker-service\.cjs" hook gemini (context|session-init|observation|summarize|session-end)$/.test(command.command);
}

/** A hook claude-mem wrote: this release's, or an older release's. */
function isClaudeMemHook(command: Command): boolean {
  return isOwn(command) || isLegacyClaudeMemHook(command);
}

export function removeGeminiHooks(hooks: Hooks): Hooks {
  const next: Hooks = {};
  for (const [event, rules] of Object.entries(hooks)) {
    if (!Array.isArray(rules)) throw new Error(`hooks.${event} must be an array`);
    const kept = rules.map(rule => {
      if (!Array.isArray(rule?.hooks)) throw new Error(`hooks.${event} contains an invalid rule`);
      return { ...rule, hooks: rule.hooks.filter(command => !isClaudeMemHook(command)) };
    }).filter(rule => rule.hooks.length > 0);
    if (kept.length) next[event] = kept;
  }
  return next;
}

/**
 * The worker script the Gemini hooks run. The stable plugin path wins: Gemini
 * settings are written once and nothing rewrites them on update, while the
 * plugin cache keeps only DEFAULT_CACHE_RETENTION versions
 * (src/npx-cli/utils/prune-cache.ts). A baked cache path would run old code and
 * then point at a pruned folder two releases later. The cache resolver is the
 * fallback for installs that only have the cache.
 */
export function resolveGeminiWorkerScript(
  stableLookup: () => string | null = getWorkerServiceAbsolutePath,
  roots?: WorkerScriptSearchRoots,
): string | null {
  return stableLookup() ?? resolveWorkerScript(roots)?.scriptPath ?? null;
}

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const value = parseJsonWithBom(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Gemini settings must be a JSON object');
  const settings = value as Settings;
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new Error('Gemini hooks must be an object');
  }
  return settings;
}

export function manageGeminiHooks(
  action: 'install' | 'uninstall' | 'status',
  file = geminiSettingsPath(),
  resolveWorker: () => string | null = () => resolveGeminiWorkerScript(),
): number {
  try {
    const settings = readSettings(file);
    const cleaned = removeGeminiHooks(settings.hooks ?? {});
    if (action === 'status') {
      const installed = Object.keys(EVENTS).every(event => settings.hooks?.[event]?.some(rule => rule.hooks?.some(isOwn)));
      console.log(`Gemini CLI capture hooks: ${installed ? 'installed' : 'not installed'}`);
      const legacy = countHooks(settings.hooks, isLegacyClaudeMemHook);
      if (legacy > 0) {
        console.log(`Found ${legacy} leftover claude-mem hook(s) from an older install in ${file}; they capture a second time. Run \`npx claude-mem gemini install\` or \`uninstall\` to remove them.`);
      }
      return installed ? 0 : 1;
    }
    if (action === 'uninstall' && !existsSync(file)) return 0;
    if (action === 'install') {
      const worker = resolveWorker();
      if (!worker) throw new Error('Cannot find worker-service.cjs. Build or install Claude-Mem first.');
      const own = buildGeminiHooks(getBunAbsolutePath(), worker);
      for (const [event, rules] of Object.entries(own)) cleaned[event] = [...(cleaned[event] ?? []), ...rules];
    }
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file) && !existsSync(`${file}.claude-mem.bak`)) {
      writeFileSync(`${file}.claude-mem.bak`, readFileSync(file), { mode: 0o600 });
    }
    const removedLegacy = countHooks(settings.hooks, isLegacyClaudeMemHook);
    writeJsonFileAtomic(file, { ...settings, hooks: cleaned });
    if (removedLegacy > 0) console.log(`Removed ${removedLegacy} leftover claude-mem hook(s) from an older install`);
    console.log(`Gemini CLI capture hooks ${action === 'install' ? 'installed' : 'removed'} in ${file}`);
    return 0;
  } catch (error) {
    console.error(`Gemini CLI hook setup failed: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * The `npx claude-mem uninstall` step. Uninstall runs it for everyone, including
 * people who never ran `gemini install`, so settings.json is rewritten only when
 * it holds a hook claude-mem wrote. Returns 1 without touching the file when it
 * holds none, and otherwise what `gemini uninstall` returns.
 */
export function uninstallGeminiHooks(file = geminiSettingsPath()): number {
  if (countHooks(readSettings(file).hooks, isClaudeMemHook) === 0) return 1;
  return manageGeminiHooks('uninstall', file);
}

export async function handleGeminiCommand(action: string | undefined): Promise<number> {
  if (action === 'install' || action === 'uninstall' || action === 'status') return manageGeminiHooks(action);
  console.log('Usage: claude-mem gemini <install|status|uninstall>');
  return action === undefined || action === 'help' ? 0 : 1;
}
