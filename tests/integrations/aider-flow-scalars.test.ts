import { describe, expect, test } from 'bun:test';
import {
  AIDER_MANAGED_ENTRY_COMMENT,
  hasAiderReadEntry,
  removeAiderReadEntry,
  upsertAiderReadEntry,
} from '../../src/services/integrations/AiderInstaller.js';
import { AIDER_MEMORY_RELATIVE_PATH } from '../../src/shared/aider-paths.js';

const memory = AIDER_MEMORY_RELATIVE_PATH;

describe('Aider flow-list file paths', () => {
  for (const [name, scalar, value] of [
    ['plain apostrophe', "docs/user's-guide.md", "docs/user's-guide.md"],
    ['plain embedded quote', 'docs/user"guide.md', 'docs/user"guide.md'],
    ['quoted brackets', "'docs/[team], notes.md'", 'docs/[team], notes.md'],
    ['escaped double quotes', String.raw`"docs/team \"blue, green\".md"`, 'docs/team "blue, green".md'],
    ['doubled single quote', "'docs/it''s, [shared].md'", "docs/it's, [shared].md"],
    ['quoted comma control', '"docs/team, notes.md"', 'docs/team, notes.md'],
  ]) {
    test(`preserves a ${name} through install and uninstall`, () => {
      const original = `read: [${scalar}, NOTES.md] # [shared docs]\nmodel: local\n`;
      const installed = upsertAiderReadEntry(original, memory);
      expect(installed).toBe(
        `read: [${scalar}, NOTES.md, ${memory}] # [shared docs] ${AIDER_MANAGED_ENTRY_COMMENT}\nmodel: local\n`,
      );
      expect(hasAiderReadEntry(installed, value!)).toBe(true);
      expect(hasAiderReadEntry(installed, memory)).toBe(true);
      expect(upsertAiderReadEntry(installed, memory)).toBe(installed);

      const removed = removeAiderReadEntry(installed, memory)!;
      expect(hasAiderReadEntry(removed, value!)).toBe(true);
      expect(hasAiderReadEntry(removed, 'NOTES.md')).toBe(true);
      expect(hasAiderReadEntry(removed, memory)).toBe(false);
      expect(removed).toEndWith('] # [shared docs]\nmodel: local\n');
    });
  }

  test.each([
    'read: [[nested.md], NOTES.md]\n',
    'read: [docs/[team].md, NOTES.md]\n',
    'read: ["unterminated.md, NOTES.md]\n',
    String.raw`read: ["docs/\x5bteam].md", NOTES.md]` + '\n',
  ])('still refuses unsupported or unclosed flow syntax: %s', original => {
    expect(() => upsertAiderReadEntry(original, memory)).toThrow(/flow list/);
  });
});
