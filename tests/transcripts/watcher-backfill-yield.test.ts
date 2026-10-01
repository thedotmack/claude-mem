import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NormalizedHookInput } from '../../src/cli/types.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

const sessionInitCalls: NormalizedHookInput[] = [];

import * as realSessionInit from '../../src/cli/handlers/session-init.js';
const realSessionInitSnapshot = { ...realSessionInit };

mock.module('../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: {
    execute: async (input: NormalizedHookInput) => {
      sessionInitCalls.push(input);
      return { continue: true, suppressOutput: true };
    },
  },
}));

afterAll(() => {
  mock.module('../../src/cli/handlers/session-init.js', () => realSessionInitSnapshot);
});

import { logger } from '../../src/utils/logger.js';
import { TranscriptWatcher } from '../../src/services/transcripts/watcher.js';

describe('TranscriptWatcher backfill', () => {
  let tmpRoot: string;
  let loggerSpies: ReturnType<typeof spyOn>[] = [];

  beforeEach(() => {
    sessionInitCalls.length = 0;
    tmpRoot = join(tmpdir(), `claude-mem-transcript-backfill-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    loggerSpies.forEach(spy => spy.mockRestore());
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('yields to the event loop mid-backfill so co-scheduled tasks are not starved', async () => {
    const sessionId = '019e050e-7ae0-71b2-b19f-6cc428e5763a';
    const filePath = join(tmpRoot, `${sessionId}.jsonl`);
    const statePath = join(tmpRoot, 'state.json');

    const totalLines = 250;
    const lines = Array.from({ length: totalLines }, (_, i) =>
      JSON.stringify({
        type: 'event',
        payload: { type: 'user_message', session_id: sessionId, message: `line ${i}` },
      }),
    );
    writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

    const schema: TranscriptSchema = {
      name: 'codex-test',
      events: [
        {
          name: 'user-message',
          match: { path: 'payload.type', equals: 'user_message' },
          action: 'session_init',
          fields: { sessionId: 'payload.session_id', prompt: 'payload.message' },
        },
      ],
    };
    const watch: WatchTarget = { name: 'codex', path: join(tmpRoot, '*.jsonl'), schema };
    const watcher = new TranscriptWatcher({ version: 1, watches: [watch] }, statePath);

    // Sample how many lines had been processed each time a co-scheduled
    // macrotask got to run. A backfill that never yields drains its whole line
    // loop in one uninterrupted microtask run, so the samples jump straight
    // from 0 to the total; a yielding backfill lets a sample land in between.
    const samples: number[] = [];
    let sampling = true;
    const sample = () => {
      samples.push(sessionInitCalls.length);
      if (sampling) setImmediate(sample);
    };
    setImmediate(sample);

    await (watcher as any).addTailer(filePath, watch, schema);

    while (sessionInitCalls.length < totalLines) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    sampling = false;
    watcher.stop();

    expect(sessionInitCalls).toHaveLength(totalLines);
    const midLoopSamples = samples.filter(count => count > 0 && count < totalLines);
    expect(midLoopSamples.length).toBeGreaterThan(0);
  });
});
