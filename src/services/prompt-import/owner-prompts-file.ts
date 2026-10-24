/**
 * Step 1 of the owner-goals skill, done by the prompt importer: writes
 * `owner-prompts.md` and `excluded-agent-written-prompts.md` in the exact
 * format `export_owner_prompts.py` writes, so `save_goals.py` checks quotes
 * the same way. One filter for every agent (Claude Code, Codex, Gemini CLI,
 * Antigravity CLI, OpenCode) instead of the script's two.
 */

import { stripMemoryTags } from '../../utils/tag-stripping.js';
import { mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { scanOwnerPrompts, scanWindowStart, PROMPT_SCAN_WINDOW_DAYS, type OwnerPrompt, type PromptScanOptions } from './index.js';

/** export_owner_prompts.py MAXIMUM_KEPT_PROMPT_CHARACTERS */
const MAXIMUM_KEPT_PROMPT_CHARACTERS = 3000;

/** The `tool` word in each heading, as export_owner_prompts.py names its two. */
const TOOL_NAMES: Record<string, string> = {
  'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini', 'antigravity-cli': 'antigravity', opencode: 'opencode',
};

const pad = (value: number) => String(value).padStart(2, '0');
/** Local time, minute precision: the heading save_goals.py matches quotes against. */
export function promptMinute(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function section(prompt: OwnerPrompt, trim: boolean): string {
  let text = stripMemoryTags(prompt.text).trim();
  if (trim && text.length > MAXIMUM_KEPT_PROMPT_CHARACTERS) {
    const trimmed = text.length - MAXIMUM_KEPT_PROMPT_CHARACTERS;
    text = `${text.slice(0, MAXIMUM_KEPT_PROMPT_CHARACTERS)}\n\n[... ${trimmed} more characters, mostly pasted material, trimmed]`;
  }
  const project = prompt.cwd ? basename(prompt.cwd) : prompt.project || '?';
  return `## ${promptMinute(prompt.at)} · ${TOOL_NAMES[prompt.agent] ?? prompt.agent} · ${project}\nsession \`${prompt.sessionId.slice(0, 8)}\`\n\n${text}\n`;
}

function render(title: string, sections: string[]): string {
  return `# ${title}\n\n${sections.length} prompts, oldest first.\n\n${sections.join('\n---\n\n')}`;
}

/** `newPrompts` counts the prompts from `sinceMinute` on (0 without it). */
export interface OwnerPromptsFile { path: string; ownerPrompts: number; excludedAgentWritten: number; newPrompts: number }

/**
 * Reads the last `days` of every agent's transcripts and writes the two files into `folder`. With `sinceMinute`
 * (local `YYYY-MM-DD HH:MM`, like the export script's --since) it also writes new-owner-prompts.md with the
 * owner's prompts from that minute on.
 */
export async function writeOwnerPromptsFile(options: {
  folder: string;
  days?: number;
  sinceMinute?: string | null;
  now?: number;
  scan?: typeof scanOwnerPrompts;
  scanOptions?: Omit<PromptScanOptions, 'sinceEpochMs'>;
}): Promise<OwnerPromptsFile> {
  const days = options.days ?? PROMPT_SCAN_WINDOW_DAYS;
  const result = await (options.scan ?? scanOwnerPrompts)({ ...options.scanOptions, sinceEpochMs: scanWindowStart(options.now ?? Date.now(), days) });
  mkdirSync(options.folder, { recursive: true });
  const path = join(options.folder, 'owner-prompts.md');
  writeFileSync(path, render(`Owner prompts (typed by the owner, not written by an agent), last ${days} days`, result.ownerPrompts.map(prompt => section(prompt, true))), { mode: 0o600 });
  writeFileSync(join(options.folder, 'excluded-agent-written-prompts.md'), render('Excluded: prompts an agent wrote first (audit file)', result.agentWritten.map(prompt => section(prompt, false))), { mode: 0o600 });
  const since = options.sinceMinute;
  const newPrompts = since ? result.ownerPrompts.filter(prompt => promptMinute(prompt.at) >= since) : [];
  if (since) writeFileSync(join(options.folder, 'new-owner-prompts.md'), render(`Owner prompts since ${since}`, newPrompts.map(prompt => section(prompt, true))), { mode: 0o600 });
  return { path, ownerPrompts: result.ownerPrompts.length, excludedAgentWritten: result.agentWritten.length, newPrompts: newPrompts.length };
}
