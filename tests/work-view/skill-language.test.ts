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
  it('request-progress decides the language once and hands it to the review subagents', () => {
    const text = skill('request-progress');
    expect(text).toMatch(OWNER_LANGUAGE);
    expect(text).toContain('Decide that language once');
    const review = section(text, '## 2. Review', '## 3.');
    expect(review).toContain('fill in the CLI path, the groups and the owner\'s language');
    expect(review).toMatch(/^> .*in <owner's language>/m);
  });

  it('request-progress keeps the wording My Rules and open requests key on', () => {
    const text = skill('request-progress');
    // My Rules ids hash the preference text, so a translated statement would
    // detach the owner's decision from it.
    expect(text).toContain('every preference statement carried over from the previous story');
    expect(section(text, '## 4. Write the build story', '```bash'))
      .toContain('Preference statements carried over from the previous story keep their wording');
  });

  it('owner-goals states the rule, hands it to the map subagent and keeps kept rules as written', () => {
    const text = skill('owner-goals');
    expect(text).toMatch(OWNER_LANGUAGE);
    expect(section(text, '## 2. Build the map', '## Or update')).toMatch(/^> .*human language most of these prompts are written in/m);
    expect(section(text, '## Or update', '## 3.')).toContain('keep each kept rule\'s `when` and `then` exactly as they were');
  });
});
