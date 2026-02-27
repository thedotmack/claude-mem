/**
 * GeminiCliHooksInstaller - Gemini CLI integration for claude-mem
 *
 * Installs claude-mem hooks into ~/.gemini/settings.json using deep merge
 * to preserve any existing user configuration.
 *
 * Gemini CLI hook config format:
 * {
 *   "hooks": {
 *     "AfterTool": [{
 *       "matcher": "*",
 *       "hooks": [{ "name": "claude-mem", "type": "command", "command": "...", "timeout": 5000 }]
 *     }]
 *   }
 * }
 *
 * Events registered:
 *   SessionStart  — session init
 *   BeforeAgent   — capture user prompt
 *   AfterAgent    — capture full response
 *   AfterTool     — capture all tool results (matcher: "*")
 *   PreCompress   — trigger summary
 *   SessionEnd    — finalize session
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { replaceTaggedContent } from '../../utils/claude-md-utils.js';
import { findBunPath, findWorkerServicePath } from './CursorHooksInstaller.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GeminiHookEntry {
  name: string;
  type: 'command';
  command: string;
  timeout: number;
}

interface GeminiHookMatcher {
  matcher: string;
  hooks: GeminiHookEntry[];
}

interface GeminiSettingsJson {
  hooks?: Record<string, GeminiHookMatcher[]>;
  [otherKeys: string]: unknown;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GEMINI_DIR = path.join(homedir(), '.gemini');
const GEMINI_SETTINGS_PATH = path.join(GEMINI_DIR, 'settings.json');
const GEMINI_MD_PATH = path.join(GEMINI_DIR, 'GEMINI.md');
const HOOK_NAME = 'claude-mem';
const HOOK_TIMEOUT_MS = 5000;

/**
 * The Gemini CLI events we register hooks for, mapped to our internal event names.
 */
const GEMINI_EVENT_TO_CLAUDE_MEM_EVENT: Record<string, string> = {
  'SessionStart': 'session-init',
  'BeforeAgent': 'user-message',
  'AfterAgent': 'observation',
  'AfterTool': 'observation',
  'PreCompress': 'summarize',
  'SessionEnd': 'session-complete',
};

// ---------------------------------------------------------------------------
// Deep Merge for Hook Arrays
// ---------------------------------------------------------------------------

/**
 * Merge claude-mem hooks into an existing event's hook matcher array.
 * If a matcher with the same `matcher` value already has a hook named "claude-mem",
 * it is replaced. Otherwise, the hook is appended.
 */
