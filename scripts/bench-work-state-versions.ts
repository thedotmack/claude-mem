/**
 * Compare item-version lookup and the public My Work projection against a base.
 * Usage: bun scripts/bench-work-state-versions.ts <baseline-git-ref>
 * Only synthetic saved work-state rows are used; no model or network calls.
 */
import { deepStrictEqual } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { reduceWorkState } from '../src/services/work-view/work-state-reduce.mjs';
import { workStateItems } from '../src/services/work-view/work-state-labels.mjs';
import { buildAgentView } from '../src/services/work-view/agent-view.mjs';

const baseline = process.argv[2];
if (!baseline) throw new Error('Pass the git ref before the item-version index change.');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, 'src/services/work-view');
const suffix = `${process.pid}-${Date.now()}`;
const labelsName = `bench-state-labels-${suffix}.mjs`;
const viewName = `bench-state-view-${suffix}.mjs`;
const labelsPath = join(sourceDir, labelsName), viewPath = join(sourceDir, viewName);
const now = Date.UTC(2026, 10, 14);

function fixture(lists: number, updates: number, latestState = false) {
  const entries: Array<Record<string, unknown>> = [];
  const add = (list: number, fields: Record<string, unknown>) => {
    const id = entries.length + 1;
    entries.push({ id, project: 'synthetic-repo', list_name: `work-${list}`, fields,
      created_at_epoch: now - 60_000 + id });
  };
  for (let list = 0; list < lists; list++) add(list, { phase: 'Preparing release' });
  for (let update = 0; update < updates; update++) {
    for (let list = 0; list < lists; list++) add(list, { task: 'Build', status: 'doing', progress: `Step ${update}` });
  }
  if (latestState) for (let list = 0; list < lists; list++) add(list, { phase: 'Ready to verify' });
  return reduceWorkState(entries, { currentProject: 'synthetic-repo', currentProjectScope: ['synthetic-repo'] });
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

try {
  writeFileSync(labelsPath, execFileSync('git', ['show', `${baseline}:src/services/work-view/work-state-labels.mjs`], { cwd: root }));
  writeFileSync(viewPath, readFileSync(join(sourceDir, 'agent-view.mjs'), 'utf8')
    .replace("from './work-state-labels.mjs'", `from './${labelsName}'`));
  const previousItems = (await import(pathToFileURL(labelsPath).href)).workStateItems;
  const previousView = (await import(pathToFileURL(viewPath).href)).buildAgentView;
  for (const [lists, updates, latestState] of [[10, 3, false], [200, 10, false], [1000, 20, false], [1, 10000, true]] as const) {
    const state = fixture(lists, updates, latestState);
    const operations = {
      items: [() => previousItems(state), () => workStateItems(state)],
      view: [() => previousView(state, {}, { now }), () => buildAgentView(state, {}, { now })],
    };
    for (const [operation, implementations] of Object.entries(operations)) {
      const samples: number[][] = [[], []];
      for (let round = 0; round < 9; round++) {
        const outputs: unknown[] = [];
        for (const version of round % 2 ? [1, 0] : [0, 1]) {
          Bun.gc(true);
          const start = performance.now();
          outputs[version] = implementations[version]();
          const elapsed = performance.now() - start;
          if (round >= 2) samples[version].push(elapsed);
        }
        deepStrictEqual(outputs[0], outputs[1]);
      }
      console.log(JSON.stringify({ lists, events: state.events.length, latestState, operation,
        medianMs: { baseline: median(samples[0]), current: median(samples[1]) }, samplesMs: samples }));
    }
  }
} finally {
  for (const path of [labelsPath, viewPath]) {
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
