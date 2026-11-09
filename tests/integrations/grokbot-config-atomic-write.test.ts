import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { installGrokBotIntegration } from '../../src/services/integrations/GrokBotInstaller.js';

// The transcript-watch config is shared with every other watcher the user runs,
// so the Grok Bot install must not rewrite it in place: an interrupted install
// would leave a half-written config that stops every watcher. A temp-file-plus-
// rename write yields a new file; an in-place truncate keeps the same one.
describe('Grok Bot writes its transcript config atomically', () => {
  let tmp: string;
  let configPath: string;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'grokbot-atomic-'));
    configPath = path.join(tmp, 'transcript-watch.json');
    logSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('replaces the config instead of truncating it in place', () => {
    writeFileSync(configPath, JSON.stringify({ watches: [], schemas: {} }, null, 2) + '\n');
    const first = statSync(configPath);

    expect(installGrokBotIntegration(configPath, tmp)).toBe(0);
    const second = statSync(configPath);

    // Either signal proves the file was replaced, not rewritten: a fresh inode
    // on POSIX, or a new creation time where the filesystem reports one.
    expect(second.ino !== first.ino || second.birthtimeMs !== first.birthtimeMs).toBe(true);
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(parsed.watches.some((watch: { name?: string }) => watch.name === 'grok-bot')).toBe(true);
    expect(parsed.schemas['grok-bot']).toBeDefined();
  });
});