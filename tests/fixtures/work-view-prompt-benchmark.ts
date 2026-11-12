import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildAgentView } from '../../src/services/work-view/agent-view.mjs';
import { NOW, promptWindow } from './work-view-prompt-window.js';

const output = process.argv[2];
if (!output) throw new Error('Pass an output path for the complete projected JSON');
const window = promptWindow();
try {
  const records = window.read();
  assert.equal(records.sessions.length, 600);
  assert.equal(records.prompts.length, 12000);
  assert.equal(records.observations.length, 300);
  const initial = JSON.stringify(records);
  const render = () => buildAgentView(window.state, records, { now: NOW });
  const warm = render();
  assert.equal(warm.humanRequests.length, 600);
  assert.equal(warm.agents.flatMap((agent: any) => agent.work).length, 300);
  const expected = JSON.stringify(warm);
  const samples: number[] = [];
  for (let iteration = 0; iteration < 5; iteration++) {
    const start = performance.now();
    const view = render();
    samples.push(performance.now() - start);
    assert.equal(JSON.stringify(view), expected);
  }
  assert.equal(JSON.stringify(records), initial);
  writeFileSync(output, expected);
  console.log(JSON.stringify({
    label: process.env.BENCHMARK_LABEL ?? 'unknown',
    sessions: records.sessions.length, prompts: records.prompts.length,
    observations: records.observations.length, requests: warm.humanRequests.length,
    workItems: warm.agents.flatMap((agent: any) => agent.work).length,
    warmups: 1, samplesMs: samples, medianMs: [...samples].sort((a, b) => a - b)[2],
    outputBytes: Buffer.byteLength(expected),
    outputSha256: createHash('sha256').update(expected).digest('hex'),
  }));
} finally { window.database.close(); }
