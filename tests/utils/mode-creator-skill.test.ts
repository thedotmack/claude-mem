import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const projectRoot = path.resolve(import.meta.dir, '../..');
const skillDir = path.join(projectRoot, 'plugin/skills/mode-creator');
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-mem-mode-creator-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('mode-creator skill', () => {
  it('ships the purpose-first interview, secure Telegram boundary, restart, and context verification', () => {
    const content = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    expect(content).toContain('Custom modes let you take notes for whatever you\'re working on.');
    expect(content).toContain('Code mode already works well for software work.');
    expect(content).toContain('interactive question tool');
    expect(content).toContain('Never pass the token as an argument.');
    expect(content).toContain('npx claude-mem restart');
    expect(content).toContain('Mode: <mode name> (<mode id>)');
  });

  it('validates, installs, activates, and merges Telegram triggers without losing settings', () => {
    const dataDir = makeTempDir();
    const settingsPath = path.join(dataDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      CLAUDE_MEM_MODE: 'code',
      CLAUDE_MEM_TELEGRAM_ENABLED: 'true',
      CLAUDE_MEM_TELEGRAM_BOT_TOKEN: 'preserve-this-secret',
      CLAUDE_MEM_TELEGRAM_CHAT_ID: '12345',
      CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES: 'security_alert',
      CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS: 'existing-tag',
      UNRELATED_SETTING: 'preserved',
    }));
    const draftPath = path.join(dataDir, 'draft.json');
    const draft = {
      name: 'Architecture Practice',
      description: 'Architecture project memory',
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
    };
    writeFileSync(draftPath, JSON.stringify(draft));

    const result = spawnSync('node', [
      path.join(skillDir, 'scripts/install-mode.mjs'),
      '--mode', draftPath,
      '--mode-id', 'code--architecture-practice',
      '--telegram-types', 'design-decision',
      '--telegram-concepts', 'cost-impact',
    ], {
      cwd: projectRoot,
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);

    const installed = JSON.parse(readFileSync(path.join(dataDir, 'modes/code--architecture-practice.json'), 'utf8'));
    expect(installed).toEqual(draft);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(settings.CLAUDE_MEM_MODE).toBe('code--architecture-practice');
    expect(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_TYPES.split(',')).toEqual(['security_alert', 'design-decision']);
    expect(settings.CLAUDE_MEM_TELEGRAM_TRIGGER_CONCEPTS.split(',')).toEqual(['existing-tag', 'cost-impact']);
    expect(settings.CLAUDE_MEM_TELEGRAM_BOT_TOKEN).toBe('preserve-this-secret');
    expect(settings.UNRELATED_SETTING).toBe('preserved');
    // The settings write goes through a random, exclusively created temp name
    // (see configure-telegram.mjs), so nothing is left behind beside it.
    expect(readdirSync(dataDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes settings through an exclusive random temp name, like its hardened sibling', () => {
    const installMode = readFileSync(path.join(skillDir, 'scripts/install-mode.mjs'), 'utf8');
    const configureTelegram = readFileSync(path.join(skillDir, 'scripts/configure-telegram.mjs'), 'utf8');
    // Both writers carry full settings, including the bot token, so both must
    // create their temp exclusively: a predictable name can be pre-planted as
    // a symlink and a following write lands on the link's target (#5145).
    for (const source of [installMode, configureTelegram]) {
      expect(source).toContain("flag: 'wx'");
      expect(source).not.toContain('${process.pid}.tmp');
    }
    expect(configureTelegram).toContain('pre-planted as a symlink');
  });

  it('refuses to shadow a bundled mode ID', () => {
    const dataDir = makeTempDir();
    const draftPath = path.join(dataDir, 'draft.json');
    writeFileSync(draftPath, readFileSync(path.join(projectRoot, 'plugin/modes/code.json')));

    const result = spawnSync('node', [
      path.join(skillDir, 'scripts/install-mode.mjs'),
      '--mode', draftPath,
      '--mode-id', 'code',
    ], {
      cwd: projectRoot,
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('collides with bundled mode');
  });
});
