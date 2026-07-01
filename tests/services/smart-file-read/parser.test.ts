import { describe, expect, it } from 'bun:test';
import { parseFile } from '../../../src/services/smart-file-read/parser.js';

describe('smart file parser', () => {
  it('extracts TypeScript symbols when the user cache is not writable', () => {
    const previousCacheHome = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = '/dev/null/claude-mem-unwritable-cache';

    try {
      const parsed = parseFile(
        [
          'export function smartExploreProbe(value: string): string {',
          '  return value;',
          '}',
          '',
          'export class ProbeClass {',
          '  run(): boolean {',
          '    return true;',
          '  }',
          '}',
        ].join('\n'),
        'smart-explore-fixture.ts',
        process.cwd(),
      );

      expect(parsed.symbols.map((symbol) => symbol.name)).toEqual([
        'smartExploreProbe',
        'ProbeClass',
      ]);
      expect(parsed.symbols[1]?.children?.map((symbol) => symbol.name)).toEqual(['run']);
    } finally {
      if (previousCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheHome;
    }
  });
});
