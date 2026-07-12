import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';

describe('sync-marketplace', () => {
  it('preserves nested worktrees when syncing with --delete', () => {
    const script = readFileSync(
      path.join(import.meta.dir, '../../scripts/sync-marketplace.cjs'),
      'utf8',
    );

    expect(script).toContain('--exclude=.worktrees/');
  });
});
