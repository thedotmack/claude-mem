import { describe, it, expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';

const sourceRoot = join(import.meta.dir, '..', 'src');
const packageRoot = join(import.meta.dir, '..');

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE_MEM_|ANTHROPIC_|OPENROUTER_|GEMINI_|CODEX_|DO_NOT_TRACK$|CI$)/.test(key)) delete env[key];
  }
  return { ...env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDE_MEM_DATA_DIR: join(root, 'data'), CLAUDE_MEM_ENV_FILE: join(root, 'data', '.env') };
}

function writeFixture(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function runInstaller(missingKey: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'install-non-tty-'));
  try {
    const source = join(root, 'package');
    const files: Record<string, string> = {
      LICENSE: 'fixture license', NOTICE: 'fixture notice',
      'package.json': JSON.stringify({ name: 'claude-mem', version: '0.0.0-test', dependencies: {} }),
      '.agents/plugins/marketplace.json': '{"name":"codex-fixture"}',
      '.codex-plugin/plugin.json': '{"name":"codex-root-fixture"}',
      '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'claude-mem', source: './plugin' }, { name: 'cmem-pro', source: './cowork' }] }),
      'plugin/.claude-plugin/plugin.json': '{"name":"claude-mem","version":"0.0.0-test"}',
      'plugin/package.json': '{"name":"claude-mem-plugin","version":"0.0.0-test"}',
      'omp/hooks/claude-mem.ts': 'omp fixture',
      'hermes/provider.py': 'hermes fixture',
    };
    for (const [file, content] of Object.entries(files)) writeFixture(source, file, content);
    writeFixture(root, 'data/settings.json', JSON.stringify({ env: { CLAUDE_MEM_WORKER_AUTOSTART: 'false' } }));
    const child = Bun.spawnSync([process.execPath, '-e', `
      import { mock } from 'bun:test';
      import { join } from 'path';
      const at = file => join(${JSON.stringify(sourceRoot)}, file);
      const paths = await import(at('npx-cli/utils/paths.js'));
      mock.module(at('npx-cli/utils/paths.js'), () => ({ ...paths,
        npmPackageRootDirectory: () => ${JSON.stringify(source)},
        npmPackagePluginDirectory: () => ${JSON.stringify(join(source, 'plugin'))},
        readPluginVersion: () => '0.0.0-test',
      }));
      mock.module('@clack/prompts', () => ({ password: async () => { console.log('PASSWORD_CALLED'); throw new Error('Unexpected password prompt'); } }));
      mock.module(at('npx-cli/install/setup-runtime.js'), () => ({
        ensureBun: async () => ({ bunPath: process.execPath, version: '1-test' }),
        ensureUv: async () => ({ version: '2-test' }), getBunPath: () => process.execPath,
        isInstallCurrent: () => false,
        installPluginDependencies: async () => { console.log('DEPENDENCIES_READY'); },
        provisionTreeSitterCli: async () => {},
        writeInstallMarker: path => { console.log('INSTALL_MARKER:' + path); },
      }));
      mock.module(at('launcher/install-launcher.js'), () => ({
        ensureLauncherOnPath: () => ({ status: 'already-current', binaryPath: '/fixture/claude-mem' }),
        ensureLocalBinOnShellPath: () => ({ alreadyOnPath: true }),
      }));
      mock.module(at('npx-cli/utils/prune-cache.js'), () => ({ prunePluginCacheSafely: async () => ({ removed: [], failed: [] }) }));
      mock.module(at('npx-cli/install/usage-summary.js'), () => ({ readUsageSummary: async () => null, formatUsageSummaryLines: () => [] }));
      mock.module(at('npx-cli/install/claude-code-version.js'), () => ({ detectClaudeCodeVersion: () => undefined, claudeCodeVersionTooOldWarning: () => null }));
      mock.module(at('shared/worker-spawn-gate.js'), () => ({ holdSpawnLock: async () => () => {}, SPAWN_LOCK_STALE_MS: 1 }));
      mock.module(at('npx-cli/install/npm-install-helper.js'), () => ({
        runNpmStrict: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
        extractEresolveBlock: () => '', isEresolve: () => false, npmErrorCode: () => '',
      }));
      mock.module(at('services/telemetry/cli-telemetry.js'), () => ({ captureCliEvent: async (name, properties) => console.log('EVENT:' + name + ':' + JSON.stringify(properties)) }));
      mock.module(at('shared/intent-credentials.js'), () => ({ readIntentCredentials: () => ({}), intentCredentialHeaders: () => ({}) }));
      globalThis.fetch = async (_url, options) => {
        const request = JSON.parse(options.body);
        if (request.source !== 'npx-installer-deferred') throw new Error('Unexpected network request');
        const pairing = 'a'.repeat(32);
        return new Response(JSON.stringify({ pairing_id: pairing, secret: 'b'.repeat(48), user_code: 'ABCD-EFGH',
          authorization_url: 'https://cmem.ai/login?next=' + encodeURIComponent('/api/pro/trial/claim?pairing=' + pairing + '&login_only=1'),
          checkout_url: 'https://cmem.ai/api/pro/trial/claim?pairing=' + pairing + '&trial=7' }));
      };
      const { runInstallCommand } = await import(at('npx-cli/commands/install.js'));
      await runInstallCommand(${missingKey ? "{ provider: 'gemini', noAutoStart: true }" : "{ noAutoStart: true }"});
    `], { env: isolatedEnv(root), stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
    const output = new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr);
    const marketplace = join(root, 'claude', 'plugins', 'marketplaces', 'thedotmack');
    return { exitCode: child.exitCode, output, files: Object.fromEntries(Object.keys(files).map(file => [file,
      existsSync(join(marketplace, file)) ? readFileSync(join(marketplace, file), 'utf8') : null])) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('non-TTY installer', () => {
  it('refuses a missing personal key without prompting', () => {
    const result = runInstaller(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('gemini requires a preconfigured personal API key');
    expect(result.output).toContain('CLAUDE_MEM_GEMINI_API_KEY');
    expect(result.output).not.toContain('PASSWORD_CALLED');
    expect(result.output).not.toContain('EVENT:install_completed');
  });

  it('copies marketplace content and offers sign-in before completion', () => {
    const result = runInstaller(false);
    if (result.exitCode !== 0) console.error(result.output);
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain('PASSWORD_CALLED');
    expect(result.output).toContain('defaulting to your Anthropic plan');
    const link = result.output.indexOf('Sign-in link: https://cmem.ai/login?');
    const completion = result.output.indexOf('EVENT:install_completed:');
    expect(link).toBeGreaterThan(-1);
    expect(completion).toBeGreaterThan(link);
    expect(result.output).toContain('"runtime_mode":"worker"');
    const dependencies = result.output.indexOf('DEPENDENCIES_READY');
    const marker = result.output.indexOf('INSTALL_MARKER:');
    expect(dependencies).toBeGreaterThanOrEqual(0);
    expect(marker).toBeGreaterThan(dependencies);
    expect(result.files['.agents/plugins/marketplace.json']).toBe('{"name":"codex-fixture"}');
    expect(result.files['.codex-plugin/plugin.json']).toBe('{"name":"codex-root-fixture"}');
    expect(result.files['omp/hooks/claude-mem.ts']).toBe('omp fixture');
    expect(result.files['hermes/provider.py']).toBe('hermes fixture');
    expect(JSON.parse(result.files['.claude-plugin/marketplace.json']!)).toEqual({ plugins: [{ name: 'claude-mem', source: './plugin' }] });
  });

  it('ships OMP and Hermes sources', () => {
    const { files } = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    expect(files).toContain('omp');
    expect(files).toContain('hermes');
    expect(files).toContain('plugin/.claude-plugin');
  });
});

describe('Codex installation ordering', () => {
  it.each(['success', 'registration-failure', 'cleanup-failure'])('registers before legacy cleanup (%s)', scenario => {
    const root = mkdtempSync(join(tmpdir(), 'install-codex-order-'));
    try {
      const codexHome = join(root, 'codex');
      const agents = join(codexHome, 'AGENTS.md');
      const original = '# Keep\n\n<claude-mem-context>\nlegacy\n</claude-mem-context>\n';
      if (scenario === 'cleanup-failure') mkdirSync(agents, { recursive: true });
      else writeFixture(codexHome, 'AGENTS.md', original);
      const marketplace = join(root, 'marketplace');
      for (const file of ['.agents/plugins/marketplace.json', 'plugin/.codex-plugin/plugin.json', 'plugin/.mcp.json', 'plugin/hooks/codex-hooks.json', 'plugin/skills/mem-search/SKILL.md']) writeFixture(marketplace, file, '{}');
      const stub = join(root, 'bin', 'codex.js');
      writeFixture(root, 'bin/codex.js', `
        import { appendFileSync, readFileSync, statSync } from 'fs';
        const args = process.argv.slice(2);
        const agents = ${JSON.stringify(agents)};
        appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify({ args, agents: statSync(agents).isDirectory() ? 'directory' : readFileSync(agents, 'utf8') }) + '\\n');
        if (args[0] === '--version') console.log('codex 1.0.0');
        if (args.join(' ') === 'plugin list') console.log('claude-mem@claude-mem-local');
        if (${JSON.stringify(scenario)} === 'registration-failure' && args[1] === 'marketplace' && args[2] === 'add') { console.error('fixture registration refused'); process.exit(17); }
      `);
      if (process.platform === 'win32') writeFixture(root, 'bin/codex.cmd', `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`);
      else {
        writeFixture(root, 'bin/codex', `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
        chmodSync(join(root, 'bin', 'codex'), 0o755);
      }
      const child = Bun.spawnSync([process.execPath, '-e', `
        const { installCodexCli } = await import(${JSON.stringify(join(sourceRoot, 'services/integrations/CodexCliInstaller.ts'))});
        process.exitCode = await installCodexCli(${JSON.stringify(marketplace)});
      `], { env: { ...isolatedEnv(root), CODEX_HOME: codexHome, PATH: join(root, 'bin') + delimiter + (process.env.PATH ?? '') }, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
      const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const registrationIndex = calls.findIndex(call => call.args.join(' ') === `plugin marketplace add ${marketplace}`);
      const versionIndex = calls.findIndex(call => call.args.join(' ') === '--version');
      expect(versionIndex).toBeGreaterThanOrEqual(0);
      expect(registrationIndex).toBeGreaterThan(versionIndex);
      const registration = calls[registrationIndex];
      expect(registration.agents).toBe(scenario === 'cleanup-failure' ? 'directory' : original);
      const pluginAdd = calls.find(call => call.args.join(' ') === 'plugin add claude-mem@claude-mem-local');
      if (scenario === 'registration-failure') expect(pluginAdd).toBeUndefined();
      else expect(pluginAdd.agents).toBe(scenario === 'cleanup-failure' ? 'directory' : original);
      expect(child.exitCode).toBe(scenario === 'registration-failure' ? 1 : 0);
      if (scenario === 'success') expect(readFileSync(agents, 'utf8')).toBe('# Keep\n');
      if (scenario === 'registration-failure') {
        expect(readFileSync(agents, 'utf8')).toBe(original);
        expect(new TextDecoder().decode(child.stderr)).toContain('fixture registration refused');
      }
      if (scenario === 'cleanup-failure') expect(new TextDecoder().decode(child.stderr)).toContain('failed to remove legacy AGENTS.md context');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
