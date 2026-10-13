import { afterEach, describe, expect, it } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const projectRoot = path.resolve(import.meta.dir, '../..');
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(dependencies: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'claude-mem-qoder-launcher-'));
  temporaryRoots.push(root);
  const scripts = path.join(root, 'scripts');
  mkdirSync(scripts, { recursive: true });
  copyFileSync(
    path.join(projectRoot, 'plugin/scripts/qoder-hook-launcher.cjs'),
    path.join(scripts, 'qoder-hook-launcher.cjs'),
  );
  writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies }),
  );
  writeFileSync(
    path.join(scripts, 'version-check.js'),
    "process.exit(Number(process.env.FAKE_SETUP_STATUS || '0'));\n",
  );
  writeFileSync(path.join(scripts, 'worker-service.cjs'), '// fixture\n');
  writeFileSync(
    path.join(scripts, 'bun-runner.js'),
    `const args = process.argv.slice(2);
const expected = process.env.EXPECTED_QODER_EVENT;
if (args[1] !== 'hook' || args[2] !== 'codex' || args[3] !== expected) {
  process.stderr.write('bad forwarded args: ' + JSON.stringify(args) + '\\n');
  process.exit(42);
}
process.stdout.write(JSON.stringify({ forwardedEvent: args[3] }) + '\\n');
`,
  );
  return root;
}

function runHook(root: string, event: string, extraEnv: Record<string, string> = {}) {
  return spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'qoder-hook-launcher.cjs'), event],
    {
      input: '{"session_id":"fixture","cwd":"/tmp"}\n',
      encoding: 'utf-8',
      env: { ...process.env, EXPECTED_QODER_EVENT: event, ...extraEnv },
    },
  );
}

describe('Qoder hook launcher execution', () => {
  for (const event of ['context', 'session-init', 'file-context', 'observation', 'summarize']) {
    it(`forwards ${event} through the Codex-compatible adapter`, () => {
      const root = fixture();
      const result = runHook(root, event);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ forwardedEvent: event });
    });
  }

  it('does not start the worker when setup exits zero but dependencies remain missing', () => {
    const root = fixture({ zod: '^4.4.3' });
    const marker = path.join(root, 'worker-started');
    writeFileSync(
      path.join(root, 'scripts', 'bun-runner.js'),
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`,
    );

    const result = runHook(root, 'context');

    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(result.stderr).toContain('dependencies remain incomplete');
    expect(JSON.parse(result.stdout)).toEqual({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '',
      },
    });
  });

  it('returns a valid no-op when the setup process itself fails', () => {
    const root = fixture();
    const result = runHook(root, 'context', { FAKE_SETUP_STATUS: '23' });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('dependency setup failed');
    expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe('SessionStart');
  });
});

describe('Qoder MCP launcher execution', () => {
  const descriptor = JSON.parse(
    readFileSync(path.join(projectRoot, 'plugin/qoder.mcp.json'), 'utf-8'),
  ).mcpServers['mcp-search'];

  for (const layout of ['bundled', 'repository'] as const) {
    it(`starts mcp-server.cjs from the ${layout} layout`, () => {
      const root = mkdtempSync(path.join(tmpdir(), `claude-mem-qoder-mcp-${layout}-`));
      temporaryRoots.push(root);
      const pluginRoot = layout === 'repository' ? path.join(root, 'plugin') : root;
      mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
      writeFileSync(
        path.join(pluginRoot, 'scripts', 'mcp-server.cjs'),
        "process.stdout.write('QODER_MCP_OK\\n');\n",
      );

      const result = spawnSync(descriptor.command, descriptor.args, {
        encoding: 'utf-8',
        env: { ...process.env, QODER_PLUGIN_ROOT: root },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('QODER_MCP_OK\n');
      expect(result.stderr).toBe('');
    });
  }
});
