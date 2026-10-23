import { describe, expect, it } from 'bun:test';
import {
  WINDOWS_COMMAND_LINE_CHARACTER_LIMIT,
  commandLineLength,
  filesForLane,
  runTestFilesInBatches,
  splitTestFilesIntoCommandLineBatches,
} from '../../scripts/test-lanes';

describe('test-lanes command-line batching', () => {
  const commandPrefix = [process.execPath, 'test', '--timeout', '20000'];

  it('splits the real fast lane into batches that each fit a Windows command line, in order', () => {
    const fastLaneFiles = filesForLane('fast').map(path => `./${path}`);
    // Guard the premise: one command line for the whole lane would be over the limit.
    expect(commandLineLength([...commandPrefix, ...fastLaneFiles])).toBeGreaterThan(WINDOWS_COMMAND_LINE_CHARACTER_LIMIT);

    const batches = splitTestFilesIntoCommandLineBatches(commandPrefix, fastLaneFiles);

    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
      expect(commandLineLength([...commandPrefix, ...batch])).toBeLessThanOrEqual(WINDOWS_COMMAND_LINE_CHARACTER_LIMIT);
    }
    expect(batches.flat()).toEqual(fastLaneFiles);
  });

  it('keeps a short lane in one batch', () => {
    expect(splitTestFilesIntoCommandLineBatches(commandPrefix, ['./tests/a.test.ts', './tests/b.test.ts']))
      .toEqual([['./tests/a.test.ts', './tests/b.test.ts']]);
  });

  it('throws when a single path cannot fit on one command line', () => {
    const tooLongPath = `./tests/${'x'.repeat(WINDOWS_COMMAND_LINE_CHARACTER_LIMIT)}.test.ts`;
    expect(() => splitTestFilesIntoCommandLineBatches(commandPrefix, [tooLongPath])).toThrow(/command line/);
  });

  it('refuses an empty lane, because `bun test` with no paths runs every test', () => {
    expect(() => splitTestFilesIntoCommandLineBatches(commandPrefix, [])).toThrow(/no test files/);
  });

  it('runs every batch and fails when any batch fails', async () => {
    const ranBatches: string[][] = [];
    const exitCode = await runTestFilesInBatches([['./a'], ['./b'], ['./c']], async batch => {
      ranBatches.push(batch);
      return batch[0] === './b' ? 1 : 0;
    });
    expect(ranBatches).toEqual([['./a'], ['./b'], ['./c']]);
    expect(exitCode).toBe(1);
  });

  it('passes when every batch passes', async () => {
    expect(await runTestFilesInBatches([['./a'], ['./b']], async () => 0)).toBe(0);
  });
});
