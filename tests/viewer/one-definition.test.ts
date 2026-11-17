import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * Phase 10's quality and anti-pattern reviews found helpers written two and three times (CLAUDE.md: extract at the
 * second copy). Each now has one definition that the others import; these checks fail if a copy comes back.
 */
const VIEWER = join(import.meta.dir, '../../src/ui/viewer');
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
});
const sources = files(VIEWER).map(path => ({ path: relative(VIEWER, path), text: readFileSync(path, 'utf-8') }));
const where = (pattern: RegExp) => sources.filter(({ text }) => pattern.test(text)).map(({ path }) => path).sort();

describe('one definition each', () => {
  it('one word-search rule for the timeline, a session page, the Sessions list, the project picker and the logs drawer', () => {
    expect(where(/\.every\(\s*word\s*=>/)).toEqual(['utils/search.ts']);
    expect(where(/function (lineHasWords|matchesWords)\b/)).toEqual([]);
  });

  it('one test for a plain left click on the viewer\'s own links', () => {
    expect(where(/function isPlainClick\b/)).toEqual(['utils/links.ts']);
  });

  it('one short-time formatter, the logs drawer\'s seconds included', () => {
    expect(where(/toLocaleTimeString\(/)).toEqual(['utils/formatters.ts']);
    expect(where(/\bformatClockTime\b/)).toEqual([]);
  });

  it('one delete hook for cards and Sessions rows, and one request path for their DELETE', () => {
    expect(where(/useState<Record<string, DeleteEntry>>/)).toEqual(['hooks/useFeedItemDelete.ts']);
    expect(where(/\buseSessionDeletes\b/)).toEqual([]);
    expect(where(/method: 'DELETE'/)).toEqual(['utils/feed-deletion.ts']);
    // DeleteStage names the one writer both use (state-machines.md).
    expect(readFileSync(join(VIEWER, 'hooks/useFeedItemDelete.ts'), 'utf-8')).toMatch(/One writer: useDeletes/);
  });

  it('one row-window threshold for the timeline, session pages, the Sessions list and the logs drawer', () => {
    expect(where(/THRESHOLD = \d/)).toEqual(['components/WindowedFeed.tsx']);
    expect(readFileSync(join(VIEWER, 'components/LogsModal.tsx'), 'utf-8')).toMatch(/import \{ FEED_WINDOW_THRESHOLD \} from '\.\/WindowedFeed'/);
  });

  it('one row-overflow watcher for every sideways row with a hidden scrollbar', () => {
    expect(where(/new ResizeObserver\(update\)/)).toEqual(['hooks/useRowOverflow.ts']);
  });

  it('no prop that nothing passes', () => {
    expect(where(/\bshowDate\b/)).toEqual([]);
  });
});
