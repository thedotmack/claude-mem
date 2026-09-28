import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  collectSnapshot,
  KNOWN_AI_TOOL_IDS,
  redactSnapshot,
  scrubErrorSnippet,
} from '../../src/npx-cli/install/snapshot';

// The same fixture file runs against the server's redactor in claude-mem-pro
// (scripts/test-installer-advisor.ts); keep them byte-identical.
const cases = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'installer-snapshot-cases.json'), 'utf-8')) as Array<{
  name: string; input: unknown; expected: unknown;
}>;

describe('redactSnapshot (shared fixtures)', () => {
  for (const c of cases) {
    it(c.name, () => {
      expect(redactSnapshot(c.input)).toEqual(c.expected as never);
    });
  }

  it('is idempotent', () => {
    for (const c of cases) expect(redactSnapshot(redactSnapshot(c.input))).toEqual(redactSnapshot(c.input));
  });

  it('no output value carries a path, @ or whitespace, whatever the input', () => {
    const hostile = ['/etc/passwd', 'C:\\Users\\alex', '~/x', 'a@b.co', 'host:22', 'two words', 'sk-or-v1-0123456789abcdef'];
    for (const value of hostile) {
      const out = redactSnapshot({
        os: { platform: value, release_major: value, arch: value }, shell: value, node: value, npm: value, bun: value, uv: value,
        ai_tools: [{ id: value, version: value }], agent_host: value, claude_mem: { installed_version: value, provider: value },
        install_id: value, shared_by: value,
      });
      const strings = JSON.stringify(out).match(/"[^"]*"/g) ?? [];
      for (const s of strings) expect(s).not.toMatch(/[\/\\~@: ]/);
    }
  });
});

describe('KNOWN_AI_TOOL_IDS', () => {
  it('matches the ids in ide-detection.ts', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'npx-cli', 'commands', 'ide-detection.ts'), 'utf-8');
    const ids = [...source.matchAll(/^\s+id: '([a-z0-9-]+)',/gm)].map((m) => m[1]);
    expect([...KNOWN_AI_TOOL_IDS].sort()).toEqual([...new Set(ids)].sort());
  });
});

describe('scrubErrorSnippet', () => {
  it('scrubs home paths, tokens and emails and caps 40 lines / 4 KB', () => {
    const text = [
      'error: EACCES: permission denied, open \'/home/alex/.claude-mem/settings.json\'',
      'Authorization: Bearer sk-ant-abcdefghijklmnop0123456789',
      'contact alex@example.com',
      ...Array.from({ length: 60 }, (_, i) => `line ${i} ` + 'x'.repeat(200)),
    ].join('\n');
    const out = scrubErrorSnippet(text);
    expect(out).not.toContain('/home/alex');
    expect(out).not.toContain('sk-ant-abcdefghijklmnop0123456789');
    expect(out).not.toContain('alex@example.com');
    expect(out.split('\n').length).toBeLessThanOrEqual(40);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(4096);
  });
});

describe('collectSnapshot (human TTY path)', () => {
  it('fills the fields from local facts only and marks shared_by human', () => {
    const snap = collectSnapshot({
      platform: 'linux', arch: 'x64',
      env: { SHELL: '/usr/bin/zsh', npm_config_user_agent: 'npm/10.9.0 node/v22.11.0 linux x64', DISPLAY: ':0', HOME: '/home/alex' },
      nodeVersion: '22.11.0', isTTY: true, bunVersion: '1.4.2', uvVersion: 'uv 0.12.15 (x86_64-unknown-linux-gnu)',
      aiToolIds: ['claude-code', 'cursor'], agentContext: 'tty', installedVersion: '13.28.0', provider: 'claude',
      installId: '3f9d7c1e-2b4a-4e8f-9a61-0c5d2e7b8a90',
    });
    expect(snap).toMatchObject({
      os: { platform: 'linux', arch: 'x64', is_wsl: false },
      shell: 'zsh', node: '22.11.0', npm: '10.9.0', bun: '1.4.2', uv: '0.12.15',
      ai_tools: [{ id: 'claude-code', version: null }, { id: 'cursor', version: null }],
      agent_host: 'none', tty: true, desktop: true, ci: false, shared_by: 'human', human_asked: true,
    });
    expect(JSON.stringify(snap)).not.toContain('/home/alex');
  });
});