function mergeHookMatchers(
  existingMatchers: GeminiHookMatcher[],
  newMatcher: GeminiHookMatcher,
): GeminiHookMatcher[] {
  const result = [...existingMatchers];

  const existingMatcherIndex = result.findIndex(
    (m) => m.matcher === newMatcher.matcher,
  );

  if (existingMatcherIndex !== -1) {
    // Matcher exists — replace or add our hook within it
    const existing = result[existingMatcherIndex];
    const hookIndex = existing.hooks.findIndex((h) => h.name === HOOK_NAME);
    if (hookIndex !== -1) {
      existing.hooks[hookIndex] = newMatcher.hooks[0];
    } else {
      existing.hooks.push(newMatcher.hooks[0]);
    }
  } else {
    // No matching matcher — add the whole entry
    result.push(newMatcher);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hook Installation
// ---------------------------------------------------------------------------

/**
 * Build the hook command string for a given Gemini CLI event.
 *
 * Invokes: <bun-path> <worker-service.cjs> hook gemini-cli <event>
 */
function buildHookCommand(bunPath: string, workerServicePath: string, claudeMemEvent: string): string {
  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');
  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');
  return `"${escapedBunPath}" "${escapedWorkerPath}" hook gemini-cli ${claudeMemEvent}`;
}

/**
 * Install claude-mem hooks into Gemini CLI's settings.json.
 * Deep-merges with existing configuration — never overwrites.
 *
 * @returns 0 on success, 1 on failure
 */
export async function installGeminiCliHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Gemini CLI hooks...\n');

  // Find required paths
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
    // Ensure ~/.gemini exists
    mkdirSync(GEMINI_DIR, { recursive: true });

    // Read existing settings (deep merge, never overwrite)
    let settings: GeminiSettingsJson = {};
    if (existsSync(GEMINI_SETTINGS_PATH)) {
      try {
        settings = JSON.parse(readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'));
      } catch (parseError) {
        logger.error('GEMINI', 'Corrupt settings.json, creating backup', { path: GEMINI_SETTINGS_PATH }, parseError as Error);
        // Back up corrupt file
        const backupPath = `${GEMINI_SETTINGS_PATH}.backup.${Date.now()}`;
        writeFileSync(backupPath, readFileSync(GEMINI_SETTINGS_PATH));
        console.warn(`  Backed up corrupt settings.json to ${backupPath}`);
        settings = {};
      }
    }

    // Initialize hooks object if missing
    if (!settings.hooks) {
      settings.hooks = {};
    }

    // Register each event
    for (const [geminiEvent, claudeMemEvent] of Object.entries(GEMINI_EVENT_TO_CLAUDE_MEM_EVENT)) {
      const command = buildHookCommand(bunPath, workerServicePath, claudeMemEvent);

      // AfterTool uses matcher: "*" to capture all tool results
      const matcherValue = geminiEvent === 'AfterTool' ? '*' : '*';

      const newMatcher: GeminiHookMatcher = {
        matcher: matcherValue,
        hooks: [{
          name: HOOK_NAME,
          type: 'command',
          command,
          timeout: HOOK_TIMEOUT_MS,
        }],
      };

      const existingMatchers = settings.hooks[geminiEvent] ?? [];
      settings.hooks[geminiEvent] = mergeHookMatchers(existingMatchers, newMatcher);
    }

    // Write merged settings
    writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    console.log(`  Updated ${GEMINI_SETTINGS_PATH}`);
    console.log(`  Registered hooks for: ${Object.keys(GEMINI_EVENT_TO_CLAUDE_MEM_EVENT).join(', ')}`);

    // Inject context into GEMINI.md
    injectGeminiMdContext();

    console.log(`
Installation complete!

Hooks installed to: ${GEMINI_SETTINGS_PATH}
Using unified CLI: bun worker-service.cjs hook gemini-cli <event>

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Gemini CLI to load the hooks
  3. Memory capture is now automatic!

Context Injection:
  Context from past sessions is injected via ${GEMINI_MD_PATH}
  and automatically included in every Gemini CLI session.
`);

    return 0;
  } catch (error) {
    console.error(`\nInstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Context Injection (GEMINI.md)
// ---------------------------------------------------------------------------

/**
 * Inject claude-mem context section into ~/.gemini/GEMINI.md.
 * Uses the same <claude-mem-context> tag pattern as CLAUDE.md.
 * Preserves any existing user content outside the tags.
 */
function injectGeminiMdContext(): void {
  try {
    let existingContent = '';
    if (existsSync(GEMINI_MD_PATH)) {
      existingContent = readFileSync(GEMINI_MD_PATH, 'utf-8');
    }

    // Initial placeholder content — will be populated after first session
    const contextContent = [
      '# Recent Activity',
      '',
      '<!-- This section is auto-generated by claude-mem. Edit content outside the tags. -->',
      '',
      '*No context yet. Complete your first session and context will appear here.*',
    ].join('\n');

    const finalContent = replaceTaggedContent(existingContent, contextContent);
    writeFileSync(GEMINI_MD_PATH, finalContent);
    console.log(`  Injected context placeholder into ${GEMINI_MD_PATH}`);
  } catch (error) {
    // Non-fatal — hooks still work without context injection
    logger.warn('GEMINI', 'Failed to inject GEMINI.md context', { error: (error as Error).message });
    console.warn(`  Warning: Could not inject context into GEMINI.md: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Uninstallation
// ---------------------------------------------------------------------------

/**
 * Remove claude-mem hooks from Gemini CLI settings.json.
 * Preserves all other hooks and settings.
 *
 * @returns 0 on success, 1 on failure
 */
export function uninstallGeminiCliHooks(): number {
  console.log('\nUninstalling Claude-Mem Gemini CLI hooks...\n');

  try {
    if (!existsSync(GEMINI_SETTINGS_PATH)) {
      console.log('  No settings.json found — nothing to uninstall.');
      return 0;
    }

    let settings: GeminiSettingsJson;
    try {
      settings = JSON.parse(readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'));
    } catch {
      console.error('  Could not parse settings.json');
      return 1;
    }

    if (!settings.hooks) {
      console.log('  No hooks configured — nothing to uninstall.');
      return 0;
    }

    let removedCount = 0;

    // Remove claude-mem hooks from each event
    for (const eventName of Object.keys(settings.hooks)) {
      const matchers = settings.hooks[eventName];
      if (!Array.isArray(matchers)) continue;

      for (const matcher of matchers) {
        if (!Array.isArray(matcher.hooks)) continue;
        const beforeLength = matcher.hooks.length;
        matcher.hooks = matcher.hooks.filter((h) => h.name !== HOOK_NAME);
        removedCount += beforeLength - matcher.hooks.length;
      }

      // Clean up empty matchers
      settings.hooks[eventName] = matchers.filter(
        (m) => m.hooks.length > 0,
      );

      // Clean up empty event arrays
      if (settings.hooks[eventName].length === 0) {
        delete settings.hooks[eventName];
      }
    }

    // Clean up empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
    console.log(`  Removed ${removedCount} claude-mem hook(s) from settings.json`);

    // Remove context section from GEMINI.md
    removeGeminiMdContext();

    console.log('\nUninstallation complete!');
    console.log('Restart Gemini CLI to apply changes.\n');

    return 0;
  } catch (error) {
    console.error(`\nUninstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Remove claude-mem context section from GEMINI.md.
 * Preserves user content outside the <claude-mem-context> tags.
 */
function removeGeminiMdContext(): void {
  try {
    if (!existsSync(GEMINI_MD_PATH)) return;

    const content = readFileSync(GEMINI_MD_PATH, 'utf-8');
    const startTag = '<claude-mem-context>';
    const endTag = '</claude-mem-context>';

    const startIdx = content.indexOf(startTag);
    const endIdx = content.indexOf(endTag);

    if (startIdx === -1 || endIdx === -1) return;

    // Remove the tagged section and any surrounding blank lines
    const before = content.substring(0, startIdx).replace(/\n+$/, '');
    const after = content.substring(endIdx + endTag.length).replace(/^\n+/, '');
    const finalContent = (before + (after ? '\n\n' + after : '')).trim();

    if (finalContent) {
      writeFileSync(GEMINI_MD_PATH, finalContent + '\n');
    } else {
      // File would be empty — leave it empty rather than deleting
      // (user may have other tooling that expects it to exist)
      writeFileSync(GEMINI_MD_PATH, '');
    }

    console.log(`  Removed context section from ${GEMINI_MD_PATH}`);
  } catch (error) {
    logger.warn('GEMINI', 'Failed to clean GEMINI.md context', { error: (error as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Status Check
// ---------------------------------------------------------------------------

/**
 * Check Gemini CLI hooks installation status.
 *
 * @returns 0 always (informational)
 */
export function checkGeminiCliHooksStatus(): number {
  console.log('\nClaude-Mem Gemini CLI Hooks Status\n');

  if (!existsSync(GEMINI_SETTINGS_PATH)) {
    console.log('Status: Not installed');
    console.log(`  No settings file at ${GEMINI_SETTINGS_PATH}`);
    console.log('\nRun: npx claude-mem install --ide gemini-cli\n');
    return 0;
  }

  try {
    const settings: GeminiSettingsJson = JSON.parse(readFileSync(GEMINI_SETTINGS_PATH, 'utf-8'));

    if (!settings.hooks) {
      console.log('Status: Not installed');
      console.log('  settings.json exists but has no hooks section.');
      return 0;
    }

    const installedEvents: string[] = [];
    for (const [eventName, matchers] of Object.entries(settings.hooks)) {
      if (!Array.isArray(matchers)) continue;
      for (const matcher of matchers) {
        if (matcher.hooks?.some((h: GeminiHookEntry) => h.name === HOOK_NAME)) {
          installedEvents.push(eventName);
        }
      }
    }

    if (installedEvents.length === 0) {
      console.log('Status: Not installed');
      console.log('  settings.json exists but no claude-mem hooks found.');
    } else {
      console.log('Status: Installed');
      console.log(`  Config: ${GEMINI_SETTINGS_PATH}`);
      console.log(`  Events: ${installedEvents.join(', ')}`);

      // Check GEMINI.md context
      if (existsSync(GEMINI_MD_PATH)) {
        const mdContent = readFileSync(GEMINI_MD_PATH, 'utf-8');
        if (mdContent.includes('<claude-mem-context>')) {
          console.log(`  Context: Active (${GEMINI_MD_PATH})`);
        } else {
          console.log(`  Context: GEMINI.md exists but no context tags`);
        }
      } else {
        console.log(`  Context: No GEMINI.md file`);
      }

      // Check expected vs actual events
      const expectedEvents = Object.keys(GEMINI_EVENT_TO_CLAUDE_MEM_EVENT);
      const missingEvents = expectedEvents.filter((e) => !installedEvents.includes(e));
      if (missingEvents.length > 0) {
        console.log(`  Warning: Missing events: ${missingEvents.join(', ')}`);
        console.log('  Run install again to add missing hooks.');
      }
    }
  } catch {
    console.log('Status: Unknown');
    console.log('  Could not parse settings.json.');
  }

  console.log('');
  return 0;
}
