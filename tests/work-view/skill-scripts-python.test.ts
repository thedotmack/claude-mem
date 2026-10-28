import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePythonCommand } from '../../src/services/work-view/python.js';
import { buildRules } from '../../src/services/work-view/my-rules.mjs';
import { fakeOwnerGoalsWorker } from '../helpers/fake-owner-goals-worker.js';
import { scratchDir } from '../helpers/scratch-dir.js';

const SKILLS = join(import.meta.dir, '..', '..', 'plugin', 'skills');
const python = await resolvePythonCommand();
const spawnPython = (args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => Bun.spawnSync([python.command, ...python.args, ...args], { ...options, env: { ...process.env, ...options.env, PYTHONUTF8: '1' } });

// Skill scripts run on the user's Python 3, which can be 3.9-3.11.
// Those versions reject a backslash inside an f-string expression; 3.12+ accepts it,
// so on a newer interpreter the tokenizer is used to find the same construct.
const CHECK = String.raw`
import sys, tokenize
path = sys.argv[1]
if sys.version_info < (3, 12):
    compile(open(path, encoding="utf-8").read(), path, "exec")
    sys.exit(0)
depth = 0
with open(path, "rb") as handle:
    for token in tokenize.tokenize(handle.readline):
        if token.type == tokenize.FSTRING_START: depth += 1
        elif token.type == tokenize.FSTRING_END: depth -= 1
        elif depth and token.type != tokenize.FSTRING_MIDDLE and "\\" in token.string:
            print(f"{path}:{token.start[0]}: backslash in an f-string expression")
            sys.exit(1)
`;

function pythonScripts(): string[] {
  return readdirSync(SKILLS, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.py'))
    .map((file) => join(SKILLS, file));
}

describe('skill Python scripts', () => {
  it('finds the scripts to check', () => {
    expect(pythonScripts().some((file) => file.endsWith('save_goals.py'))).toBe(true);
  });

  for (const script of pythonScripts()) {
    it(`parses on Python 3.9-3.11: ${script.slice(SKILLS.length + 1)}`, () => {
      const result = spawnPython(['-c', CHECK, script]);
      expect(result.stdout.toString() + result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
    });
  }
});

describe('save_goals.py', () => {
  it('validates UTF-8 quotes and titles on every platform', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-goals-utf8-'));
    try {
      writeFileSync(join(dir, 'owner-prompts.md'), '# Owner prompts\n\n## 2026-10-20 10:00 · claude · repo\nsession `a`\n\nİstanbul 🚀\n');
      writeFileSync(join(dir, 'goals.json'), JSON.stringify({ focus_areas: [{ rank: 1, title: 'İstanbul 🚀', goal: 'Gezi.', matches: null, evidence: [{ at: '2026-10-20 10:00', quote: 'İstanbul 🚀' }] }] }));
      const result = spawnPython([join(SKILLS, 'owner-goals', 'scripts', 'save_goals.py'), '--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--dry-run']);
      expect(result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString()).writes[1]).toMatchObject({ title: 'İstanbul 🚀', evidence: '2026-10-20 10:00 | İstanbul 🚀' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('drops quotes that aged out of the prompts window, and items left without one, but still refuses invented quotes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-goals-'));
    try {
      writeFileSync(join(dir, 'owner-prompts.md'), '# Owner prompts\n\n## 2026-10-20 10:00 · claude · repo\nsession `a`\n\nship the cards today\n');
      const save = (goals: unknown) => {
        writeFileSync(join(dir, 'goals.json'), JSON.stringify(goals));
        return spawnPython([join(SKILLS, 'owner-goals', 'scripts', 'save_goals.py'), '--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--dry-run']);
      };
      const result = save({ asks: [
        { rank: 1, title: 'Cards', focus_area: null, evidence: [{ at: '2026-10-20 10:00', quote: 'ship the cards' }, { at: '2026-09-01 09:00', quote: 'aged out' }] },
        { rank: 2, title: 'Old', focus_area: null, evidence: [{ at: '2026-09-02 09:00', quote: 'older words' }] },
      ] });
      expect(result.exitCode).toBe(0);
      const writes = JSON.parse(result.stdout.toString()).writes;
      expect(writes.slice(1).map((write: { task: string; evidence: string }) => [write.task, write.evidence])).toEqual([['Ask: Cards', '2026-10-20 10:00 | ship the cards']]);
      expect(save({ asks: [{ title: 'Made up', focus_area: null, evidence: [{ at: '2026-10-20 10:00', quote: 'never typed' }] }] }).exitCode).not.toBe(0);
      // Invented quotes are refused on rules and focus areas too.
      expect(save({ rules: [{ when: '', then: 'Ship daily.', evidence: [{ at: '2026-10-20 10:00', quote: 'never typed' }] }] }).exitCode).not.toBe(0);
      expect(save({ focus_areas: [{ title: 'Cards', goal: 'The cards.', matches: null, evidence: [{ at: '2026-10-20 10:00', quote: 'never typed' }] }] }).exitCode).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('clears the goals when every saved quote has aged out, instead of refusing to save forever', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-goals-'));
    try {
      const save = (prompts: string, goals: unknown) => {
        writeFileSync(join(dir, 'owner-prompts.md'), prompts);
        writeFileSync(join(dir, 'goals.json'), JSON.stringify(goals));
        return spawnPython([join(SKILLS, 'owner-goals', 'scripts', 'save_goals.py'), '--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--dry-run']);
      };
      const aged = { generated_at: '2026-10-20T10:00:00Z', focus_areas: [{ rank: 1, title: 'Old', goal: 'Old work.', matches: null, evidence: [{ at: '2026-09-02 09:00', quote: 'older words' }] }] };
      // Newer prompts exist, but none was quoted: the saved goal's only quote is older than the window.
      const later = save('# Owner prompts\n\n## 2026-10-20 10:00 · claude · repo\nsession `a`\n\nunrelated words\n', aged);
      expect(later.stderr.toString()).toBe('');
      expect(later.exitCode).toBe(0);
      const output = JSON.parse(later.stdout.toString());
      expect(output.writes).toHaveLength(1);
      expect(output.writes[0]).toMatchObject({ generated_at: '2026-10-20T10:00:00Z', status: 'open' });
      // No prompts in the window at all: every quote is outside it.
      expect(save('# Owner prompts\n', aged).exitCode).toBe(0);
      expect(save('# Owner prompts\n', { focus_areas: [], asks: [], rules: [] }).exitCode).toBe(0);
      // An answer with no goals at all, while prompts exist, is still refused.
      expect(save('# Owner prompts\n\n## 2026-10-20 10:00 · claude · repo\nsession `a`\n\nunrelated words\n', { focus_areas: [], asks: [], rules: [] }).exitCode).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('drops a carried-forward quote that no longer matches, but still refuses a new one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'save-goals-'));
    try {
      writeFileSync(join(dir, 'owner-prompts.md'), '# Owner prompts\n\n## 2026-10-20 10:00 · claude · repo\nsession `a`\n\nship the cards  today\n\n---\n\n## 2026-10-21 09:00 · claude · repo\nsession `a`\n\nfix the login\n');
      const save = (goals: unknown) => {
        writeFileSync(join(dir, 'goals.json'), JSON.stringify(goals));
        return spawnPython([join(SKILLS, 'owner-goals', 'scripts', 'save_goals.py'), '--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--carried-before', '2026-10-21 00:00', '--dry-run']);
      };
      // Saved before the export stripped <private>: the quote held the private words.
      const result = save({ asks: [
        { rank: 1, title: 'Cards', focus_area: null, evidence: [{ at: '2026-10-20 10:00', quote: 'ship the cards key sk-123 today' }] },
        { rank: 2, title: 'Login', focus_area: null, evidence: [{ at: '2026-10-21 09:00', quote: 'fix the login' }] },
      ] });
      expect(result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString()).writes.slice(1).map((write: { task: string }) => write.task)).toEqual(['Ask: Login']);
      expect(save({ asks: [{ title: 'Made up', focus_area: null, evidence: [{ at: '2026-10-21 09:00', quote: 'never typed' }] }] }).exitCode).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('save_goals.py: focus areas, asks and rules', () => {
  const PROMPTS = '# Owner prompts\n\n## 2026-10-20 10:00 · claude · repo\nsession `a`\n\nship the viewer cards and keep it live\n\n---\n\n## 2026-10-21 09:00 · claude · repo\nsession `a`\n\nnever make me publish anything myself\n';
  const quote = (at: string, words: string) => [{ at, quote: words }];
  const answer = {
    generated_at: '2026-10-21T09:30:00-07:00', human_summary: 'Viewer work.',
    focus_areas: [{ rank: 1, title: 'Viewer', goal: 'A live view of my work.', matches: null, latest_at: '2026-10-20 10:00', times_asked: 2, evidence: quote('2026-10-20 10:00', 'keep it live') }],
    asks: [{ rank: 1, title: 'Viewer cards', focus_area: 'Viewer', latest_at: '2026-10-20 10:00', times_asked: 1, evidence: quote('2026-10-20 10:00', 'ship the viewer cards') }],
    rules: [{ when: 'work is approved', then: 'Carry it through release without the owner publishing.', latest_at: '2026-10-21 09:00', times_asked: 1, evidence: quote('2026-10-21 09:00', 'never make me publish anything myself') }],
  };
  const withDir = async (work: (dir: string) => Promise<void> | void) => {
    const dir = scratchDir('save-goals-kinds');
    try { writeFileSync(join(dir, 'owner-prompts.md'), PROMPTS); await work(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  const dryRun = (dir: string, goals: unknown) => {
    writeFileSync(join(dir, 'goals.json'), JSON.stringify(goals));
    return spawnPython([join(SKILLS, 'owner-goals', 'scripts', 'save_goals.py'), '--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--dry-run']);
  };

  it('writes goal_kind focus-area and ask only, and hands rules to My Rules instead of owner-goals', () => withDir((dir) => {
    const result = dryRun(dir, answer);
    expect(result.stderr.toString()).toBe('');
    const output = JSON.parse(result.stdout.toString());
    expect(output.writes.slice(1).map((write: Record<string, unknown>) => [write.task, write.goal_kind])).toEqual([['Focus area: Viewer', 'focus-area'], ['Ask: Viewer cards', 'ask']]);
    expect(output.writes[1]).toMatchObject({ goal: 'A live view of my work.' });
    expect(output.writes[2]).toMatchObject({ focus_area: 'Viewer' });
    expect(output.focus_areas).toEqual({ areas: [{ name: 'Viewer', goal: 'A live view of my work.', rank: 1, matches: null, evidence: 'From your prompts: asked 2 times, latest 2026-10-20 10:00.' }] });
    expect(output.rules).toMatchObject([{ preference: 'Carry it through release without the owner publishing.', when: 'work is approved', source: 'owner-goals', quotes: [{ quote: 'never make me publish anything myself' }] }]);
  }));

  it('refuses the old priorities shape, an area without matches or goal, and an ask under an area the answer does not have', () => withDir((dir) => {
    const refused = (goals: unknown, reason: string) => {
      const result = dryRun(dir, goals);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(reason);
    };
    refused({ priorities: answer.focus_areas, open_asks: [] }, 'the old shape');
    refused({ ...answer, focus_areas: [{ ...answer.focus_areas[0], matches: undefined }] }, '"matches" must be');
    refused({ ...answer, focus_areas: [{ ...answer.focus_areas[0], goal: '' }] }, 'one-sentence "goal"');
    refused({ ...answer, asks: [{ ...answer.asks[0], focus_area: 'Releases' }] }, "focus_area 'Releases' is not a title");
    refused({ ...answer, rules: [{ ...answer.rules[0], then: 'x'.repeat(201) }] }, 'a "then" of 1-200');
  }));

  it('saves: a new area as a My Focus suggestion, asks under its id, and rules as My Rules suggestions beside the story\'s own', () => withDir(async (dir) => {
    const worker = fakeOwnerGoalsWorker(join(dir, 'data'));
    try {
      const ledgerDir = join(dir, 'ledger');
      mkdirSync(ledgerDir);
      const storyOwn = { preference: 'Keep the existing design.', kind: 'directive', supportCount: 2, quotes: [] };
      writeFileSync(join(ledgerDir, 'story.json'), JSON.stringify({ narrative: 'The story.', writtenAt: '2026-10-20T00:00:00Z', preferences: [storyOwn, { preference: 'An old owner-goals rule.', source: 'owner-goals', quotes: [] }] }));
      writeFileSync(join(dir, 'goals.json'), JSON.stringify(answer));
      const result = await worker.run(['--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--ledger-dir', ledgerDir]);
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      const [area] = worker.focusAreas();
      expect(area).toMatchObject({ name: 'Viewer', goal: 'A live view of my work.', status: 'suggested', source: 'owner-goals', decidedBy: 'system', priorityRank: 1 });
      expect(area.focusAreaId).toMatch(/^fa_[0-9a-f]{12}$/);
      const goals = worker.state().lists.find((list: { name: string }) => list.name === 'owner-goals').tasks;
      expect(goals.map((task: { name: string; fields: Record<string, unknown> }) => [task.name, task.fields.goal_kind, task.fields.focus_area_id]))
        .toEqual([['Focus area: Viewer', 'focus-area', area.focusAreaId], ['Ask: Viewer cards', 'ask', area.focusAreaId]]);
      const story = JSON.parse(readFileSync(join(ledgerDir, 'story.json'), 'utf8'));
      expect(story.narrative).toBe('The story.');
      expect(story.preferences.map((preference: { preference: string }) => preference.preference)).toEqual(['Keep the existing design.', 'Carry it through release without the owner publishing.']);
      // My Rules shows it as a suggested rule with its own when.
      const rules = buildRules({ lists: [] }, { story, progress: {} }).rules;
      expect(rules.find((rule: { then: string }) => rule.then.startsWith('Carry'))).toMatchObject({ when: 'work is approved', status: 'suggested', setBy: 'learned', source: 'owner-goals' });
    } finally { worker.stop(); }
  }));

  it('refuses before writing anything: an oversized ask, an over-long area evidence line, an unknown match', () => withDir(async (dir) => {
    const worker = fakeOwnerGoalsWorker(join(dir, 'data'));
    try {
      const args = ['--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--ledger-dir', join(dir, 'ledger')];
      for (const [goals, reason] of [
        [{ ...answer, asks: [{ ...answer.asks[0], title: 'x'.repeat(241) }] }, 'a title of at most 240'],
        [{ ...answer, focus_areas: [{ ...answer.focus_areas[0], latest_at: 'y'.repeat(300) }] }, 'longer than 300 characters'],
        [{ ...answer, focus_areas: [{ ...answer.focus_areas[0], matches: 'fa_000000000000' }] }, 'not a saved focus area'],
      ] as const) {
        writeFileSync(join(dir, 'goals.json'), JSON.stringify(goals));
        const result = await worker.run(args);
        // Exit 1: a refusal the model can fix, with nothing written.
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(reason);
        expect(worker.rows).toEqual([]);
      }
    } finally { worker.stop(); }
  }));

  it('a failure after the first write exits 3, so the refresh never asks again and writes the areas twice', () => withDir(async (dir) => {
    const worker = fakeOwnerGoalsWorker(join(dir, 'data'), { refuseOwnerGoalsWrites: true });
    try {
      writeFileSync(join(dir, 'goals.json'), JSON.stringify(answer));
      const result = await worker.run(['--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--ledger-dir', join(dir, 'ledger')]);
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain('503');
      expect(worker.focusAreas()).toHaveLength(1);
    } finally { worker.stop(); }
  }));

  it('a match is the model\'s judgment: a saved id adds no area, and an id that is not saved is refused', () => withDir(async (dir) => {
    const worker = fakeOwnerGoalsWorker(join(dir, 'data'));
    try {
      writeFileSync(join(dir, 'goals.json'), JSON.stringify(answer));
      const args = ['--goals', join(dir, 'goals.json'), '--prompts', join(dir, 'owner-prompts.md'), '--ledger-dir', join(dir, 'ledger')];
      expect((await worker.run(args)).exitCode).toBe(0);
      const [saved] = worker.focusAreas();
      worker.ownerDecides(saved, { name: 'My viewer', status: 'kept' });
      writeFileSync(join(dir, 'goals.json'), JSON.stringify({ ...answer, focus_areas: [{ ...answer.focus_areas[0], title: 'Live viewer', matches: saved.focusAreaId, rank: 3 }], asks: [{ ...answer.asks[0], focus_area: 'Live viewer' }] }));
      expect((await worker.run(args)).exitCode).toBe(0);
      expect(worker.focusAreas()).toEqual([expect.objectContaining({ focusAreaId: saved.focusAreaId, name: 'My viewer', status: 'kept', priorityRank: 1 })]);
      writeFileSync(join(dir, 'goals.json'), JSON.stringify({ ...answer, focus_areas: [{ ...answer.focus_areas[0], matches: 'fa_000000000000' }] }));
      const refused = await worker.run(args);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain('fa_000000000000, which is not a saved focus area');
    } finally { worker.stop(); }
  }));
});

describe('export_owner_prompts.py', () => {
  it('leaves text the owner marked private out of the exported prompts', () => {
    const home = mkdtempSync(join(tmpdir(), 'export-owner-home-'));
    try {
      const projectDir = join(home, '.claude', 'projects', '-repo');
      mkdirSync(projectDir, { recursive: true });
      const typed = (uuid: string, text: string) => JSON.stringify({ type: 'user', uuid, sessionId: 'session-1', timestamp: new Date().toISOString(), entrypoint: 'cli', origin: { kind: 'human' }, message: { content: text } });
      writeFileSync(join(projectDir, 'session-1.jsonl'), [
        typed('u1', 'ship the cards <private>key sk-123</private> today · İstanbul 🚀'),
        typed('u2', '<private>only a secret</private>'),
        typed('u3', 'explain how <private> works'),
      ].join('\n') + '\n');
      const out = join(home, 'out');
      const result = spawnPython([join(SKILLS, 'owner-goals', 'scripts', 'export_owner_prompts.py'), '--out', out, '--days', '1'], { env: { ...process.env, HOME: home, USERPROFILE: home } });
      expect(result.exitCode).toBe(0);
      const exported = readFileSync(join(out, 'owner-prompts.md'), 'utf8');
      expect(exported).not.toContain('sk-123');
      expect(exported).not.toContain('only a secret');
      expect(exported).toContain('ship the cards  today · İstanbul 🚀');
      expect(exported).toContain('explain how <private> works');
      expect(JSON.parse(result.stdout.toString().trim().split('\n').pop()!).owner_prompts).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads transcripts from CLAUDE_CONFIG_DIR and dates them in local time across daylight saving', () => {
    const home = mkdtempSync(join(tmpdir(), 'export-owner-home-'));
    try {
      const projectDir = join(home, 'custom-claude', 'projects', '-repo');
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, 'session-1.jsonl'), JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'session-1', timestamp: '2026-07-15T12:00:00.000Z', entrypoint: 'cli', origin: { kind: 'human' }, message: { content: 'summer prompt' } }) + '\n');
      const out = join(home, 'out');
      const result = spawnPython([join(SKILLS, 'owner-goals', 'scripts', 'export_owner_prompts.py'), '--out', out, '--start', '2026-07-14', '--end', '2026-07-16'], {
        env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, 'custom-claude'), TZ: 'America/New_York' },
      });
      expect(result.stderr.toString()).toBe('');
      // 12:00 UTC is 08:00 in New York during daylight saving time (EDT, UTC-4).
      expect(readFileSync(join(out, 'owner-prompts.md'), 'utf8')).toContain('## 2026-07-15 08:00 · claude · -repo');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
