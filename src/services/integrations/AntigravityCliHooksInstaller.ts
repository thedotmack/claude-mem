
import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { getWorkerServiceAbsolutePath as findWorkerServicePath, getBunAbsolutePath as findBunPath } from './install-paths.js';

/**
 * Antigravity CLI hooks installer.
 *
 * Antigravity replaces Gemini CLI (which stops serving 2026-06-18). Key
 * differences from GeminiCliHooksInstaller:
 *
 *  - Hooks live in a dedicated file ~/.gemini/config/hooks.json (NOT inside
 *    settings.json). A known early-CLI bug wrote them to
 *    ~/.gemini/antigravity-cli/hooks.json — that path is deliberately avoided.
 *  - The hooks.json shape is inverted: the top level is keyed by a hook NAME,
 *    and each hook name maps event names to matcher/command groups.
 *  - The `timeout` field is in SECONDS, not milliseconds.
 *  - Hooks receive JSON on stdin and return `{ "decision": "allow" }` on
 *    stdout (see antigravity-cli adapter); claude-mem always allows.
 *  - Context injection still flows through ~/.gemini/GEMINI.md, which
 *    Antigravity continues to parse.
 *
 * Event-name confidence (from live probing agy 1.0.9 + official SDK docs):
 *   - PreToolUse / PostToolUse  → confirmed by probe (name + payload)
 *   - SessionStart              → official SDK (on_session_start); high
 *   - PreInvocation / Stop /
 *     Compaction / Notification → from SDK lifecycle + web; NOT yet observed
 *                                 in headless print mode. Verify against an
 *                                 interactive agy session before relying on
 *                                 memory capture for those events.
 */

interface AntigravityHookEntry {
  type: 'command';
  command: string;
  timeout: number;
}

interface AntigravityHookGroup {
  matcher: string;
  hooks: AntigravityHookEntry[];
}

// hooks.json shape: { [hookName]: { [eventName]: AntigravityHookGroup[] } }
interface AntigravityHookEventMap {
  [eventName: string]: AntigravityHookGroup[];
}

interface AntigravityHooksConfig {
  [hookName: string]: AntigravityHookEventMap;
}

const GEMINI_CONFIG_DIR = path.join(homedir(), '.gemini');
const HOOKS_DIR = path.join(GEMINI_CONFIG_DIR, 'config');
const HOOKS_PATH = path.join(HOOKS_DIR, 'hooks.json');
const GEMINI_MD_PATH = path.join(GEMINI_CONFIG_DIR, 'GEMINI.md');

const HOOK_NAME = 'claude-mem';
const HOOK_TIMEOUT_SEC = 10;

// Antigravity CLI event name -> claude-mem internal event.
//
// Only the two tool-level events are registered: live probing of agy 1.0.9
// (both headless --print AND a full interactive session) confirmed that the
// CLI declarative hooks.json fires ONLY PreToolUse / PostToolUse. A 12-event
// probe (SessionStart, SessionEnd, PreInvocation, PostInvocation, PreTurn,
// PostTurn, Stop, Compaction, Notification, ToolError, …) saw none of the
// lifecycle events fire — they exist in the Python SDK (on_session_start,
// on_compaction, …) but are not yet surfaced by the CLI hook runner.
//
// Consequence: observation capture works via PostToolUse; memory context is
// injected through ~/.gemini/GEMINI.md (read by Antigravity at startup), which
// does not depend on a SessionStart hook. Session-boundary and summarize
// triggers are unavailable until agy exposes those events.
//
// To re-enable when agy adds them: add the event here and re-run the probe to
// confirm the name + payload before relying on it.
const ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT: Record<string, string> = {
  'PreToolUse': 'observation',     // confirmed: agy 1.0.9 probe
  'PostToolUse': 'observation',    // confirmed: agy 1.0.9 probe
};

function buildHookCommand(
  bunPath: string,
  workerServicePath: string,
  antigravityEventName: string,
): string {
  const internalEvent = ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT[antigravityEventName];
  if (!internalEvent) {
    throw new Error(`Unknown Antigravity CLI event: ${antigravityEventName}`);
  }

  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');
  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');

  return `"${escapedBunPath}" "${escapedWorkerPath}" hook antigravity-cli ${internalEvent}`;
}

function createHookGroup(hookCommand: string): AntigravityHookGroup {
  return {
    matcher: '*',
    hooks: [{
      type: 'command',
      command: hookCommand,
      timeout: HOOK_TIMEOUT_SEC,
    }],
  };
}

function readHooksConfig(): AntigravityHooksConfig {
  if (!existsSync(HOOKS_PATH)) {
    return {};
  }

  const content = readFileSync(HOOKS_PATH, 'utf-8');
  try {
    return JSON.parse(content) as AntigravityHooksConfig;
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    logger.error('WORKER', 'Corrupt JSON in Antigravity hooks', { path: HOOKS_PATH }, wrapped);
    throw new Error(`Corrupt JSON in ${HOOKS_PATH}, refusing to overwrite user hooks`);
  }
}

