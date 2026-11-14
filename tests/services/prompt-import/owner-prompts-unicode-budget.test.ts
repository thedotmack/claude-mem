import { afterEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OwnerPrompt } from '../../../src/services/prompt-import/index.js';
import { promptMinute, writeOwnerPromptsFile } from '../../../src/services/prompt-import/owner-prompts-file.js';

const NOW = Date.UTC(2026, 10, 14, 12);
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

const prompt = (text: string, nativePromptId = 'typed-1'): OwnerPrompt => ({
  agent: 'codex', sessionId: 'owner-session', nativePromptId, at: NOW,
  cwd: '/work/release', project: 'release', platformSource: 'codex', text,
});
const omitted = (count: number) => `\n\n[... ${count} more characters, mostly pasted material, trimmed]`;

async function write(text: string, excluded?: string) {
  const folder = mkdtempSync(join(tmpdir(), 'owned-prompt-unicode-'));
  folders.push(folder);
  const result = await writeOwnerPromptsFile({ folder, now: NOW, sinceMinute: promptMinute(NOW),
    scan: async () => ({ agents: [], ownerPrompts: [prompt(text)],
      agentWritten: excluded === undefined ? [] : [prompt(excluded, 'excluded-1')],
      ownerMemoryPromptIds: new Set<number>(), skippedSources: [] }),
  });
  return { folder, result, markdown: result.sections![0].markdown,
    stored: readFileSync(result.path, 'utf8'),
    recent: readFileSync(join(folder, 'new-owner-prompts.md'), 'utf8') };
}

describe('owner prompt character budget', () => {
  for (const [name, text] of [
    ['supplementary characters below the budget', '😀'.repeat(1500) + ' Preserve the complete quote.'],
    ['supplementary characters exactly at the budget', '𐐀'.repeat(3000)],
  ]) {
    it(`keeps ${name} without reporting omitted characters`, async () => {
      const { markdown, stored, recent } = await write(text);
      expect(markdown).toEndWith(`\n\n${text}\n`);
      expect(markdown).not.toContain('mostly pasted material');
      expect(stored).toContain(markdown);
      expect(recent).toContain(markdown);
      expect(stored).not.toContain('\uFFFD');
    });
  }

  it('keeps a supplementary character at the boundary whole', async () => {
    const head = 'a'.repeat(2999) + '😀';
    const { markdown, stored, recent } = await write(head + 'tail');
    expect(markdown).toEndWith(head + omitted(4) + '\n');
    expect(stored).toContain(markdown);
    expect(recent).toContain(markdown);
    expect(stored).not.toContain('\uFFFD');
  });

  it('reports the omitted code-point count for an astral suffix', async () => {
    const head = '😀'.repeat(3000);
    const { markdown } = await write(head + '𐐀🦀中');
    expect(markdown).toEndWith(head + omitted(3) + '\n');
  });

  it('keeps the existing BMP boundary and omitted count', async () => {
    const head = '中'.repeat(3000);
    expect((await write(head + 'end')).markdown).toEndWith(head + omitted(3) + '\n');
  });

  it('counts combining marks individually, matching the Python exporter', async () => {
    const head = 'e\u0301'.repeat(1500);
    expect((await write(head + '😀')).markdown).toEndWith(head + omitted(1) + '\n');
  });

  it('does not apply the owner budget to the excluded-prompt audit file', async () => {
    const text = '😀'.repeat(3001);
    const { folder, result } = await write('short owner prompt', text);
    expect(result).toMatchObject({ ownerPrompts: 1, excludedAgentWritten: 1, newPrompts: 1 });
    const audit = readFileSync(join(folder, 'excluded-agent-written-prompts.md'), 'utf8');
    expect(audit).toEndWith(text + '\n');
    expect(audit).not.toContain('mostly pasted material');
  });

  it('leaves an in-budget owner quote verifiable by the real goals script', async () => {
    const quote = 'Preserve deploy signatures';
    const { result } = await write('😀'.repeat(1500) + ' ' + quote);
    const script = join(import.meta.dir, '../../../plugin/skills/owner-goals/scripts/save_goals.py');
    const problems = execFileSync('python3', ['-c',
      'import json,runpy,sys; script=runpy.run_path(sys.argv[1]); prompts=script["prompts_by_minute"](sys.argv[2]); print(json.dumps(script["unverified_quotes"]({"asks":[{"title":"release","evidence":[{"at":sys.argv[3],"quote":sys.argv[4]}]}]},prompts)))',
      script, result.path, promptMinute(NOW), quote], { encoding: 'utf8' });
    expect(JSON.parse(problems)).toEqual([]);
  });
});
