import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Claude Code keeps its transcripts and settings in CLAUDE_CONFIG_DIR when it
// is set (the hook environment the worker inherits), like CODEX_HOME for Codex.
// Runs in a subprocess with an owned HOME so no real profile is read.
const modules = Object.fromEntries(['readers', 'token-usage'].map(name =>
  [name, new URL(`../../../src/services/prompt-import/${name}.ts`, import.meta.url).href]));

function transcript(config: string, label: string): string {
  mkdirSync(join(config, 'projects', `-${label}`), { recursive: true });
  const path = join(config, 'projects', `-${label}`, `${label}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: 'user', sessionId: label, timestamp: new Date().toISOString(),
    origin: { kind: 'human' }, entrypoint: 'cli', message: { content: `fix the ${label} bug` } }) + '\n');
  return path;
}

it('reads Claude Code transcripts and cleanupPeriodDays from CLAUDE_CONFIG_DIR', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cmem-claude-config-')));
  try {
    const home = join(root, 'home');
    const config = join(root, 'claude-profile');
    transcript(join(home, '.claude'), 'default');
    const active = transcript(config, 'active');
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ cleanupPeriodDays: 1 }));
    const script = join(root, 'scan.ts');
    writeFileSync(script, `
      import { homedir } from 'node:os';
      const { createPromptReaders } = await import(${JSON.stringify(modules.readers)});
      const { scanTokenUsage } = await import(${JSON.stringify(modules['token-usage'])});
      const located = createPromptReaders().find(entry => entry.id === 'claude-code').locate(homedir());
      const { agents } = await scanTokenUsage({ sinceEpochMs: Date.now() - 86_400_000, agents: ['claude-code'] });
      console.log(JSON.stringify({ paths: located.sources.map(source => source.path), retentionShorterThanWindow: agents[0].retentionShorterThanWindow }));
    `);
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config, CLAUDE_MEM_DATA_DIR: join(root, 'data') };
    const run = Bun.spawnSync([process.execPath, script], { env, stdout: 'pipe', stderr: 'pipe' });
    if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
    const result = JSON.parse(new TextDecoder().decode(run.stdout).trim().split('\n').at(-1)!);
    expect(result.paths).toEqual([active]);
    expect(result.retentionShorterThanWindow).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
