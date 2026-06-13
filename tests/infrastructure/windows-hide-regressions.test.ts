import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

function readSource(...parts: string[]): string {
  return readFileSync(join(import.meta.dir, '..', '..', ...parts), 'utf-8');
}

describe('windowsHide regression coverage (#2900)', () => {
  it('keeps windowsHide on the remaining live spawn sites', () => {
    expect(readSource('src', 'services', 'infrastructure', 'ProcessManager.ts')).toContain(
      "timeout: 5000,\n    windowsHide: true,"
    );
    expect(readSource('src', 'services', 'infrastructure', 'WorktreeAdoption.ts')).toContain(
      "timeout: GIT_TIMEOUT_MS,\n    windowsHide: true,"
    );
    expect(readSource('src', 'build', 'hook-shell-template.ts')).toContain(
      "stdio:'inherit',windowsHide:true"
    );
    expect(readSource('src', 'services', 'worker-service.ts')).toContain(
      "stdio: 'inherit',\n    windowsHide: true,"
    );
    expect(readSource('src', 'server', 'runtime', 'ServerService.ts')).toContain(
      "stdio: 'ignore',\n    windowsHide: true,"
    );
  });
});
