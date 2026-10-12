import { describe, expect, it } from 'bun:test';
import { HOOK_ORIGINAL_CWD_ENV, restoreHookOriginalCwd } from '../../src/cli/hook-original-cwd.js';

// #4628: bun-runner starts the hook child in tmpdir(); adapters without a
// payload cwd fall back to process.cwd(), so the hook entry moves back first.
describe('restoreHookOriginalCwd', () => {
  it('moves back to the launch directory and consumes the variable', () => {
    const env: NodeJS.ProcessEnv = { [HOOK_ORIGINAL_CWD_ENV]: '/work/project' };
    const visited: string[] = [];
    restoreHookOriginalCwd(env, (directory) => { visited.push(directory); });
    expect(visited).toEqual(['/work/project']);
    expect(env[HOOK_ORIGINAL_CWD_ENV]).toBeUndefined();
  });

  it('does nothing when the hook was not launched through bun-runner', () => {
    const visited: string[] = [];
    restoreHookOriginalCwd({}, (directory) => { visited.push(directory); });
    expect(visited).toEqual([]);
  });

  it('stays put when the launch directory no longer exists', () => {
    const env: NodeJS.ProcessEnv = { [HOOK_ORIGINAL_CWD_ENV]: '/gone' };
    expect(() => restoreHookOriginalCwd(env, () => { throw new Error('ENOENT'); })).not.toThrow();
    expect(env[HOOK_ORIGINAL_CWD_ENV]).toBeUndefined();
  });
});