function writeHooksConfig(config: AntigravityHooksConfig): void {
  mkdirSync(HOOKS_DIR, { recursive: true });
  writeFileSync(HOOKS_PATH, JSON.stringify(config, null, 2) + '\n');
}

function buildClaudeMemEventMap(
  bunPath: string,
  workerServicePath: string,
): AntigravityHookEventMap {
  const eventMap: AntigravityHookEventMap = {};
  for (const antigravityEvent of Object.keys(ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT)) {
    const command = buildHookCommand(bunPath, workerServicePath, antigravityEvent);
    eventMap[antigravityEvent] = [createHookGroup(command)];
  }
  return eventMap;
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

export async function installAntigravityCliHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Antigravity CLI hooks...\n');

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
    const existingConfig = readHooksConfig();
    const mergedConfig: AntigravityHooksConfig = { ...existingConfig };
    mergedConfig[HOOK_NAME] = buildClaudeMemEventMap(bunPath, workerServicePath);

    writeHooksConfig(mergedConfig);
    console.log(`  Wrote hooks into ${HOOKS_PATH}`);

    setupGeminiMdContextSection();
    console.log(`  Setup context injection in ${GEMINI_MD_PATH}`);

    const eventNames = Object.keys(ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT);
    console.log(`  Registered ${eventNames.length} hook events:`);
    for (const event of eventNames) {
      console.log(`    ${event} → ${ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT[event]}`);
    }

    console.log(`
Installation complete!

Hooks installed to: ${HOOKS_PATH}
Using unified CLI: bun worker-service.cjs hook antigravity-cli <event>

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Antigravity CLI to load the hooks
  3. Memory will be captured automatically during sessions

Context Injection:
  Context from past sessions is injected via ~/.gemini/GEMINI.md
  and automatically included in Antigravity CLI conversations.
`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

export function uninstallAntigravityCliHooks(): number {
  console.log('\nUninstalling Claude-Mem Antigravity CLI hooks...\n');

  if (!existsSync(HOOKS_PATH)) {
    console.log('  No Antigravity CLI hooks file found — nothing to uninstall.');
    return 0;
  }

  try {
    const config = readHooksConfig();
    if (!config[HOOK_NAME]) {
      console.log('  No claude-mem hooks found — nothing to uninstall.');
      return 0;
    }

    const removedEvents = Object.keys(config[HOOK_NAME]).length;
    delete config[HOOK_NAME];

    writeHooksConfig(config);
    console.log(`  Removed claude-mem hooks (${removedEvents} events) from ${HOOKS_PATH}`);

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
    console.log('Restart Antigravity CLI to apply changes.');
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

export function checkAntigravityCliHooksStatus(): number {
  console.log('\nClaude-Mem Antigravity CLI Hooks Status\n');

  if (!existsSync(HOOKS_PATH)) {
    console.log('Antigravity CLI hooks: Not found');
    console.log(`  Expected at: ${HOOKS_PATH}\n`);
    console.log('No hooks installed. Run: claude-mem install --ide antigravity-cli\n');
    return 0;
  }

  let config: AntigravityHooksConfig;
  try {
    config = readHooksConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const wrapped = error instanceof Error ? error : new Error(String(error));
    logger.error('WORKER', 'Failed to read Antigravity CLI hooks', { path: HOOKS_PATH }, wrapped);
    console.log(`Antigravity CLI hooks: ${message}\n`);
    return 0;
  }

  const claudeMemHooks = config[HOOK_NAME];
  if (!claudeMemHooks) {
    console.log('Antigravity CLI hooks: Found, but no claude-mem hooks\n');
    console.log('Run: claude-mem install --ide antigravity-cli\n');
    return 0;
  }

  const installedEvents = Object.keys(claudeMemHooks);
  console.log(`Hooks file: ${HOOKS_PATH}`);
  console.log(`Mode: Unified CLI (bun worker-service.cjs hook antigravity-cli)`);
  console.log(`Events: ${installedEvents.length} of ${Object.keys(ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT).length} mapped`);
  for (const event of installedEvents) {
    const internalEvent = ANTIGRAVITY_EVENT_TO_INTERNAL_EVENT[event] ?? 'unknown';
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

export async function handleAntigravityCliCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installAntigravityCliHooks();

    case 'uninstall':
      return uninstallAntigravityCliHooks();

    case 'status':
      return checkAntigravityCliHooksStatus();

    default:
      console.log(`
Claude-Mem Antigravity CLI Integration

Usage: claude-mem antigravity-cli <command>

Commands:
  install             Install hooks into ~/.gemini/config/hooks.json
  uninstall           Remove claude-mem hooks (preserves other hooks)
  status              Check installation status

Examples:
  claude-mem antigravity-cli install     # Install hooks
  claude-mem antigravity-cli status      # Check if installed
  claude-mem antigravity-cli uninstall   # Remove hooks

For more info: https://docs.claude-mem.ai/usage/gemini-provider
      `);
      return 0;
  }
}
