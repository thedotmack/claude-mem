import { describe, expect, it } from 'bun:test';
import { selectWindowsCommandCandidate } from '../../src/shared/spawn.js';

describe('Windows #3677 - Volta Bun shims resolve to the native executable', () => {
  it('prefers the native executable returned for a Volta shim', () => {
    const shim = 'C:\\Users\\tester\\AppData\\Local\\Volta\\bin\\bun.cmd';
    const executable = 'C:\\Users\\tester\\AppData\\Local\\Volta\\tools\\image\\bun\\1.3.11\\bun.exe';

    expect(selectWindowsCommandCandidate([shim], candidate => {
      expect(candidate).toBe(shim);
      return executable;
    })).toBe(executable);
  });

  it('keeps a non-Volta command shim when no native target is resolved', () => {
    const shim = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\bun.cmd';
    expect(selectWindowsCommandCandidate([shim], () => null)).toBe(shim);
  });
});
