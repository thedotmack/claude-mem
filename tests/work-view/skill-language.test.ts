import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// My Work shows what these skills write. Their subagents see only the task the
// skill quotes for them, so the language rule has to sit in those tasks too.
const skill = (name: string) =>
  readFileSync(join(import.meta.dir, '../../plugin/skills', name, 'SKILL.md'), 'utf8');
const section = (text: string, from: string, to: string) => {
  const start = text.indexOf(from);
  return text.slice(start, text.indexOf(to, start + from.length));
};
const OWNER_LANGUAGE = /human language most of the owner's (asks|prompts) are written in/;

describe('My Work skills write in the owner\'s language', () => {
  it('request-progress states the rule, hands it to the review subagents and applies it to the story', () => {
    const text = skill('request-progress');
    expect(text).toMatch(OWNER_LANGUAGE);
    expect(section(text, '## 2. Review', '## 3.')).toMatch(/^> .*human language most of the owner's asks in `show`/m);
    expect(section(text, '## 4. Write the build story', '```bash')).toContain('previous story is in another language');
  });

  it('owner-goals states the rule and hands it to the map subagent', () => {
    const text = skill('owner-goals');
    expect(text).toMatch(OWNER_LANGUAGE);
    expect(section(text, '## 2. Build the map', '## Or update')).toMatch(/^> .*human language most of these prompts are written in/m);
  });
});
