import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookSpool } from '../../src/shared/hook-spool.js';
import { ensurePrivateDir } from '../../src/shared/paths.js';

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
const modeOf = (target: string): number => statSync(target).mode & 0o777;

describe.skipIf(process.platform === 'win32')('owner-only data directories', () => {
  it('creates a directory its owner alone can read', () => {
    const target = join(scratch('cmem-private-'), 'data');
    ensurePrivateDir(target);
    expect(modeOf(target)).toBe(0o700);
  });

  it('narrows a directory an earlier install left readable by every account', () => {
    const target = join(scratch('cmem-private-'), 'data');
    mkdirSync(target);
    chmodSync(target, 0o755);
    ensurePrivateDir(target);
    expect(modeOf(target)).toBe(0o700);
  });

  it('writes hook spool entries and their directory owner-only', () => {
    const directory = join(scratch('cmem-spool-'), 'spool');
    const spool = new HookSpool(directory);
    const entryPath = spool.enqueue('work_state_telemetry', {
      contentSessionId: 'session-1',
      platformSource: 'claude',
      eventId: 'event-1',
      kind: 'instruction',
    });
    expect(modeOf(entryPath)).toBe(0o600);
    expect(modeOf(directory)).toBe(0o700);
  });
});
