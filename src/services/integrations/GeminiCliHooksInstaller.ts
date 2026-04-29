
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { findWorkerServicePath, findBunPath } from './CursorHooksInstaller.js';

interface GeminiHookEntry {
  name: string;
  type: 'command';
  command: string;
  timeout: number;
}

interface GeminiHookGroup {
  matcher: string;
  hooks: GeminiHookEntry[];
}

interface GeminiHooksConfig {
  [eventName: string]: GeminiHookGroup[];
}

interface GeminiSettingsJson {
  hooks?: GeminiHooksConfig;
  [key: string]: unknown;
}

const GEMINI_CONFIG_DIR = path.join(homedir(), '.gemini');
const GEMINI_SETTINGS_PATH = path.join(GEMINI_CONFIG_DIR, 'settings.json');
const GEMINI_MD_PATH = path.join(GEMINI_CONFIG_DIR, 'GEMINI.md');

const HOOK_NAME = 'claude-mem';
const HOOK_TIMEOUT_MS = 10000;

const GEMINI_EVENT_TO_INTERNAL_EVENT: Record<string, string> = {
  'SessionStart': 'context',
  'BeforeAgent': 'session-init',
  'AfterAgent': 'observation',
  'BeforeTool': 'observation',
  'AfterTool': 'observation',
  'PreCompress': 'summarize',
  'Notification': 'observation',
};

function buildHookCommand(
  bunPath: string,
  workerServicePath: string,
  geminiEventName: string,
): string {
  const internalEvent = GEMINI_EVENT_TO_INTERNAL_EVENT[geminiEventName];
  if (!internalEvent) {
    throw new Error(`Unknown Gemini CLI event: ${geminiEventName}`);
  }

  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');
  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');

  return `"${escapedBunPath}" "${escapedWorkerPath}" hook gemini-cli ${internalEvent}`;
}

function createHookGroup(hookCommand: string): GeminiHookGroup {
  return {
    matcher: '*',
    hooks: [{
      name: HOOK_NAME,
      type: 'command',
      command: hookCommand,
      timeout: HOOK_TIMEOUT_MS,
    }],
  };
}

function readGeminiSettings(): GeminiSettingsJson {
  if (!existsSync(GEMINI_SETTINGS_PATH)) {
    return {};
  }

  const content = readFileSync(GEMINI_SETTINGS_PATH, 'utf-8');
  try {
    return JSON.parse(content) as GeminiSettingsJson;
  } catch (error) {
    if (error instanceof Error) {
      logger.error('WORKER', 'Corrupt JSON in Gemini settings', { path: GEMINI_SETTINGS_PATH }, error);
    } else {
      logger.error('WORKER', 'Corrupt JSON in Gemini settings', { path: GEMINI_SETTINGS_PATH }, new Error(String(error)));
    }
    throw new Error(`Corrupt JSON in ${GEMINI_SETTINGS_PATH}, refusing to overwrite user settings`);
  }
}

function writeGeminiSettings(settings: GeminiSettingsJson): void {
  mkdirSync(GEMINI_CONFIG_DIR, { recursive: true });
  writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

function mergeHooksIntoSettings(
  existingSettings: GeminiSettingsJson,
  newHooks: GeminiHooksConfig,
): GeminiSettingsJson {
  const settings = { ...existingSettings };
  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const [eventName, newGroups] of Object.entries(newHooks)) {
    const existingGroups: GeminiHookGroup[] = settings.hooks[eventName] ?? [];

    for (const newGroup of newGroups) {
      const existingGroupIndex = existingGroups.findIndex((group: GeminiHookGroup) =>
        group.hooks.some((hook: GeminiHookEntry) => hook.name === HOOK_NAME)
      );

      if (existingGroupIndex >= 0) {
        const existingGroup: GeminiHookGroup = existingGroups[existingGroupIndex];
        const hookIndex = existingGroup.hooks.findIndex((hook: GeminiHookEntry) => hook.name === HOOK_NAME);
        if (hookIndex >= 0) {
          existingGroup.hooks[hookIndex] = newGroup.hooks[0];
        } else {
          existingGroup.hooks.push(newGroup.hooks[0]);
        }
      } else {
        existingGroups.push(newGroup);
      }
    }

    settings.hooks[eventName] = existingGroups;
  }

  return settings;
}

