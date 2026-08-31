import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { EAT_REJECTED_LOG_PATH } from '../../src/shared/paths.js';
import type { EatChunk, EatDigestResult } from '../../src/services/worker/eat/types.js';
import type { EatRejectEntry } from '../../src/services/worker/eat/reject-log.js';

// Snapshot the real modules BEFORE mock.module mutates the live namespaces,
// then re-register them in afterAll. bun's mock.module is process-global and
// mock.restore() does NOT undo it, so these stubs would otherwise leak into
// other test files in the same `bun test` run.
import * as realDigest from '../../src/services/worker/eat/digest.js';
const realDigestSnapshot = { ...realDigest };
import * as realModeManager from '../../src/services/domain/ModeManager.js';
const realModeManagerSnapshot = { ...realModeManager };

let digestBehavior: (chunk: EatChunk) => Promise<EatDigestResult>;

mock.module('../../src/services/worker/eat/digest.js', () => ({
  buildEatModel: () => 'mock/eat-model',
  digestChunk: async (chunk: EatChunk) => digestBehavior(chunk),
}));

mock.module('../../src/services/domain/ModeManager.js', () => ({
  ModeManager: {
    getInstance: () => ({
      getActiveMode: () => ({ observation_types: [{ id: 'discovery' }] }),
    }),
  },
}));

afterAll(() => {
  mock.module('../../src/services/worker/eat/digest.js', () => realDigestSnapshot);
  mock.module('../../src/services/domain/ModeManager.js', () => realModeManagerSnapshot);
});

import { runEatPipeline } from '../../src/services/worker/eat/pipeline.js';
import { EatError } from '../../src/services/worker/eat/errors.js';

const draft = {
  type: 'discovery',
  title: 'Digested',
  subtitle: 'A digested chunk',
  facts: ['fact'],
  narrative: 'narrative',
  concepts: ['concept'],
};

function rejectLinesFor(requestId: string): EatRejectEntry[] {
  const raw = readFileSync(EAT_REJECTED_LOG_PATH, 'utf-8');
  return raw
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as EatRejectEntry)
    .filter(entry => entry.request_id === requestId);
}

// Two paragraphs of 8000 chars each: > CLAUDE_MEM_EAT_MAX_CHUNK_CHARS (12000)
// combined, so the pipeline produces exactly two chunks.
const TWO_CHUNK_CONTENT = `${'a'.repeat(8000)}\n\n${'b'.repeat(8000)}`;

describe('runEatPipeline error boundaries', () => {
  beforeEach(() => {
    digestBehavior = async () => ({ observations: [draft], model: 'mock/eat-model' });
  });

  it('a failed chunk digest goes to the reject log and the run continues', async () => {
    const requestId = randomUUID();
    digestBehavior = async (chunk: EatChunk) => {
      if (chunk.index === 0) throw new Error('schema validation failed');
      return { observations: [draft], model: 'mock/eat-model' };
    };

    const result = await runEatPipeline(undefined, { content: TWO_CHUNK_CONTENT, requestId });

    expect(result.chunks).toBe(2);
    expect(result.drafts).toEqual([{ ...draft, source: { kind: 'stdin', locator: 'stdin' } }]);
    expect(result.rejected).toBe(1);

    const lines = rejectLinesFor(requestId);
    expect(lines.length).toBe(1);
    expect(lines[0].chunk_index).toBe(0);
    expect(lines[0].reason).toContain('schema validation failed');
    expect(lines[0].source.kind).toBe('stdin');
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('every chunk failing surfaces digest_failed, not an empty success', async () => {
    const requestId = randomUUID();
    digestBehavior = async () => {
      throw new Error('provider allowance exhausted');
    };

    expect.assertions(4);
    try {
      await runEatPipeline(undefined, { content: TWO_CHUNK_CONTENT, requestId });
    } catch (error) {
      expect(error).toBeInstanceOf(EatError);
      expect((error as EatError).code).toBe('digest_failed');
      expect((error as EatError).message).toContain('provider allowance exhausted');
    }
    expect(rejectLinesFor(requestId).length).toBe(2);
  });

  it('an unreadable item in a directory is rejected while the rest digests', async () => {
    const requestId = randomUUID();
    const dir = mkdtempSync(join(tmpdir(), 'eat-extract-'));
    writeFileSync(join(dir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]));
    writeFileSync(join(dir, 'good.txt'), 'hello world');

    const result = await runEatPipeline(dir, { requestId });

    expect(result.chunks).toBe(1);
    expect(result.drafts).toEqual([{
      ...draft,
      source: { kind: 'file', locator: join(dir, 'good.txt') },
    }]);
    expect(result.rejected).toBe(1);

    const lines = rejectLinesFor(requestId);
    expect(lines.length).toBe(1);
    expect(lines[0].reason).toContain('Binary file');
    expect(lines[0].chunk_index).toBeUndefined();
  });

  it('a totally failed single source is an error, not an empty success', async () => {
    const requestId = randomUUID();
    const dir = mkdtempSync(join(tmpdir(), 'eat-extract-'));
    const binaryPath = join(dir, 'only.bin');
    writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02]));

    expect.assertions(2);
    try {
      await runEatPipeline(binaryPath, { requestId });
    } catch (error) {
      expect(error).toBeInstanceOf(EatError);
      expect((error as EatError).code).toBe('invalid_request');
    }
  });

  it('rejects empty extracted content instead of returning an empty success', async () => {
    expect.assertions(2);
    try {
      await runEatPipeline(undefined, { content: '' });
    } catch (error) {
      expect(error).toBeInstanceOf(EatError);
      expect((error as EatError).code).toBe('invalid_request');
    }
  });

  it('does not copy inline text into the public source locator', async () => {
    const secret = 'private inline payload that should not become metadata';
    const result = await runEatPipeline(secret);

    expect(result.source).toEqual({ kind: 'text', locator: 'inline text' });
    expect(result.drafts[0].source).toEqual({ kind: 'text', locator: 'inline text' });
  });

  it('falls back safely when max chunk size is misconfigured as zero', async () => {
    const original = process.env.CLAUDE_MEM_EAT_MAX_CHUNK_CHARS;
    process.env.CLAUDE_MEM_EAT_MAX_CHUNK_CHARS = '0';
    try {
      const result = await runEatPipeline(undefined, { content: 'still digested' });
      expect(result.chunks).toBe(1);
    } finally {
      if (original === undefined) delete process.env.CLAUDE_MEM_EAT_MAX_CHUNK_CHARS;
      else process.env.CLAUDE_MEM_EAT_MAX_CHUNK_CHARS = original;
    }
  });
});
