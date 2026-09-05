import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveInstallerProviderChoice } from '../../src/npx-cli/installer-provider-choice';

const root = join(__dirname, '..', '..');
const decoder = new TextDecoder();

// Invoke only settings prompts, never the installer, OAuth, or worker setup.
function runSetup(model?: string, corrupt = false, interactive = false) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-setup-'));
  const original = {
    theme: 'dark', permissions: { defaultMode: 'auto' },
    env: {
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_CODEX_MODEL: 'saved-model',
      CLAUDE_MEM_CODEX_REASONING_EFFORT: 'none',
      CLAUDE_MEM_CODEX_PATH: '/native/codex',
      CLAUDE_MEM_MODEL: 'saved-claude-model',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'preserved-personal-key',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://example.invalid/v1',
      CLAUDE_MEM_PRO_MEMORY_MODEL: 'cmem-observer',
    },
  };
  try {
    const result = Bun.spawnSync([process.execPath, '--eval', `
      import { writeFileSync } from 'fs';
      import { mock } from 'bun:test';
      globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
      Object.defineProperty(process.stdin, 'isTTY', { value: ${interactive} });
      mock.module('@clack/prompts', () => ({
        text: async (options) => options.defaultValue,
        isCancel: () => false,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      }));
      writeFileSync(process.env.CLAUDE_MEM_DATA_DIR + '/settings.json', ${JSON.stringify(corrupt ? '{broken' : JSON.stringify(original))});
      const { promptProvider, promptCodexModel, providerNeedsAccount } = await import('./src/npx-cli/commands/install.ts');
      if (providerNeedsAccount('codex')) throw new Error('Codex must not require CMEM OAuth');
      const selected = await promptProvider({ provider: 'codex' }, null, 'test');
      if (selected !== 'codex') throw new Error('Unexpected provider fallback');
      await promptCodexModel(${JSON.stringify(model === undefined ? {} : { model })});
    `], {
      cwd: root,
      env: { ...process.env, CLAUDE_MEM_DATA_DIR: dir, DO_NOT_TRACK: '1', CLAUDE_MEM_TELEMETRY: '0' },
      stdout: 'pipe', stderr: 'pipe',
    });
    return { original, exitCode: result.exitCode,
      output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
      raw: readFileSync(join(dir, 'settings.json'), 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('explicit local Codex installer setup', () => {
  it('wins over the Grok CMEM default', () => {
    expect(resolveInstallerProviderChoice({ ide: 'grok-bot', provider: 'codex' })).toBe('codex');
  });

  for (const interactive of [false, true]) {
    it(`preserves existing model, reasoning, provider credentials and peer keys (interactive=${interactive})`, () => {
      const result = runSetup(undefined, false, interactive);
      expect(result.exitCode, result.output).toBe(0);
      expect(JSON.parse(result.raw)).toEqual({ ...result.original,
        env: { ...result.original.env, CLAUDE_MEM_PROVIDER: 'codex' } });
    });
  }

  it('persists an explicit model without changing reasoning or other providers', () => {
    const result = runSetup('custom-codex-model');
    expect(result.exitCode, result.output).toBe(0);
    expect(JSON.parse(result.raw)).toEqual({ ...result.original,
      env: { ...result.original.env, CLAUDE_MEM_PROVIDER: 'codex', CLAUDE_MEM_CODEX_MODEL: 'custom-codex-model' } });
  });

  it('fails without overwriting malformed settings or falling back to Claude', () => {
    const result = runSetup(undefined, true);
    expect(result.exitCode).not.toBe(0);
    expect(result.raw).toBe('{broken');
    expect(result.output).toContain('Could not save the local Codex configuration');
  });

  it('rejects an empty explicit model without replacing the saved model', () => {
    const result = runSetup('  ');
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.raw).env.CLAUDE_MEM_CODEX_MODEL).toBe('saved-model');
  });

  for (const provider of ['claude', 'codex', 'gemini', 'openrouter', 'host', 'invalid']) {
    it(`CLI provider validation: ${provider}`, () => {
      const result = Bun.spawnSync([process.execPath, '--eval', `
        import { mock } from 'bun:test';
        mock.module('./src/npx-cli/commands/install.js', () => ({
          runInstallCommand: async (options) => console.log('__OPTIONS__=' + JSON.stringify(options)),
        }));
        process.argv = ['bun', 'index.ts', 'install', '--provider', ${JSON.stringify(provider)}, '--model', 'chosen-model'];
        await import('./src/npx-cli/index.ts');
      `], { cwd: root, env: process.env, stdout: 'pipe', stderr: 'pipe' });
      const output = decoder.decode(result.stdout) + decoder.decode(result.stderr);
      expect(result.exitCode, output).toBe(provider === 'invalid' ? 1 : 0);
      if (provider === 'invalid') expect(output).toContain('Allowed: claude, codex, gemini, openrouter, host');
      else {
        expect(output).toContain(`"provider":"${provider}"`);
        expect(output).toContain('"model":"chosen-model"');
      }
    });
  }
});
