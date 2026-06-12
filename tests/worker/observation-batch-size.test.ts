import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  MAX_OBSERVATION_BATCH_SIZE,
  ObservationBatchSizeResolver,
  parseObservationBatchSize,
} from '../../src/services/worker/observation-batch-size.js';

let tempDirs: string[] = [];

function createSettingsFile(batchSize: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-mem-batch-size-'));
  tempDirs.push(dir);
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_OBSERVATION_BATCH_SIZE: batchSize }), 'utf-8');
  return settingsPath;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('observation batch size', () => {
  it('clamps invalid and out-of-range settings', () => {
    expect(parseObservationBatchSize('not-a-number')).toBe(5);
    expect(parseObservationBatchSize('0')).toBe(1);
    expect(parseObservationBatchSize('-2')).toBe(1);
    expect(parseObservationBatchSize('999')).toBe(MAX_OBSERVATION_BATCH_SIZE);
    expect(parseObservationBatchSize('12')).toBe(12);
  });

  it('accepts numeric JSON settings from existing user config files', () => {
    const settingsPath = createSettingsFile(7);
    const resolver = new ObservationBatchSizeResolver(settingsPath, 1000);

    expect(resolver.get(10_000)).toBe(7);
  });

  it('caches settings reads until the TTL expires', () => {
    const settingsPath = createSettingsFile('7');
    const resolver = new ObservationBatchSizeResolver(settingsPath, 1000);

    expect(resolver.get(10_000)).toBe(7);

    writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_OBSERVATION_BATCH_SIZE: '11' }), 'utf-8');

    expect(resolver.get(10_500)).toBe(7);
    expect(resolver.get(11_001)).toBe(11);
  });
});
