import { describe, expect, it } from 'bun:test';
import { startCommandWantsDaemon } from '../../src/server/runtime/ServerBetaService.js';

// #2444 — `start` must be FOREGROUND by default (usable under systemd
// Type=simple) and detach only when `--daemon` is explicitly passed.
describe('server-beta CLI start mode (#2444)', () => {
  it('runs in the foreground by default (no flags)', () => {
    expect(startCommandWantsDaemon([])).toBe(false);
  });

  it('detaches into a daemon only when --daemon is passed', () => {
    expect(startCommandWantsDaemon(['--daemon'])).toBe(true);
    expect(startCommandWantsDaemon(['-d'])).toBe(true);
  });

  it('ignores unrelated flags and stays foreground', () => {
    expect(startCommandWantsDaemon(['--verbose'])).toBe(false);
    expect(startCommandWantsDaemon(['--port', '9999'])).toBe(false);
  });
});
