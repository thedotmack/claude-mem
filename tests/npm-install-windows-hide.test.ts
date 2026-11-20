import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SOURCE = readFileSync(
  join(import.meta.dir, '../src/npx-cli/install/npm-install-helper.ts'),
  'utf8',
);

describe('npm-install-helper Windows spawn', () => {
  it('hides the console window when spawning npm (incl. Windows shell)', () => {
    expect(SOURCE).toMatch(/spawn\('npm', flags, \{[^}]*windowsHide: true/);
  });
});
