// Hermes and Claude Code share memory under the same checkout project key.
//
// A real claude-mem worker runs on a free port with a temporary data dir. The
// Hermes provider is installed by the real installer into a temporary
// HERMES_HOME, then one Hermes session is played through it (Python, loaded
// the way Hermes loads a user plugin). Then a Claude Code-shaped search — the
// MCP server, started from the exact mcp_servers entry the installer wrote
// into Hermes's config — must find what the Hermes session recorded, and the
// Hermes session must have been handed what a Claude Code session recorded.
//
// Nothing here touches the runner's home: HOME, the data dir and HERMES_HOME
// all point into one temporary folder.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getProjectContext } from '../../src/utils/project-name.js';

const REPO = join(import.meta.dir, '..', '..');
const WORKER_SERVICE = join(REPO, 'src', 'services', 'worker-service.ts');
const DRIVER = join(REPO, 'tests', 'hermes', 'hermes_session_driver.py');
const parseYaml = (text: string) => (Bun as unknown as { YAML: { parse(text: string): any } }).YAML.parse(text);

function python(): string | null {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info >= (3, 8))'], { encoding: 'utf-8' });
    if (probe.status === 0 && probe.stdout.trim() === 'True') return candidate;
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

let root = '';
let checkout = '';
let hermesHome = '';
let env: Record<string, string> = {};
let base = '';
let worker: ChildProcess | null = null;
let workerLog = '';
const PYTHON = python();

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (worker?.exitCode !== null && worker?.exitCode !== undefined) {
      throw new Error(`worker exited with ${worker.exitCode}:\n${workerLog.slice(-4000)}`);
    }
    try {
      const response = await fetch(`${base}/api/readiness`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`worker never became ready:\n${workerLog.slice(-4000)}`);
}

async function post(path: string, body: unknown): Promise<any> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json();
}

beforeAll(async () => {
  // Without Python 3.8+ the describe below is skipped; CI runners have it.
  if (!PYTHON) return;
  root = mkdtempSync(join(tmpdir(), 'claude-mem-hermes-e2e-'));
  const dataDir = join(root, 'claude-mem-data');
  checkout = join(root, 'shop-api');
  hermesHome = join(root, 'hermes-home');
  for (const directory of [dataDir, checkout, hermesHome, join(root, 'claude')]) mkdirSync(directory, { recursive: true });
  expect(spawnSync('git', ['init', '-q', checkout]).status).toBe(0);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
    CLAUDE_MEM_WORKER_PORT: String(port),
    CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_WORKER_AUTOSTART: 'false',
    CLAUDE_MEM_CHROMA_ENABLED: 'false',
    CLAUDE_MEM_RUNTIME: 'worker',
  }));

  env = {};
  for (const [key, value] of Object.entries(process.env)) {
    // The test-run guards (CLAUDE_MEM_TEST_*) stay; every other claude-mem setting comes from this test.
    const claudeMemSetting = (key.startsWith('CLAUDE_MEM_') && !key.startsWith('CLAUDE_MEM_TEST_'));
    if (value !== undefined && !claudeMemSetting && key !== 'HERMES_HOME') env[key] = value;
  }
  Object.assign(env, {
    HOME: root,
    USERPROFILE: root,
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CLAUDE_MEM_DATA_DIR: dataDir,
    DO_NOT_TRACK: '1',
  });

  worker = spawn(process.execPath, [WORKER_SERVICE, '--daemon'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout?.on('data', chunk => { workerLog += String(chunk); });
  worker.stderr?.on('data', chunk => { workerLog += String(chunk); });
  await waitForReady();
}, 150_000);

afterAll(async () => {
  if (worker && worker.exitCode === null) {
    try {
      await fetch(`${base}/api/admin/shutdown`, { method: 'POST', signal: AbortSignal.timeout(5_000) });
    } catch {
      // fall through to the kill below
    }
    const exited = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 15_000);
      worker!.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    if (!exited) worker.kill('SIGKILL');
  }
  if (root) rmSync(root, { recursive: true, force: true });
}, 30_000);