function setupGeminiMdContextSection(): void {
  const contextTag = '<claude-mem-context>';
  const contextEndTag = '</claude-mem-context>';
  const placeholder = `${contextTag}
# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*
${contextEndTag}`;

  let content = '';
  if (existsSync(GEMINI_MD_PATH)) {
    content = readFileSync(GEMINI_MD_PATH, 'utf-8');
  }

  if (content.includes(contextTag)) {
    return;
  }

  const separator = content.length > 0 && !content.endsWith('\n') ? '\n\n' : content.length > 0 ? '\n' : '';
  const newContent = content + separator + placeholder + '\n';

  mkdirSync(GEMINI_CONFIG_DIR, { recursive: true });
  writeFileSync(GEMINI_MD_PATH, newContent);
}

export async function installGeminiCliHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Gemini CLI hooks...\n');

  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const bunPath = findBunPath();
  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service: ${workerServicePath}`);

  try {
    const hooksConfig: GeminiHooksConfig = {};
    for (const geminiEvent of Object.keys(GEMINI_EVENT_TO_INTERNAL_EVENT)) {
      const command = buildHookCommand(bunPath, workerServicePath, geminiEvent);
      hooksConfig[geminiEvent] = [createHookGroup(command)];
    }

    const existingSettings = readGeminiSettings();
    const mergedSettings = mergeHooksIntoSettings(existingSettings, hooksConfig);

    writeGeminiHooksAndSetupContext(mergedSettings);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

function writeGeminiHooksAndSetupContext(mergedSettings: GeminiSettingsJson): void {
  writeGeminiSettings(mergedSettings);
  console.log(`  Merged hooks into ${GEMINI_SETTINGS_PATH}`);

  setupGeminiMdContextSection();
  console.log(`  Setup context injection in ${GEMINI_MD_PATH}`);

  const eventNames = Object.keys(GEMINI_EVENT_TO_INTERNAL_EVENT);
  console.log(`  Registered ${eventNames.length} hook events:`);
  for (const event of eventNames) {
    const internalEvent = GEMINI_EVENT_TO_INTERNAL_EVENT[event];
    console.log(`    ${event} → ${internalEvent}`);
  }

  console.log(`
Installation complete!

Hooks installed to: ${GEMINI_SETTINGS_PATH}
Using unified CLI: bun worker-service.cjs hook gemini-cli <event>

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Gemini CLI to load the hooks
  3. Memory will be captured automatically during sessions

Context Injection:
  Context from past sessions is injected via ~/.gemini/GEMINI.md
  and automatically included in Gemini CLI conversations.
