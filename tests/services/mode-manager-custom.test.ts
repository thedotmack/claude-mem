import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const projectRoot = path.resolve(import.meta.dir, '../..');
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-mem-mode-manager-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runModeProbe(dataDir: string, modeId: string) {
  const probe = `
    import { ModeManager } from './src/services/domain/ModeManager.ts';
    const manager = ModeManager.getInstance();
    const mode = manager.loadMode(${JSON.stringify(modeId)});
    console.log(JSON.stringify({
      id: manager.getActiveModeId(),
      name: mode.name,
      types: mode.observation_types.map(item => item.id),
      hasInheritedFooter: typeof mode.prompts.footer === 'string' && mode.prompts.footer.length > 0,
    }));
  `;
  const result = spawnSync('bun', ['-e', probe], {
    cwd: projectRoot,
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  const lastLine = result.stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(lastLine);
}

describe('ModeManager user modes', () => {
  it('loads an inherited override from the durable data-directory modes folder', () => {
    const dataDir = makeTempDir();
    const modesDir = path.join(dataDir, 'modes');
    mkdirSync(modesDir, { recursive: true });
    writeFileSync(path.join(modesDir, 'code--studio-notes.json'), JSON.stringify({
      name: 'Studio Notes',
      description: 'Architecture studio memory',
      version: '1.0.0',
      observation_types: [
        { id: 'design-decision', label: 'Design Decision', description: 'A durable design choice', emoji: '📐', work_emoji: '✏️' },
      ],
      observation_concepts: [
        { id: 'cost-impact', label: 'Cost Impact', description: 'Affects project cost' },
      ],
      prompts: {
        type_guidance: 'type must be design-decision',
        concept_guidance: 'concepts may include cost-impact',
      },
    }));

    expect(runModeProbe(dataDir, 'code--studio-notes')).toEqual({
      id: 'code--studio-notes',
      name: 'Studio Notes',
      types: ['design-decision'],
      hasInheritedFooter: true,
    });
  });

  it('rejects unsafe mode IDs and falls back to bundled code mode', () => {
    const result = runModeProbe(makeTempDir(), '../code');
    expect(result.id).toBe('code');
    expect(result.types).toContain('bugfix');
  });
});