describe.skipIf(!PYTHON)('Hermes session memory, end to end against a real worker', () => {
  it('records a Hermes session that a Claude Code search finds, and hands Hermes what Claude Code recorded', async () => {
    // The key Claude Code's hooks resolve for this checkout.
    const project = getProjectContext(checkout).primary;

    // 1. A Claude Code session in the same checkout leaves a note.
    await post('/api/sessions/init', {
      contentSessionId: 'claude-code-e2e', project, platformSource: 'claude',
      prompt: 'Why do deploys of shop-api keep serving stale prices?',
    });
    const claudeNote = await post('/api/memory/save', {
      text: 'The quokkaharbor price cache must be flushed before every shop-api deploy.',
      project,
      metadata: { platformSource: 'claude' },
    });
    expect(claudeNote.success).toBe(true);

    // 2. Install the provider the way a user does, into a temporary HERMES_HOME.
    // Resolve import-time paths inside the isolated home. A developer's existing
    // marketplace must not substitute an older provider or MCP bundle here.
    const installed = spawnSync(process.execPath, ['-e',
      "import { installHermesIntegration } from './src/services/integrations/HermesInstaller.ts'; process.exit(installHermesIntegration());",
    ], {
      cwd: REPO,
      env: { ...env, HERMES_HOME: hermesHome, CLAUDE_MEM_DEV_HOOK_SOURCE: '1' },
      encoding: 'utf-8', timeout: 30_000,
    });
    expect(installed.status, installed.stderr).toBe(0);
    for (const name of ['__init__.py', 'client.py', 'plugin.yaml', 'README.md']) {
      expect(readFileSync(join(hermesHome, 'plugins', 'claude-mem', name)))
        .toEqual(readFileSync(join(REPO, 'hermes', 'claude-mem', name)));
    }
    const hermesConfig = parseYaml(readFileSync(join(hermesHome, 'config.yaml'), 'utf-8'));
    expect(hermesConfig.memory.provider).toBe('claude-mem');

    // 3. One Hermes session in that checkout.
    const sessionId = '20261016_101500_e2e';
    const driver = spawnSync(PYTHON!, [DRIVER, JSON.stringify({
      plugin_dir: join(hermesHome, 'plugins', 'claude-mem'),
      cwd: checkout,
      session_id: sessionId,
      prompt: 'Wire the zebracornflower flag into the shop-api deploy script',
      tool: { name: 'terminal', args: { command: 'grep -n deploy scripts/deploy.sh' }, result: '12: ./deploy --prod' },
      memory_note: 'The shop-api deploy script needs the zebracornflower flag.',
      query: 'What has to happen to the quokkaharbor price cache before a deploy?',
    })], { cwd: REPO, env, encoding: 'utf-8', timeout: 60_000 });
    expect(driver.status, driver.stderr).toBe(0);
    const injected = JSON.parse(driver.stdout.trim().split('\n').pop()!);
    // The other direction: Hermes is handed the note Claude Code recorded.
    expect(injected.notes).toContain('quokkaharbor');
    expect(injected.block).toContain('# claude-mem memory');

    // 4. What the worker stored, under the project Claude Code uses.
    const toolUses = await (await fetch(`${base}/api/tool-uses?contentSessionId=${sessionId}&platformSource=hermes`)).json() as any;
    expect(toolUses.toolUses.map((row: any) => row.tool_name ?? row.toolName)).toContain('terminal');

    // 5. a Claude Code-shaped search through claude-mem's MCP server,
    //    started from the entry the installer wrote into Hermes's config.
    const entry = hermesConfig.mcp_servers['claude-mem'];
    expect(entry.env.CLAUDE_MEM_DATA_DIR).toBe(env.CLAUDE_MEM_DATA_DIR);
    const transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      cwd: checkout,
      stderr: 'pipe',
      env: { ...env, ...entry.env },
    });
    transport.stderr?.on('data', () => {});
    const client = new Client({ name: 'claude-code-shaped-search', version: '1' });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toContain('search');
      expect(names).toContain('timeline');
      expect(names).toContain('get_observations');
      expect(names).toContain('dumb_search');
      expect(names).not.toContain('mem_search');
      expect(names).not.toContain('flash_search');
      const result = await client.callTool({ name: 'search', arguments: { query: 'zebracornflower', project } }) as CallToolResult;
      const text = result.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('\n');
      expect(result.isError).toBeFalsy();
      // The Hermes prompt and the Hermes memory note, filed under Claude Code's key.
      // Search rows show the first 57 characters of a prompt.
      expect(text).toContain('Wire the zebracornflower flag into the shop-api');
      expect(text).toContain('needs the zebracornflower flag');
    } finally {
      await client.close();
      await transport.close();
    }

    const unified = await (await fetch(`${base}/api/search?query=zebracornflower&project=${encodeURIComponent(project)}&format=json`)).json();
    expect(JSON.stringify(unified)).toContain('needs the zebracornflower flag');
    expect(JSON.stringify(unified)).toContain('Wire the zebracornflower flag into the shop-api deploy script');
  }, 150_000);
});
