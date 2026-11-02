import { expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveWatchState } from '../../src/services/transcripts/state';

for (const mask of [0o000, 0o022]) {
  for (const kind of ['new', 'public', 'symlink'] as const) {
    it.skipIf(process.platform === 'win32')(`restricts ${kind} pending-tool state under umask ${mask.toString(8)}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'cm-private-watch-state-'));
      const previousMask = process.umask(mask);
      try {
        const target = join(dir, 'state.json');
        if (kind !== 'new') { writeFileSync(target, '{}'); chmodSync(target, 0o644); }
        const path = kind === 'symlink' ? join(dir, 'linked-state.json') : target;
        if (kind === 'symlink') symlinkSync(target, path);
        saveWatchState(path, { offsets: { transcript: 0 }, pendingTools: {
          transcript: { session: { tool: { toolName: 'Bash', toolInput: { command: 'owned-private-fixture' } } } },
        } });
        expect(readFileSync(target, 'utf8')).toContain('owned-private-fixture');
        expect(statSync(target).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(previousMask);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
