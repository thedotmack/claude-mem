import { describe, it, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  FIRST_PARTY_SKILL_IDS,
  classifySkillId,
  skillNameFromToolInput,
  firstPartySkillFromSlashPrompt,
} from '../../src/services/telemetry/skill-id';

const PROJECT_ROOT = join(import.meta.dir, '../..');
const PLUGIN_SKILLS_DIR = join(PROJECT_ROOT, 'plugin/skills');

const MEM_SEARCH_COPIES = [
  'plugin/skills/mem-search/SKILL.md',
  'claude-mem-cursor/skills/mem-search/SKILL.md',
  'cowork/skills/mem-search/SKILL.md',
  'claude-mem-grok-bot/skills/mem-search/SKILL.md',
];

function pluginSkillIdsOnDisk(): string[] {
  return readdirSync(PLUGIN_SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => (
      entry.isDirectory()
      && existsSync(join(PLUGIN_SKILLS_DIR, entry.name, 'SKILL.md'))
    ))
    .map((entry) => entry.name)
    .sort();
}

describe('FIRST_PARTY_SKILL_IDS pinned to plugin/skills/', () => {
  it('matches every plugin/skills/*/SKILL.md directory and no others', () => {
    expect([...FIRST_PARTY_SKILL_IDS].sort()).toEqual(pluginSkillIdsOnDisk());
  });

  it('collapses sibling mem-search copies to one first-party id', () => {
    for (const rel of MEM_SEARCH_COPIES) {
      expect(existsSync(join(PROJECT_ROOT, rel))).toBe(true);
    }
    expect(classifySkillId('mem-search')).toEqual({
      skill_id: 'mem-search',
      skill_source: 'first_party',
    });
    expect(classifySkillId('claude-mem:mem-search')).toEqual({
      skill_id: 'mem-search',
      skill_source: 'first_party',
    });
    expect(classifySkillId('cowork:mem-search')).toEqual({
      skill_id: 'mem-search',
      skill_source: 'first_party',
    });
    expect(classifySkillId('cursor:mem-search')).toEqual({
      skill_id: 'mem-search',
      skill_source: 'first_party',
    });
  });

  it('is a pure helper — no captureEvent, completion, or duration fields', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src/services/telemetry/skill-id.ts'), 'utf8');
    expect(src).not.toContain('captureEvent');
    expect(src).not.toContain('skill_completed');
    expect(src).not.toContain('duration_ms');
  });
});

describe('classifySkillId', () => {
  it('classifies a bare first-party name as first_party', () => {
    expect(classifySkillId('mem-search')).toEqual({
      skill_id: 'mem-search',
      skill_source: 'first_party',
    });
  });

  it('strips a claude-mem: prefix', () => {
    expect(classifySkillId('claude-mem:make-plan')).toEqual({
      skill_id: 'make-plan',
      skill_source: 'first_party',
    });
  });

  it('lowercases and accepts CLAUDE-MEM:DO', () => {
    expect(classifySkillId('CLAUDE-MEM:DO')).toEqual({
      skill_id: 'do',
      skill_source: 'first_party',
    });
  });

  it('never returns a third-party name', () => {
    expect(classifySkillId('someone-else:evil')).toEqual({
      skill_id: 'other',
      skill_source: 'third_party',
    });
    expect(classifySkillId('../../etc/passwd')).toEqual({
      skill_id: 'other',
      skill_source: 'third_party',
    });
    expect(classifySkillId('superpowers')).toEqual({
      skill_id: 'other',
      skill_source: 'third_party',
    });
  });

  it('collapses empty and non-string input to other / third_party', () => {
    expect(classifySkillId('')).toEqual({ skill_id: 'other', skill_source: 'third_party' });
    expect(classifySkillId('   ')).toEqual({ skill_id: 'other', skill_source: 'third_party' });
    expect(classifySkillId(null)).toEqual({ skill_id: 'other', skill_source: 'third_party' });
    expect(classifySkillId({ skill: 'x' })).toEqual({ skill_id: 'other', skill_source: 'third_party' });
  });

  it('never echoes the original string', () => {
    const classified = classifySkillId('Someone-Else:SecretSkill');
    expect(JSON.stringify(classified)).not.toContain('Someone-Else');
    expect(JSON.stringify(classified)).not.toContain('SecretSkill');
    expect(classified.skill_id).toBe('other');
  });
});

describe('skillNameFromToolInput', () => {
  it('reads toolInput.skill only for the Skill tool', () => {
    expect(skillNameFromToolInput('Skill', { skill: 'mem-search', args: '/secret' })).toBe('mem-search');
    expect(skillNameFromToolInput('SlashCommand', { command: '/mem-search' })).toBeUndefined();
    expect(skillNameFromToolInput('Skill', 'not-an-object')).toBeUndefined();
    expect(skillNameFromToolInput('Read', { skill: 'mem-search' })).toBeUndefined();
  });
});

describe('firstPartySkillFromSlashPrompt', () => {
  it('returns the first-party id for a leading /skill token', () => {
    expect(firstPartySkillFromSlashPrompt('/mem-search how did we do auth?')).toBe('mem-search');
    expect(firstPartySkillFromSlashPrompt('/make-plan')).toBe('make-plan');
    expect(firstPartySkillFromSlashPrompt('  /claude-mem:do\nnext line')).toBe('do');
  });

  it('emits nothing (null) for unknown /foo and non-slash prompts', () => {
    expect(firstPartySkillFromSlashPrompt('/foo')).toBeNull();
    expect(firstPartySkillFromSlashPrompt('/someone-else:evil')).toBeNull();
    expect(firstPartySkillFromSlashPrompt('please /mem-search later')).toBeNull();
    expect(firstPartySkillFromSlashPrompt('mem-search')).toBeNull();
    expect(firstPartySkillFromSlashPrompt('')).toBeNull();
    expect(firstPartySkillFromSlashPrompt(null)).toBeNull();
  });

  it('does not treat the rest of the prompt as an id', () => {
    const id = firstPartySkillFromSlashPrompt('/standup secret project /Users/alice/repo');
    expect(id).toBe('standup');
  });
});
