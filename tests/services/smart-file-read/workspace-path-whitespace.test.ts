import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWithinWorkspace } from '../../../src/services/smart-file-read/workspace-path.js';
const workspace = mkdtempSync(join(tmpdir(), 'cm-path-spaces-'));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));
describe('literal smart tool file paths', () => {
  it('keeps a requested filename distinct from its trimmed neighbor', async () => {
    const literal = join(workspace, ' padded.ts');
    writeFileSync(literal, 'export const expected = true;');
    writeFileSync(join(workspace, 'padded.ts'), 'export const wrong = true;');
    expect(await resolveWithinWorkspace(' padded.ts', workspace)).toBe(realpathSync(literal));
  });
  (process.platform === 'win32' ? it.skip : it)('retains a trailing space in an absolute file path', async () => {
    const literal = join(workspace, 'absolute.ts ');
    writeFileSync(literal, 'export const absolute = true;');
    expect(await resolveWithinWorkspace(literal, workspace)).toBe(realpathSync(literal));
  });
});
