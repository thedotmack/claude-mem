import { describe, it, expect } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const INSTALLER = resolve(import.meta.dir, '../src/services/integrations/WindsurfHooksInstaller.js');

describe("WindsurfHooksInstaller reads Windsurf's hooks.json", () => {
  it('uninstalls claude-mem hooks from a BOM-prefixed file while preserving other hooks', () => {
    const home = mkdtempSync(join(tmpdir(), 'windsurf-hooks-bom-'));
    const hooksDir = join(home, '.codeium', 'windsurf');
    const hooksPath = join(hooksDir, 'hooks.json');
    const otherHook = { command: 'my own hook', show_output: false };
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(hooksPath, '\uFEFF' + JSON.stringify({
      hooks: {
        pre_user_prompt: [otherHook, { command: '"bun" "worker-service.cjs" windsurf session-init', show_output: false }],
      },
    }));
    const script = join(home, 'uninstall-child.mjs');
    writeFileSync(script, `
      console.log = () => {};
      const { uninstallWindsurfHooks } = await import(${JSON.stringify(INSTALLER)});
      process.stdout.write(String(uninstallWindsurfHooks()));
    `);
    try {
      const result = execFileSync(process.execPath, [script], {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CLAUDE_MEM_DATA_DIR: join(home, '.claude-mem'),
        },
        encoding: 'utf8',
        timeout: 60000,
      });
      expect(result).toBe('0');
      expect(JSON.parse(readFileSync(hooksPath, 'utf8'))).toEqual({
        hooks: { pre_user_prompt: [otherHook] },
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
