import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = import.meta.dir;
const DOCTOR = join(HERE, '..', 'src', 'settings-doctor.mjs');

function run(settings) {
  const tmp = mkdtempSync(join(tmpdir(), 'cm-sd-'));
  const path = join(tmp, 'settings.json');
  writeFileSync(path, JSON.stringify(settings, null, 2));
  const r = spawnSync('bun', [DOCTOR, path], { encoding: 'utf-8' });
  rmSync(tmp, { recursive: true, force: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('flags WORKER_HOST=0.0.0.0 as P0', () => {
  const r = run({ CLAUDE_MEM_WORKER_HOST: '0.0.0.0' });
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/\[P0\] CLAUDE_MEM_WORKER_HOST/);
});

test('flags ALLOW_LOCAL_DEV_BYPASS as P0', () => {
  const r = run({ CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS: 'true' });
  expect(r.out).toMatch(/\[P0\] CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS/);
});

test('flags Telegram enabled+empty as P1', () => {
  const r = run({ CLAUDE_MEM_TELEGRAM_ENABLED: 'true', CLAUDE_MEM_TELEGRAM_BOT_TOKEN: '' });
  expect(r.out).toMatch(/\[P1\] CLAUDE_MEM_TELEGRAM_ENABLED/);
});

test('flags Chroma noise as P1', () => {
  const r = run({
    CLAUDE_MEM_CHROMA_ENABLED: 'false', CLAUDE_MEM_CHROMA_HOST: 'localhost',
    CLAUDE_MEM_CHROMA_PORT: '8000', CLAUDE_MEM_CHROMA_TENANT: 'x', CLAUDE_MEM_CHROMA_DATABASE: 'y',
  });
  expect(r.out).toMatch(/\[P1\] CLAUDE_MEM_CHROMA_\*/);
});

test('flags Python+FolderClaudemd as P2', () => {
  const r = run({ CLAUDE_MEM_PYTHON_VERSION: '3.13', CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'false' });
  expect(r.out).toMatch(/\[P2\] CLAUDE_MEM_PYTHON_VERSION/);
  expect(r.out).toMatch(/\[P2\] CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED/);
});

test('clean settings yield no issues', () => {
  const r = run({ CLAUDE_MEM_WORKER_HOST: '127.0.0.1' });
  expect(r.out).toMatch(/no issues found/);
});
