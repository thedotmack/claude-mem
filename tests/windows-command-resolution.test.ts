import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dir, '..');

function source(path: string): string {
  return readFileSync(join(root, path), 'utf-8');
}

describe('Windows command resolution (#3046)', () => {
  it('does not use shell: IS_WINDOWS for doctor version probes', () => {
    const doctor = source('src/npx-cli/commands/doctor.ts');
    expect(doctor).not.toContain('shell: IS_WINDOWS');
    expect(doctor).toContain("['/d', '/c', bin, '--version']");
  });

  it('does not use shell: IS_WINDOWS for setup-runtime version probes', () => {
    const setupRuntime = source('src/npx-cli/install/setup-runtime.ts');
    expect(setupRuntime).not.toContain('shell: IS_WINDOWS');
    expect(setupRuntime).toContain("args: ['/d', '/c', command, ...args]");
  });

  it('runs npm through cmd.exe /d /c on Windows without shell:true', () => {
    const npmHelper = source('src/npx-cli/install/npm-install-helper.ts');
    expect(npmHelper).not.toContain('shell: process.env.ComSpec');
    expect(npmHelper).toContain("['/d', '/c', 'npm', ...flags]");
  });
});