`);
}

export function uninstallGeminiCliHooks(): number {
  console.log('\nUninstalling Claude-Mem Gemini CLI hooks...\n');

  if (!existsSync(GEMINI_SETTINGS_PATH)) {
    console.log('  No Gemini CLI settings found — nothing to uninstall.');
    return 0;
  }

  try {
    const settings = readGeminiSettings();
    if (!settings.hooks) {
      console.log('  No hooks found in Gemini CLI settings — nothing to uninstall.');
      return 0;
    }

    let removedCount = 0;

    for (const [eventName, groups] of Object.entries(settings.hooks)) {
      const filteredGroups = groups
        .map(group => {
          const remainingHooks = group.hooks.filter(hook => hook.name !== HOOK_NAME);
          removedCount += group.hooks.length - remainingHooks.length;
          return { ...group, hooks: remainingHooks };
        })
        .filter(group => group.hooks.length > 0);

      if (filteredGroups.length > 0) {
        settings.hooks[eventName] = filteredGroups;
      } else {
        delete settings.hooks[eventName];
      }
    }

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    writeSettingsAndCleanupGeminiContext(settings, removedCount);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

function writeSettingsAndCleanupGeminiContext(
  settings: GeminiSettingsJson,
  removedCount: number,
): void {
  writeGeminiSettings(settings);
  console.log(`  Removed ${removedCount} claude-mem hook(s) from ${GEMINI_SETTINGS_PATH}`);

  if (existsSync(GEMINI_MD_PATH)) {
    let mdContent = readFileSync(GEMINI_MD_PATH, 'utf-8');
    const contextRegex = /\n?<claude-mem-context>[\s\S]*?<\/claude-mem-context>\n?/;
    if (contextRegex.test(mdContent)) {
      mdContent = mdContent.replace(contextRegex, '');
      writeFileSync(GEMINI_MD_PATH, mdContent);
      console.log(`  Removed context section from ${GEMINI_MD_PATH}`);
    }
  }

  console.log('\nUninstallation complete!\n');
  console.log('Restart Gemini CLI to apply changes.');
}

export function checkGeminiCliHooksStatus(): number {
  console.log('\nClaude-Mem Gemini CLI Hooks Status\n');

  if (!existsSync(GEMINI_SETTINGS_PATH)) {
    console.log('Gemini CLI settings: Not found');
    console.log(`  Expected at: ${GEMINI_SETTINGS_PATH}\n`);
    console.log('No hooks installed. Run: claude-mem install --ide gemini-cli\n');
    return 0;
  }

  let settings: GeminiSettingsJson;
  try {
    settings = readGeminiSettings();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error) {
      logger.error('WORKER', 'Failed to read Gemini CLI settings', { path: GEMINI_SETTINGS_PATH }, error);
    } else {
      logger.error('WORKER', 'Failed to read Gemini CLI settings', { path: GEMINI_SETTINGS_PATH }, new Error(String(error)));
    }
    console.log(`Gemini CLI settings: ${message}\n`);
    return 0;
  }

  if (!settings.hooks) {
    console.log('Gemini CLI settings: Found, but no hooks configured\n');
    console.log('No hooks installed. Run: claude-mem install --ide gemini-cli\n');
    return 0;
  }

  const installedEvents: string[] = [];
  for (const [eventName, groups] of Object.entries(settings.hooks)) {
    const hasClaudeMem = groups.some(group =>
      group.hooks.some(hook => hook.name === HOOK_NAME)
    );
    if (hasClaudeMem) {
      installedEvents.push(eventName);
    }
  }

  if (installedEvents.length === 0) {
    console.log('Gemini CLI settings: Found, but no claude-mem hooks\n');
    console.log('Run: claude-mem install --ide gemini-cli\n');
    return 0;
  }

  console.log(`Settings: ${GEMINI_SETTINGS_PATH}`);
  console.log(`Mode: Unified CLI (bun worker-service.cjs hook gemini-cli)`);
  console.log(`Events: ${installedEvents.length} of ${Object.keys(GEMINI_EVENT_TO_INTERNAL_EVENT).length} mapped`);
  for (const event of installedEvents) {
    const internalEvent = GEMINI_EVENT_TO_INTERNAL_EVENT[event] ?? 'unknown';
    console.log(`  ${event} → ${internalEvent}`);
  }

  if (existsSync(GEMINI_MD_PATH)) {
    const mdContent = readFileSync(GEMINI_MD_PATH, 'utf-8');
    if (mdContent.includes('<claude-mem-context>')) {
      console.log(`Context: Active (${GEMINI_MD_PATH})`);
    } else {
      console.log('Context: GEMINI.md exists but missing claude-mem section');
    }
  } else {
    console.log('Context: No GEMINI.md found');
  }

  console.log('');
  return 0;
}

export async function handleGeminiCliCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installGeminiCliHooks();

    case 'uninstall':
      return uninstallGeminiCliHooks();

    case 'status':
      return checkGeminiCliHooksStatus();

    default:
      console.log(`
Claude-Mem Gemini CLI Integration

Usage: claude-mem gemini-cli <command>

Commands:
  install             Install hooks into ~/.gemini/settings.json
  uninstall           Remove claude-mem hooks (preserves other hooks)
  status              Check installation status

Examples:
  claude-mem gemini-cli install     # Install hooks
  claude-mem gemini-cli status      # Check if installed
  claude-mem gemini-cli uninstall   # Remove hooks

For more info: https://docs.claude-mem.ai/usage/gemini-provider
      `);
      return 0;
  }
}
