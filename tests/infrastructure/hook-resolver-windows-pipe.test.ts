import { describe, it, expect } from 'bun:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

function readJson(rel: string): any {
  return JSON.parse(readFileSync(path.join(projectRoot, rel), 'utf-8'));
}

function commandsFromHooks(rel: string): { source: string; command: string }[] {
  const parsed = readJson(rel);
  const out: { source: string; command: string }[] = [];
  for (const matchers of Object.values<any>(parsed.hooks ?? {})) {
    for (const matcher of matchers as any[]) {
      for (const hook of (matcher.hooks ?? []) as any[]) {
        if (hook.type === 'command' && typeof hook.command === 'string') {
          out.push({ source: rel, command: hook.command });
        }
      }
    }
  }
  return out;
}

function commandsFromMcp(rel: string): { source: string; command: string }[] {
  const parsed = readJson(rel);
  const servers = parsed.mcpServers ?? {};
  const out: { source: string; command: string }[] = [];
  for (const [name, def] of Object.entries<any>(servers)) {
    const args: string[] = Array.isArray(def.args) ? def.args : [];
    const shellArg = args.find((_, i) => i > 0 && args[i - 1] === '-c');
    if (shellArg) out.push({ source: `${rel}:${name}`, command: shellArg });
  }
  return out;
}

const HOOK_SOURCES = ['plugin/hooks/hooks.json', 'plugin/hooks/codex-hooks.json'];
const MCP_SOURCES = ['.mcp.json', 'plugin/.mcp.json'];

const allShellCommands: { source: string; command: string }[] = [
  ...HOOK_SOURCES.flatMap(commandsFromHooks),
  ...MCP_SOURCES.flatMap(commandsFromMcp),
];

describe('Hook resolver — Windows pipe-closure regression', () => {
  describe('static: pipe-into-while-with-break producer must silence stderr (Windows EPIPE/EACCES)', () => {
    const PRODUCER_PIPE = /_P=\$\(\{[\s\S]*?\}(\s*[^|]*?)\|\s*while\s+IFS=\s+read\s+-r[\s\S]*?\bbreak\b[\s\S]*?\bdone\b/;

    for (const { source, command } of allShellCommands) {
      it(`${source}: producer block must redirect stderr to /dev/null`, () => {
        const match = command.match(PRODUCER_PIPE);
        if (!match) {
          return;
        }
        const betweenProducerCloseAndPipe = match[1] ?? '';
        expect(
          /2>\s*\/dev\/null/.test(betweenProducerCloseAndPipe),
          `${source}: producer block \`_P=$({ ... }\` must redirect stderr (\`} 2>/dev/null | while ...\`) so Windows Git Bash does not leak "printf: write error: Permission denied" when the consumer breaks early. Got between producer close and pipe: "${betweenProducerCloseAndPipe}"`,
        ).toBe(true);
      });
    }
  });

  describe('runtime: resolver snippet does not leak stderr or non-zero exit', () => {
    function setupFakeTree() {
      const base = mkdtempSync(path.join(tmpdir(), 'cm-pipe-test-'));
      const versions = ['13.0.0', '13.1.0', '13.2.0'];
      for (const v of versions) {
        const scriptsDir = path.join(base, 'plugins', 'cache', 'thedotmack', 'claude-mem', v, 'plugin', 'scripts');
        mkdirSync(scriptsDir, { recursive: true });
        for (const f of ['bun-runner.js', 'worker-service.cjs', 'version-check.js', 'mcp-server.cjs']) {
          writeFileSync(path.join(scriptsDir, f), '');
        }
      }
      return base;
    }

    function runResolverOnly(command: string, fakeRoot: string): { stdout: string; stderr: string; status: number | null } {
      const resolverPart = command.replace(
        /;\s*\[ -n "\$_P" \][\s\S]*$/,
        '; printf "RESOLVED=%s\\n" "$_P"'
      );
      const result = spawnSync('bash', ['-c', resolverPart], {
        env: {
          ...process.env,
          CLAUDE_CONFIG_DIR: fakeRoot,
          CLAUDE_PLUGIN_ROOT: '',
          PLUGIN_ROOT: '',
          SHELL: '/bin/bash',
        },
        encoding: 'utf-8',
        timeout: 10000,
      });
      return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        status: result.status,
      };
    }

    for (const { source, command } of allShellCommands) {
      it(`${source} resolver runs cleanly against a populated cache`, () => {
        const fakeRoot = setupFakeTree();
        try {
          for (let i = 0; i < 5; i++) {
            const { stdout, stderr, status } = runResolverOnly(command, fakeRoot);
            const noiseFreeStderr = stderr
              .split('\n')
              .filter((line) => line.trim().length > 0)
              .filter((line) => !/^\+\s/.test(line))
              .join('\n');
            expect(noiseFreeStderr, `iteration ${i} for ${source}: stderr=${stderr}`).toBe('');
            expect(status, `iteration ${i} for ${source}: status`).toBe(0);
            expect(stdout, `iteration ${i} for ${source}: stdout`).toContain('RESOLVED=');
            expect(stdout, `iteration ${i} for ${source}: stdout`).not.toContain('RESOLVED=\n');
          }
        } finally {
          rmSync(fakeRoot, { recursive: true, force: true });
        }
      });
    }
  });

  describe('runtime: resolver picks newest cached version', () => {
    it('hooks.json Stop hook resolver prefers newest version directory', () => {
      const base = mkdtempSync(path.join(tmpdir(), 'cm-pipe-newest-'));
      try {
        const versions = ['13.0.0', '13.1.0', '13.2.0'];
        for (const v of versions) {
          const scriptsDir = path.join(base, 'plugins', 'cache', 'thedotmack', 'claude-mem', v, 'plugin', 'scripts');
          mkdirSync(scriptsDir, { recursive: true });
          for (const f of ['bun-runner.js', 'worker-service.cjs', 'version-check.js']) {
            writeFileSync(path.join(scriptsDir, f), '');
          }
          const now = Date.now() / 1000;
          const offset = versions.indexOf(v);
          spawnSync('touch', ['-d', `@${now - (versions.length - offset) * 60}`, path.join(base, 'plugins', 'cache', 'thedotmack', 'claude-mem', v)]);
        }

        const hooksJson = readJson('plugin/hooks/hooks.json');
        const stopHookCommand = hooksJson.hooks.Stop[0].hooks[0].command as string;
        const resolverPart = stopHookCommand.replace(
          /;\s*\[ -n "\$_P" \][\s\S]*$/,
          '; printf "RESOLVED=%s\\n" "$_P"'
        );

        const result = spawnSync('bash', ['-c', resolverPart], {
          env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: base,
            CLAUDE_PLUGIN_ROOT: '',
            PLUGIN_ROOT: '',
            SHELL: '/bin/bash',
          },
          encoding: 'utf-8',
          timeout: 10000,
        });

        expect(result.stderr ?? '').toBe('');
        expect(result.status).toBe(0);
        expect(result.stdout ?? '').toContain('13.2.0');
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
});
