import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parseJsonWithBom } from '../src/shared/atomic-json.js';

// The installer writes to a fixed path under the real home directory, so a filesystem test would
// touch the developer's own Windsurf config. This asserts against the source instead, the same way
// npm-install-windows-hide.test.ts does for its spawn options.
const SOURCE = readFileSync(
  join(import.meta.dir, '../src/services/integrations/WindsurfHooksInstaller.ts'),
  'utf8',
);

describe("WindsurfHooksInstaller reads Windsurf's hooks.json", () => {
  it('never parses that file with a BOM-blind JSON.parse', () => {
    // A hooks.json rewritten by PowerShell 5.1 or a Windows editor carries a UTF-8 BOM. Parsing it
    // with JSON.parse throws, and the catch turns a perfectly valid file into "Corrupt hooks.json,
    // refusing to overwrite" — so install and uninstall both stop on a file that is not corrupt.
    expect(SOURCE).not.toMatch(/JSON\.parse\(\s*readFileSync\(\s*WINDSURF_HOOKS_JSON_PATH/);
  });

  it('uses the shared BOM-tolerant reader for each of the three reads', () => {
    // `[^(]*` rather than `<[^>]*>` so a nested type argument such as
    // `<Partial<WindsurfHooksJson>>` still counts.
    const uses = SOURCE.match(
      /parseJsonWithBom[^(]*\(\s*readFileSync\(\s*WINDSURF_HOOKS_JSON_PATH/g,
    );
    expect(uses?.length).toBe(3);
  });

  it('that reader accepts what JSON.parse rejects', () => {
    const bommed = '﻿' + JSON.stringify({ hooks: { afterFileEdit: [] } });
    expect(() => JSON.parse(bommed)).toThrow();
    expect(parseJsonWithBom<{ hooks: Record<string, unknown> }>(bommed).hooks).toBeDefined();
  });
});
