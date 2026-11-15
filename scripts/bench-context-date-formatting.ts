/** Run with Bun: bun scripts/bench-context-date-formatting.ts [rows=50] [full]. */
import { createHash } from 'node:crypto';
import { renderContextFromRows } from '../src/services/context/ContextBuilder.js';
import { ModeManager } from '../src/services/domain/ModeManager.js';
import type { ContextConfig, Observation } from '../src/services/context/types.js';

const count = Number(process.argv[2] ?? 50);
if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error('rows must be an integer from 1 to 10000');
const full = process.argv[3] === 'full';
ModeManager.getInstance().loadMode('code');
const config: ContextConfig = {
  totalObservationCount: count, fullObservationCount: 0, sessionCount: 3,
  showReadTokens: false, showWorkTokens: false, observationTypes: new Set(['discovery']),
  observationConcepts: new Set(), fullObservationField: 'narrative',
  showLastSummary: false, showLastMessage: false, mainAgentOnly: false,
};
const observations: Observation[] = Array.from({ length: count }, (_, index) => {
  const epoch = Date.UTC(2026, 10, 12, 0, index);
  return {
    id: index + 1, memory_session_id: 'benchmark', type: 'discovery',
    title: `Observation ${index}: index lifecycle validation`, subtitle: null,
    narrative: 'A compact note for the memory timeline', facts: '[]', concepts: '[]',
    files_read: '[]', files_modified: '[]', discovery_tokens: 0,
    created_at: new Date(epoch).toISOString(), created_at_epoch: epoch,
  };
}).reverse();

const samples: number[] = [];
let text = '';
for (let iteration = 0; iteration < 7; iteration++) {
  const start = performance.now();
  text = renderContextFromRows({ observations, summaries: [] }, {
    includeHealthWarning: false, includePriorMessage: false, full,
  }, false, { config, cwd: '/benchmark' }).text;
  if (iteration >= 2) samples.push(performance.now() - start);
}
console.log(JSON.stringify({
  runtime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version,
  rows: count, full, samplesMs: samples,
  medianMs: [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)],
  chars: text.length, sha256: createHash('sha256').update(text).digest('hex'),
}));
