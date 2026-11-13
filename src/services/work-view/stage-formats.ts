/**
 * The formats a finished request can be staged in for review. A format is data: an id, a label and the instructions
 * the agent follows. Every stage is a Markdown file, served as plain text, so nothing an agent wrote ever runs in the
 * browser. The three built-ins are below; the owner adds their own by dropping a Markdown file in
 * ~/.claude-mem/stage-formats/ (front matter `name`, then the instructions), and a file named like a built-in
 * replaces it. My Work lists whatever this module answers; it has no list of its own.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { STAGE_FORMAT_ID_PATTERN } from './owner-runs.mjs';

export interface StageFormat { id: string; label: string; instructions: string; builtIn: boolean }
/** A format as My Work lists it: everything but the instructions. */
export type StageFormatInfo = Omit<StageFormat, 'instructions'>;

export const STAGE_FORMATS_DIRNAME = 'stage-formats';
const MAX_CUSTOM_FORMATS = 24;
const MAX_FORMAT_FILE_BYTES = 64 * 1024;
const MAX_LABEL_CHARS = 40;

export const BUILT_IN_STAGE_FORMATS: readonly StageFormat[] = [
  {
    id: 'brief', label: 'Brief', builtIn: true,
    instructions: [
      'A review the owner reads in under a minute, at most 250 words.',
      'Open with the ask in the owner\'s own words (one quote), then say in two or three sentences what was made.',
      'Then "Look at this first": the one or two pieces of evidence that show the result, shown as themselves.',
      'End with "Not verified": what you could not open or what the evidence does not prove. One line when there is nothing.',
    ].join(' '),
  },
  {
    id: 'one-pager', label: 'One-pager', builtIn: true,
    instructions: [
      'One page with these headings, in this order: What you asked, What changed, The evidence, What could go wrong, What to decide.',
      'Under "The evidence" show each piece as itself, with one line saying what it proves.',
      'Under "What to decide" list only decisions that are the owner\'s, each as a question they can answer in a sentence.',
      'At most 600 words.',
    ].join(' '),
  },
  {
    id: 'technical', label: 'Technical walkthrough', builtIn: true,
    instructions: [
      'For a reviewer who reads code. Start with the shape of the change from the real diff: which files, how many lines, what moved where.',
      'Then walk the change in the order a reader should review it, quoting the hunks that carry the risk in fenced code blocks, each with its file path.',
      'Then "Tests": what the diff adds or changes in tests, and what it leaves untested.',
      'End with "Not opened": every commit, pull request or file you were told about and could not read.',
    ].join(' '),
  },
];

/** `---` front matter with `key: value` lines, then the body. A file without front matter is all body. */
function parseFormatFile(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!match) return { fields: {}, body: text };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (pair) fields[pair[1].toLowerCase()] = pair[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { fields, body: match[2] };
}

/**
 * Every format, built-ins first, then the owner's own in file-name order. A file the reader cannot use (a name that is
 * not a format id, no instructions, too large) is left out and named in `skipped`, never guessed at.
 */
export function readStageFormats(dataDir: string): { formats: StageFormat[]; skipped: string[] } {
  const dir = join(dataDir, STAGE_FORMATS_DIRNAME);
  let names: string[] = [];
  try { names = readdirSync(dir).filter(name => name.toLowerCase().endsWith('.md')).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { formats: [...BUILT_IN_STAGE_FORMATS], skipped: [`${STAGE_FORMATS_DIRNAME}: ${(error as Error).message}`] }; }
  const custom = new Map<string, StageFormat>();
  const skipped: string[] = [];
  for (const name of names) {
    const id = name.slice(0, -3).toLowerCase();
    const skip = (why: string) => { skipped.push(`${name}: ${why}`); };
    if (!STAGE_FORMAT_ID_PATTERN.test(id)) { skip('its name must be lowercase letters, digits and dashes'); continue; }
    if (custom.size >= MAX_CUSTOM_FORMATS) { skip(`only ${MAX_CUSTOM_FORMATS} formats are read`); continue; }
    let text: string;
    try {
      const path = join(dir, name);
      if (statSync(path).size > MAX_FORMAT_FILE_BYTES) { skip('it is too large'); continue; }
      text = readFileSync(path, 'utf8');
    } catch (error) { skip((error as Error).message); continue; }
    const { fields, body } = parseFormatFile(text);
    // A stage is always Markdown: a file that asks for anything else is refused, never quietly made as Markdown.
    if (fields.output && fields.output.toLowerCase() !== 'markdown') { skip('a stage is always Markdown; remove "output"'); continue; }
    if (!body.trim()) { skip('it has no instructions'); continue; }
    custom.set(id, { id, label: (fields.name || id).slice(0, MAX_LABEL_CHARS), instructions: body.trim(), builtIn: false });
  }
  return { formats: [...BUILT_IN_STAGE_FORMATS.filter(format => !custom.has(format.id)), ...custom.values()], skipped };
}

export const stageFormatInfo = ({ instructions: _instructions, ...info }: StageFormat): StageFormatInfo => info;
