import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { writeAgentsMd } from '../../src/utils/agents-md-utils.js';

// The AGENTS.md writer must not use a predictable `${target}.tmp` sibling:
// a planted symlink at that exact path would be followed by the old
// writeFileSync and clobber whatever it points at. The writer now goes
// through writeTextFileAtomic (random exclusive-create temp file), so a
// planted `.tmp` is left untouched and the authored file survives.
describe.skipIf(process.platform === 'win32')('writeAgentsMd avoids a planted .tmp sibling', () => {
  let tmp: string;
  let folder: string;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'agents-md-atomic-')));
    folder = path.join(tmp, 'project');
    mkdirSync(folder, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('does not follow a planted symlink at <target>.tmp', () => {
    const innocent = path.join(tmp, 'innocent.md');
    writeFileSync(innocent, 'precious authored content\n');
    const agentsMd = path.join(folder, 'AGENTS.md');
    symlinkSync(innocent, `${agentsMd}.tmp`);

    writeAgentsMd(agentsMd, 'fresh memory context');

    // The planted link and its target are untouched; the write landed in
    // AGENTS.md itself via a random temp file.
    expect(lstatSync(`${agentsMd}.tmp`).isSymbolicLink()).toBe(true);
    expect(readFileSync(innocent, 'utf-8')).toBe('precious authored content\n');
    const content = readFileSync(agentsMd, 'utf-8');
    expect(content).toContain('fresh memory context');
    expect(existsSync(`${agentsMd}.tmp`)).toBe(true);
  });

  it('leaves no temp file behind and keeps authored content on success', () => {
    const agentsMd = path.join(folder, 'AGENTS.md');
    writeFileSync(agentsMd, '# my rules\n');

    writeAgentsMd(agentsMd, 'fresh memory context');

    const content = readFileSync(agentsMd, 'utf-8');
    expect(content).toContain('# my rules');
    expect(content).toContain('fresh memory context');
    const siblings = readdirSync(folder).filter(name => name.endsWith('.tmp'));
    expect(siblings).toEqual([]);
  });
});
