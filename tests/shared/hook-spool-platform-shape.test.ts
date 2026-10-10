import { expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HookSpool } from '../../src/shared/hook-spool.js';
import { logger } from '../../src/utils/logger.js';

it('quarantines malformed platform values without aborting valid spool delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmem-spool-platform-'));
  const spies = [spyOn(logger, 'error').mockImplementation(() => {}), spyOn(logger, 'info').mockImplementation(() => {})];
  try {
    const spool = new HookSpool(dir);
    mkdirSync(spool.directory, { recursive: true });
    spool.enqueue('session_end', { contentSessionId: 'valid-session', platformSource: 'claude' });
    for (const [index, platformSource] of [{}, 17, true].entries()) {
      writeFileSync(join(spool.directory, `session_end-malformed-${index}.json`), JSON.stringify({ kind: 'session_end', payload: { contentSessionId: 'malformed-session', platformSource }, enqueuedAtEpochMs: Date.now() }));
    }
    const accepted: string[] = [];
    const result = await spool.drain(entry => { accepted.push(entry.payload.contentSessionId); return true; });
    expect(accepted).toEqual(['valid-session']);
    expect(result).toEqual({ drained: 1, retained: 0, quarantined: 3, expired: 0 });
  } finally {
    for (const spy of spies) spy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
