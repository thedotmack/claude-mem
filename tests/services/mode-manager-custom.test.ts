import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { REQUIRED_PROMPT_KEYS, validateMode } from '../../src/services/domain/mode-validation.js';

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

function bundledMode(modeId = 'code') {
  return JSON.parse(readFileSync(path.join(projectRoot, 'plugin/modes', `${modeId}.json`), 'utf8'));
}

function writeMode(dataDir: string, modeId: string, mode: unknown): string {
  const modesDir = path.join(dataDir, 'modes');
  mkdirSync(modesDir, { recursive: true });
  const modePath = path.join(modesDir, `${modeId}.json`);
  writeFileSync(modePath, JSON.stringify(mode));
  return modePath;
}

function staleCodeMode() {
  const mode = bundledMode();
  mode.name = 'Stale user code';
  mode.prompts = Object.fromEntries(REQUIRED_PROMPT_KEYS.slice(0, 7).map(key => [key, mode.prompts[key]]));
  return mode;
}

function runModeProbe(dataDir: string, modeId: string, options: {
  modesDir?: string;
  packageRoot?: string;
  renderPrompts?: boolean;
  missingPrompt?: string;
} = {}) {
  const probe = `
    import { mock } from 'bun:test';
    const options = ${JSON.stringify(options)};
    if (options.packageRoot) {
      const actualPaths = { ...await import('./src/shared/paths.ts') };
      mock.module('./src/shared/paths.ts', () => ({
        ...actualPaths,
        getPackageRoot: () => options.packageRoot,
      }));
    }
    const { ModeManager } = await import('./src/services/domain/ModeManager.ts');
    const { logger } = await import('./src/utils/logger.ts');
    const { buildInitPrompt, buildContinuationPrompt, buildSummaryPrompt } = await import('./src/sdk/prompts.ts');
    const errors = [];
    logger.error = (...args) => errors.push(args);
    const manager = ModeManager.getInstance();
    try {
      const mode = manager.loadMode(${JSON.stringify(modeId)});
      if (options.missingPrompt) delete mode.prompts[options.missingPrompt];
      const rendered = options.renderPrompts ? [
        buildInitPrompt('fixture', 'fixture-session', 'Inspect the fixture', mode),
        buildContinuationPrompt('Continue the fixture', 2, 'fixture-session', mode),
        buildSummaryPrompt({ id: 1, memory_session_id: 'fixture-session', project: 'fixture',
          user_prompt: 'Inspect the fixture', last_assistant_message: 'Fixture inspected' }, mode),
      ] : [];
      console.log(JSON.stringify({
        mode: {
          id: manager.getActiveModeId(),
          name: mode.name,
          types: mode.observation_types.map(item => item.id),
          hasInheritedFooter: typeof mode.prompts.footer === 'string' && mode.prompts.footer.length > 0,
          prompts: mode.prompts,
        },
        rendered,
        errors,
      }));
    } catch (error) {
      console.log(JSON.stringify({ error: error.message, errors }));
    }
  `;
  const result = spawnSync('bun', ['-e', probe], {
    cwd: projectRoot,
    env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_MODES_DIR: options.modesDir ?? '' },
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  const lastLine = result.stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(lastLine);
}

describe('ModeManager user modes', () => {
  it('loads an inherited override from the durable data-directory modes folder', () => {
    const dataDir = makeTempDir();
    writeMode(dataDir, 'code--studio-notes', {
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
    });

    expect(runModeProbe(dataDir, 'code--studio-notes').mode).toMatchObject({
      id: 'code--studio-notes',
      name: 'Studio Notes',
      types: ['design-decision'],
      hasInheritedFooter: true,
    });
  });

  for (const [modeId, reason] of [['../code', 'Invalid mode ID'], ['code--a--b', 'Invalid mode inheritance']]) {
    it(`logs invalid mode ID ${modeId} and falls back to bundled code`, () => {
      const result = runModeProbe(makeTempDir(), modeId);
      expect(result.mode.id).toBe('code');
      expect(result.mode.types).toContain('bugfix');
      expect(JSON.stringify(result.errors)).toContain(reason);
      expect(JSON.stringify(result.errors)).toContain('falling back');
    });
  }

  it('ignores and logs a stale seven-key user code.json and renders complete bundled prompts', () => {
    const dataDir = makeTempDir();
    const staleMode = staleCodeMode();
    expect(Object.keys(staleMode.prompts)).toHaveLength(7);
    const modePath = writeMode(dataDir, 'code', staleMode);

    const result = runModeProbe(dataDir, 'code', { renderPrompts: true });
    expect(result.error).toBeUndefined();
    expect(result.mode.prompts).toEqual(bundledMode().prompts);
    expect(JSON.stringify(result.errors)).toContain(modePath);
    expect(JSON.stringify(result.errors)).toContain('code--');
    expect(result.rendered).toHaveLength(3);
    for (const prompt of result.rendered) expect(prompt).not.toContain('undefined');
  });

  it('merges a user override onto bundled code even when a user code.json exists', () => {
    const dataDir = makeTempDir();
    const shadowPath = writeMode(dataDir, 'code', staleCodeMode());
    writeMode(dataDir, 'code--studio', { name: 'Studio', prompts: { footer: 'Studio footer' } });

    const result = runModeProbe(dataDir, 'code--studio');
    expect(result.mode.name).toBe('Studio');
    expect(result.mode.prompts).toEqual({ ...bundledMode().prompts, footer: 'Studio footer' });
    expect(JSON.stringify(result.errors)).toContain(shadowPath);
  });

  it('protects bundled override IDs from same-named user files', () => {
    const dataDir = makeTempDir();
    const shadowPath = writeMode(dataDir, 'code--chill', { name: 'Shadowed chill' });

    const result = runModeProbe(dataDir, 'code--chill');
    expect(result.error).toBeUndefined();
    expect(result.mode.name).toBe(bundledMode('code--chill').name);
    expect(JSON.stringify(result.errors)).toContain(shadowPath);
  });

  for (const useUserDir of [false, true]) {
    it(`permits an explicit ${useUserDir ? 'user' : 'separate'} modes directory to override a bundled ID`, () => {
      const dataDir = makeTempDir();
      const explicitDir = useUserDir ? dataDir : makeTempDir();
      const mode = bundledMode();
      mode.name = 'Explicit code';
      const modePath = writeMode(explicitDir, 'code', mode);

      const result = runModeProbe(dataDir, 'code', { modesDir: path.dirname(modePath) });
      expect(result.error).toBeUndefined();
      expect(result.mode.name).toBe('Explicit code');
      expect(JSON.stringify(result.errors)).not.toContain('Ignoring');
    });
  }

  it('throws with the path and missing keys for an incomplete custom mode', () => {
    const dataDir = makeTempDir();
    const mode = bundledMode();
    delete mode.prompts.summary_instruction;
    delete mode.prompts.footer;
    const modePath = writeMode(dataDir, 'custom', mode);

    const result = runModeProbe(dataDir, 'custom');
    expect(result.mode).toBeUndefined();
    expect(result.error).toContain(modePath);
    expect(result.error).toContain('prompts.summary_instruction');
    expect(result.error).toContain('prompts.footer');
    expect(JSON.stringify(result.errors)).toContain('prompts.summary_instruction');
  });

  it('validates explicit modes-directory files too', () => {
    const dataDir = makeTempDir();
    const modePath = writeMode(makeTempDir(), 'code', staleCodeMode());
    const result = runModeProbe(dataDir, 'code', { modesDir: path.dirname(modePath) });
    expect(result.mode).toBeUndefined();
    expect(result.error).toContain(modePath);
    expect(result.error).toContain('prompts.summary_instruction');
  });

  it('throws with both source paths when an override removes a required prompt', () => {
    const dataDir = makeTempDir();
    const overridePath = writeMode(dataDir, 'code--broken', { prompts: { summary_instruction: null } });
    const result = runModeProbe(dataDir, 'code--broken');
    expect(result.mode).toBeUndefined();
    expect(result.error).toContain(path.join(projectRoot, 'plugin/modes/code.json'));
    expect(result.error).toContain(overridePath);
    expect(result.error).toContain('prompts.summary_instruction');
  });

  it('validates an incomplete custom parent after merging its override', () => {
    const dataDir = makeTempDir();
    const parent = bundledMode();
    delete parent.prompts.summary_instruction;
    const parentPath = writeMode(dataDir, 'custom', parent);
    const overridePath = writeMode(dataDir, 'custom--fixed', { name: 'Custom override' });

    const incomplete = runModeProbe(dataDir, 'custom--fixed');
    expect(incomplete.error).toContain(parentPath);
    expect(incomplete.error).toContain(overridePath);
    expect(incomplete.error).toContain('prompts.summary_instruction');

    writeMode(dataDir, 'custom--fixed', { prompts: { summary_instruction: 'Restored summary instruction' } });
    const complete = runModeProbe(dataDir, 'custom--fixed');
    expect(complete.error).toBeUndefined();
    expect(complete.mode.id).toBe('custom--fixed');
    expect(complete.mode.prompts.summary_instruction).toBe('Restored summary instruction');
  });

  it('logs a missing-mode fallback reason and uses bundled code despite explicit and user code files', () => {
    const dataDir = makeTempDir();
    writeMode(dataDir, 'code', staleCodeMode());
    const explicitPath = writeMode(makeTempDir(), 'code', staleCodeMode());

    const result = runModeProbe(dataDir, 'missing', { modesDir: path.dirname(explicitPath) });
    expect(result.mode.id).toBe('code');
    expect(result.mode.prompts).toEqual(bundledMode().prompts);
    expect(JSON.stringify(result.errors)).toContain('not found');
    expect(JSON.stringify(result.errors)).toContain('missing');
    expect(JSON.stringify(result.errors)).toContain('falling back');
  });

  it('reports a parse error accurately and refuses to run the malformed mode', () => {
    const dataDir = makeTempDir();
    const modePath = writeMode(dataDir, 'malformed', {});
    writeFileSync(modePath, '{broken');

    const result = runModeProbe(dataDir, 'malformed');
    expect(result.mode).toBeUndefined();
    expect(result.error).toContain(modePath);
    expect(JSON.stringify(result.errors)).toContain(modePath);
    expect(JSON.stringify(result.errors)).not.toContain('not found');
  });

  it('throws if bundled code is invalid when falling back', () => {
    const dataDir = makeTempDir();
    const packageRoot = path.join(makeTempDir(), 'plugin');
    const modePath = writeMode(packageRoot, 'code', staleCodeMode());

    const result = runModeProbe(dataDir, 'missing', { packageRoot });
    expect(result.mode).toBeUndefined();
    expect(result.error).toContain(modePath);
    expect(result.error).toContain('prompts.summary_instruction');
    expect(JSON.stringify(result.errors)).toContain('missing');
  });

  for (const key of REQUIRED_PROMPT_KEYS) {
    it(`throws explicitly if a prompt builder receives missing ${key}`, () => {
      const result = runModeProbe(makeTempDir(), 'code', { renderPrompts: true, missingPrompt: key });
      expect(result.error).toBe(`Mode "code" is missing prompt "${key}"`);
    });
  }
});

describe('mode content validation', () => {
  it('lets the installer inherit bundled code despite a stale user code.json', () => {
    const dataDir = makeTempDir();
    writeMode(dataDir, 'code', staleCodeMode());
    const draftPath = writeMode(dataDir, 'code--installer-test', { name: 'Installer test' });
    const result = spawnSync('node', [
      path.join(projectRoot, 'plugin/skills/mode-creator/scripts/install-mode.mjs'),
      '--mode', draftPath, '--dry-run',
    ], {
      cwd: projectRoot,
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).modeId).toBe('code--installer-test');
  });

  it('keeps the standalone installer prompt list in sync with the domain list', () => {
    const installer = readFileSync(path.join(projectRoot, 'plugin/skills/mode-creator/scripts/install-mode.mjs'), 'utf8');
    const requiredPrompts = installer.match(/const REQUIRED_PROMPTS = \[([\s\S]*?)\];/);
    expect(requiredPrompts).not.toBeNull();
    const installerKeys = [...requiredPrompts![1].matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect([...REQUIRED_PROMPT_KEYS].sort()).toEqual(installerKeys.sort());
  });

  it('accepts the bundled mode and its intentionally empty format examples', () => {
    const mode = bundledMode();
    mode.prompts.format_examples = '';
    expect(validateMode(mode)).toEqual([]);
  });

  it('reports missing observation collections and item fields', () => {
    const mode = bundledMode();
    mode.observation_types = [];
    mode.observation_concepts = [{ id: 'custom' }];
    const missing = validateMode(mode).join('\n');
    expect(missing).toContain('observation_types');
    expect(missing).toContain('observation_concepts[0].label');
    expect(missing).toContain('observation_concepts[0].description');
  });

  it('rejects invalid or duplicate item IDs and guidance that omits them', () => {
    const mode = bundledMode();
    mode.observation_types[0].id = 'Invalid ID';
    mode.observation_concepts.push({ ...mode.observation_concepts[0] });
    mode.prompts.type_guidance = 'No supported types';
    mode.prompts.concept_guidance = 'No supported concepts';
    const missing = validateMode(mode).join('\n');
    expect(missing).toContain('observation_types[0].id');
    expect(missing).toContain('duplicate');
    expect(missing).toContain('type_guidance');
    expect(missing).toContain('concept_guidance');
  });
});
