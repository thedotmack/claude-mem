#!/usr/bin/env bun

import { linkSync, lstatSync, mkdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { workerHttpRequest } from '../src/shared/worker-utils.js';
import { writeTextFileAtomic } from '../src/shared/atomic-json.js';
import { projectMemoryContent } from '../src/shared/progressive-search.js';

interface ExportOptions {
  vault: string;
  /** A stable, user-chosen label for this worker's installation. */
  source: string;
  project: string;
  ids: number[];
}

const observationSchema = z.object({
  id: z.number().int().positive().safe(),
  project: z.string(),
  title: z.string().nullable().optional(),
  subtitle: z.string().nullable().optional(),
  narrative: z.string().nullable().optional(),
}).passthrough();

function exportDirectory(vault: string, source: string): string {
  let directory = vault;
  for (const part of ['Claude-Mem', source]) {
    directory = join(directory, part);
    // Create first, then check what is there. Another export can create the
    // folder between a check and a create; mkdir never follows a symlink it finds.
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The export directory must be a directory, not a symlink or file.');
  }
  return directory;
}

export async function exportObsidianNotes(options: ExportOptions): Promise<{ created: number[]; skipped: number[] }> {
  const { source, project } = options;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)) throw new Error('Choose a stable source label using lowercase letters, digits, underscores or hyphens.');
  if (!project.trim()) throw new Error('Choose a nonempty project.');
  const ids = [...new Set(options.ids)];
  if (!ids.length || ids.length > 100 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Choose between 1 and 100 positive observation IDs.');
  if (!isAbsolute(options.vault)) throw new Error('Choose an absolute Obsidian vault path.');
  const vault = realpathSync(options.vault);
  try {
    if (!statSync(join(vault, '.obsidian')).isDirectory()) throw new Error('Not a vault');
  } catch {
    throw new Error('Choose an existing vault with an .obsidian directory.');
  }

  const response = await workerHttpRequest('/api/observations/batch', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, project, projects: [project] }), timeoutMs: 10_000,
  });
  if (!response.ok) throw new Error(`The worker could not export the selected notes (HTTP ${response.status}).`);
  const checked = z.array(observationSchema).safeParse(await response.json());
  if (!checked.success) throw new Error('The worker returned invalid observation data.');
  const notes = new Map<number, string>();
  for (const observation of checked.data) {
    if (observation.project !== project || !ids.includes(observation.id) || notes.has(observation.id)) {
      throw new Error('The worker returned records outside the selected project or IDs.');
    }
    const content = projectMemoryContent(observation);
    if (content.truncated) throw new Error('This export would shorten a note. Use the full JSON memory export instead.');
    // Literal prose cannot activate Markdown images, HTML or Obsidian embeds.
    const longestFence = (content.text.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 2);
    const fence = '`'.repeat(longestFence + 1);
    notes.set(observation.id, [
      '---', `title: ${JSON.stringify(observation.title || `Memory ${observation.id}`)}`,
      `claude_mem_id: ${observation.id}`, `claude_mem_source: ${JSON.stringify(source)}`,
      `claude_mem_project: ${JSON.stringify(project)}`, '---', '',
      `# Memory ${observation.id}`, '', `${fence}text`, content.text, fence, '',
    ].join('\n'));
  }
  if (ids.some(id => !notes.has(id))) throw new Error('Some selected IDs were not returned for this project. Nothing was exported.');

  const directory = exportDirectory(vault, source);
  const result = { created: [] as number[], skipped: [] as number[] };
  for (const id of ids) {
    const temporary = join(directory, `.${id}.${randomUUID()}.tmp`);
    writeTextFileAtomic(temporary, notes.get(id)!, { mode: 0o600 });
    try {
      // Publish only a complete file, atomically refusing any existing target.
      linkSync(temporary, join(directory, `${id}.md`));
      result.created.push(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      result.skipped.push(id);
    } finally {
      unlinkSync(temporary);
    }
  }
  return result;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: {
      vault: { type: 'string' }, source: { type: 'string' }, project: { type: 'string' }, ids: { type: 'string' },
    } });
    if (!values.vault || !values.source || !values.project || !values.ids) {
      throw new Error('Usage: bun scripts/export-obsidian.ts --vault /absolute/vault --source laptop --project my-app --ids 12,34');
    }
    console.log(JSON.stringify(await exportObsidianNotes({
      vault: values.vault, source: values.source, project: values.project, ids: values.ids.split(',').map(Number),
    })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The selected notes could not be exported.');
    process.exitCode = 1;
  }
}
