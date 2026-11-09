// The remote hook spool is uploaded by a detached `<script> upload-spool` child.
// Only worker-service.cjs handles `upload-spool`; when a hook runs from the
// hook-only bundle (hook-service.cjs) the child must use the worker bundle
// sitting next to it, from the same running plugin root, rather than whichever
// installed root has the highest version. Sandboxes live in the project-local
// .scratch directory, never the system temp directory.
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { uploadSpoolEntrypoint } from '../../src/cli/spool-hook-event.js';

const SCRATCH = join(import.meta.dir, '../../.scratch');
const sandboxes: string[] = [];

function pluginScripts(files: string[]): string {
  mkdirSync(SCRATCH, { recursive: true });
  const sandbox = mkdtempSync(join(SCRATCH, 'upload-spool-entrypoint-'));
  sandboxes.push(sandbox);
  const scripts = join(sandbox, 'scripts');
  mkdirSync(scripts);
  for (const file of files) writeFileSync(join(scripts, file), '');
  return scripts;
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe('uploadSpoolEntrypoint', () => {
  it('uses the running worker-service.cjs itself', () => {
    const scripts = pluginScripts(['worker-service.cjs', 'hook-service.cjs']);
    expect(uploadSpoolEntrypoint(join(scripts, 'worker-service.cjs'))).toBe(join(scripts, 'worker-service.cjs'));
  });

  it('maps the running hook-service.cjs to its sibling worker-service.cjs', () => {
    const scripts = pluginScripts(['worker-service.cjs', 'hook-service.cjs']);
    expect(uploadSpoolEntrypoint(join(scripts, 'hook-service.cjs'))).toBe(join(scripts, 'worker-service.cjs'));
  });

  it('never returns hook-service.cjs, which has no upload-spool command', () => {
    const scripts = pluginScripts(['hook-service.cjs']);
    expect(uploadSpoolEntrypoint(join(scripts, 'hook-service.cjs'))).not.toBe(join(scripts, 'hook-service.cjs'));
  });
});
