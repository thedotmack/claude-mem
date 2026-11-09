import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'fs';
import * as os from 'os';
import { tmpdir } from 'os';
import path from 'path';
import { installOmpHooks } from '../../src/services/integrations/OmpHooksInstaller.js';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// The hook file lands in the user's own OMP hooks directory, where the user may
// already have a copy. Installing over it with a plain writeFileSync truncated
// the file in place, so an interrupted install could leave a half-written hook
// module that OMP then fails to load. A temp-file-plus-rename write yields a
// new file; an in-place truncate keeps the same one.
describe('OMP installs its hook file atomically', () => {
  let tmp: string;
  let previousDevSource: string | undefined;
  let previousAgentDir: string | undefined;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let homedirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'omp-atomic-'));
    previousDevSource = process.env.CLAUDE_MEM_DEV_HOOK_SOURCE;
    // Resolve the hook bundle from the repository checkout instead of a
    // marketplace install, which a test environment does not have.
    process.env.CLAUDE_MEM_DEV_HOOK_SOURCE = '1';
    // The installer honours PI_CODING_AGENT_DIR before the home directory, so
    // point it into the sandbox too; otherwise a developer who has it set would
    // get their real OMP hook replaced by this test.
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = path.join(tmp, '.omp', 'agent');
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    homedirSpy = spyOn(os, 'homedir').mockReturnValue(tmp);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    homedirSpy.mockRestore();
    if (previousDevSource === undefined) delete process.env.CLAUDE_MEM_DEV_HOOK_SOURCE;
    else process.env.CLAUDE_MEM_DEV_HOOK_SOURCE = previousDevSource;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces the installed hook file instead of truncating it in place', async () => {
    expect(await installOmpHooks()).toBe(0);

    const installed = walk(tmp).filter(file => file.endsWith('.ts'));
    expect(installed).toHaveLength(1);
    const hookPath = installed[0];
    // Fail loudly rather than assert against a file outside the sandbox.
    expect(hookPath.startsWith(tmp)).toBe(true);

    const first = statSync(hookPath);
    expect(await installOmpHooks()).toBe(0);
    const second = statSync(hookPath);

    // Either signal proves the file was replaced, not rewritten: a fresh inode
    // on POSIX, or a new creation time where the filesystem reports one.
    expect(second.ino !== first.ino || second.birthtimeMs !== first.birthtimeMs).toBe(true);
  });
});
