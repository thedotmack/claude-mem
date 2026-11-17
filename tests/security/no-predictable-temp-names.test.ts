// A temp file named `<target>.<pid>.tmp` can be predicted and pre-planted as a
// symlink by anyone who can write the directory; a plain write then follows
// the link and clobbers its target, while the rename only replaces the link.
// Every hand-written atomic writer uses a random name opened with 'wx' (#5145,
// #6193, #6198). This guard keeps a new pid-named temp from coming back.
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

const PREDICTABLE_TEMP_NAME = /\$\{process\.pid\}(?:\.shared)?\.tmp/;

// Reviewed exceptions, each with its reason.
const ALLOWED = new Map([
  // Writes into the launcher's own bin directory during install and is
  // exclusive-created there; it is not a data-directory writer.
  ['src/launcher/install-launcher.ts', 'install-time launcher build output'],
]);

// Generated from src/ at release (scripts/build-hooks.js), so it is fixed by
// fixing its source, which this scan covers.
const GENERATED = new Set(['plugin/skills/request-progress/scripts/request-groups.mjs']);

function walk(directory: string, extensions: string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, extensions));
    else if (extensions.some(extension => entry.name.endsWith(extension))) files.push(full);
  }
  return files;
}

describe('no predictable temp names', () => {
  it('no writer names its temp file after the process id', () => {
    const files = [
      ...walk(join(REPO_ROOT, 'src'), ['.ts', '.mjs']),
      ...walk(join(REPO_ROOT, 'cowork', 'scripts'), ['.mjs']),
      ...walk(join(REPO_ROOT, 'plugin', 'skills'), ['.mjs']),
    ];
    const hits: string[] = [];
    for (const file of files) {
      const path = relative(REPO_ROOT, file).split(sep).join('/');
      if (ALLOWED.has(path) || GENERATED.has(path)) continue;
      readFileSync(file, 'utf-8').split('\n').forEach((line, index) => {
        if (PREDICTABLE_TEMP_NAME.test(line)) hits.push(`${path}:${index + 1}`);
      });
    }
    expect(files.length).toBeGreaterThan(100);
    expect(hits).toEqual([]);
  });
});
