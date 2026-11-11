import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { getBunAbsolutePath, getWorkerServiceAbsolutePath } from './install-paths.js';

type Command = { type?: string; name?: string; command?: string; timeout?: number; [key: string]: unknown };
type Rule = { hooks?: Command[]; [key: string]: unknown };
type Hooks = Record<string, Rule[]>;
type Settings = { hooks?: Hooks; [key: string]: unknown };
const EVENTS: Record<string, string> = {
  SessionStart: 'context', BeforeAgent: 'session-init', AfterTool: 'observation',
  AfterAgent: 'summarize', SessionEnd: 'session-end',
};
export const geminiSettingsPath = () => path.join(homedir(), '.gemini', 'settings.json');

export function buildGeminiHooks(bun: string, worker: string): Hooks {
  return Object.fromEntries(Object.entries(EVENTS).map(([event, handler]) => [event, [{
    hooks: [{ type: 'command', name: `claude-mem-${event}`, timeout: 10000,
      command: `"${bun}" "${worker}" hook gemini ${handler}` }],
  }]]));
}

function isOwn(command: Command): boolean {
  return command.type === 'command' && typeof command.name === 'string'
    && Object.keys(EVENTS).some(event => command.name === `claude-mem-${event}`)
    && typeof command.command === 'string'
    && /^"[^"\n]+" "[^"\n]+[\\/]scripts[\\/]worker-service\.cjs" hook gemini (context|session-init|observation|summarize|session-end)$/.test(command.command);
}

export function removeGeminiHooks(hooks: Hooks): Hooks {
  const next: Hooks = {};
  for (const [event, rules] of Object.entries(hooks)) {
    if (!Array.isArray(rules)) throw new Error(`hooks.${event} must be an array`);
    const kept = rules.map(rule => {
      if (!Array.isArray(rule?.hooks)) throw new Error(`hooks.${event} contains an invalid rule`);
      return { ...rule, hooks: rule.hooks.filter(command => !isOwn(command)) };
    }).filter(rule => rule.hooks.length > 0);
    if (kept.length) next[event] = kept;
  }
  return next;
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

export function manageGeminiHooks(action: 'install' | 'uninstall' | 'status', file = geminiSettingsPath()): number {
  try {
    const settings = readSettings(file);
    const cleaned = removeGeminiHooks(settings.hooks ?? {});
    if (action === 'status') {
      const installed = Object.keys(EVENTS).every(event => settings.hooks?.[event]?.some(rule => rule.hooks?.some(isOwn)));
      console.log(`Gemini CLI capture hooks: ${installed ? 'installed' : 'not installed'}`);
      return installed ? 0 : 1;
    }
    if (action === 'uninstall' && !existsSync(file)) return 0;
    if (action === 'install') {
      const worker = getWorkerServiceAbsolutePath();
      if (!worker) throw new Error('Cannot find worker-service.cjs. Build or install Claude-Mem first.');
      const own = buildGeminiHooks(getBunAbsolutePath(), worker);
      for (const [event, rules] of Object.entries(own)) cleaned[event] = [...(cleaned[event] ?? []), ...rules];
    }
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file) && !existsSync(`${file}.claude-mem.bak`)) {
      writeFileSync(`${file}.claude-mem.bak`, readFileSync(file), { mode: 0o600 });
    }
    writeJsonFileAtomic(file, { ...settings, hooks: cleaned });
    console.log(`Gemini CLI capture hooks ${action === 'install' ? 'installed' : 'removed'} in ${file}`);
    return 0;
  } catch (error) {
    console.error(`Gemini CLI hook setup failed: ${(error as Error).message}`);
    return 1;
  }
}

export async function handleGeminiCommand(action: string | undefined): Promise<number> {
  if (action === 'install' || action === 'uninstall' || action === 'status') return manageGeminiHooks(action);
  console.log('Usage: claude-mem gemini <install|status|uninstall>');
  return action === undefined || action === 'help' ? 0 : 1;
}
