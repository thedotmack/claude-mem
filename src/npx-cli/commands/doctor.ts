// SPDX-License-Identifier: Apache-2.0
//
// follow-up: `claude-mem doctor` diagnostic CLI.
//
// Detects the active runtime (worker | server-beta) and runs mode-specific
// health checks. Output is a structured report with PASS / FAIL / WARN status
// and actionable hints. Exit code 0 = all checks passed, 1 = any failure.
//
// Common checks run in both modes:
//   - Plugin install detected
//   - Plugin/node_modules populated (fallback hook artefact)
//   - Tree-sitter grammars loadable (lazy-load self-check)
//   - 4 IDE MCP configs detected with `claude-mem` entry (injection)
//
// Worker-mode adds:
//   - SQLite db file present + readable
//   - worker.pid fresh (< 24h)
//   - worker HTTP /health reachable
//   - Chroma data dir present
//
// Server-beta mode adds:
//   - `docker info` reachable
//   - `docker compose ps` shows postgres + valkey + worker healthy
//   - Postgres reachable on 127.0.0.1:55432 (dev profile)
//   - API key file present + non-empty
//   - /v1/health returns 200
//   - /v1/memories/batch endpoint exists
//   - mcp-server.cjs under 600 KB hard cap (canary)

import pc from 'picocolors';
import { execSync } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import {
  DATA_DIR,
  USER_SETTINGS_PATH,
  DB_PATH,
  VECTOR_DB_DIR,
  MARKETPLACE_ROOT,
} from '../../shared/paths.js';

type CheckStatus = 'pass' | 'fail' | 'warn';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  hint?: string;
}

const STATUS_GLYPH: Record<CheckStatus, string> = {
  pass: pc.green('✓'),
  fail: pc.red('✗'),
  warn: pc.yellow('!'),
};

function printResult(r: CheckResult): void {
  const glyph = STATUS_GLYPH[r.status];
  const detail = r.detail ? pc.dim(` — ${r.detail}`) : '';
  console.log(`  ${glyph} ${r.name}${detail}`);
  if (r.status !== 'pass' && r.hint) {
    console.log(`      ${pc.dim('hint:')} ${r.hint}`);
  }
}

function safeExec(cmd: string, timeoutMs = 5000): { ok: boolean; out: string; err?: string } {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    return { ok: true, out };
  } catch (e: any) {
    return { ok: false, out: '', err: e?.message ?? String(e) };
  }
}

async function fetchWithTimeout(url: string, timeoutMs = 3000, headers: Record<string, string> = {}): Promise<{ ok: boolean; status?: number; err?: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers });
    clearTimeout(t);
    return { ok: res.ok, status: res.status };
  } catch (e: any) {
    clearTimeout(t);
    return { ok: false, err: e?.message ?? String(e) };
  }
}

// ─── Common checks ─────────────────────────────────────────────────────────

function checkPluginInstalled(): CheckResult {
  const pluginDir = join(MARKETPLACE_ROOT, 'plugin');
  if (existsSync(join(pluginDir, 'package.json'))) {
    return { name: 'Plugin install detected', status: 'pass', detail: pluginDir };
  }
  return {
    name: 'Plugin install detected',
    status: 'fail',
    detail: 'plugin/package.json missing',
    hint: `Run \`npx claude-mem install\` to populate ${MARKETPLACE_ROOT}`,
  };
}

function checkPluginNodeModules(): CheckResult {
  const nm = join(MARKETPLACE_ROOT, 'plugin', 'node_modules');
  if (existsSync(nm)) {
    try {
      const entries = require('fs').readdirSync(nm);
      if (entries.length > 0) {
        return { name: 'plugin/node_modules populated ', status: 'pass', detail: `${entries.length} packages` };
      }
    } catch {
      /* fallthrough */
    }
  }
  return {
    name: 'plugin/node_modules populated ',
    status: 'fail',
    detail: 'directory missing or empty',
    hint: `cd ${MARKETPLACE_ROOT}/plugin && npm install --ignore-scripts --no-audit --no-fund`,
  };
}

function checkBundleSizes(): CheckResult {
  const mcp = join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'mcp-server.cjs');
  if (!existsSync(mcp)) {
    return {
      name: 'mcp-server.cjs bundle (canary)',
      status: 'warn',
      detail: 'bundle file missing',
      hint: 'Run `npm run build-and-sync` to regenerate.',
    };
  }
  const sizeBytes = statSync(mcp).size;
  const sizeKb = Math.round(sizeBytes / 1024);
  const hardCapKb = 600;
  if (sizeKb <= 580) {
    return { name: 'mcp-server.cjs bundle (canary)', status: 'pass', detail: `${sizeKb} KB / ${hardCapKb} KB cap` };
  }
  if (sizeKb <= hardCapKb) {
    return {
      name: 'mcp-server.cjs bundle (canary)',
      status: 'warn',
      detail: `${sizeKb} KB approaching ${hardCapKb} KB cap`,
      hint: 'Check for accidental imports — see scripts/check-bundle-sizes.js',
    };
  }
  return {
    name: 'mcp-server.cjs bundle (canary)',
    status: 'fail',
    detail: `${sizeKb} KB exceeds ${hardCapKb} KB hard cap`,
    hint: 'Bundle regression — investigate scripts/build-hooks.js externals list.',
  };
}

function checkIdeConfigs(): CheckResult[] {
  const results: CheckResult[] = [];
  const home = homedir();
  const ides: { name: string; path: string; check: (raw: string) => boolean }[] = [
    {
      name: 'Claude Desktop MCP config',
      path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      check: (raw) => raw.includes('"claude-mem"'),
    },
    {
      name: 'OpenCode MCP config',
      path: join(home, '.config', 'opencode', 'opencode.json'),
      check: (raw) => raw.includes('claude-mem'),
    },
    {
      name: 'Codex CLI MCP config',
      path: join(home, '.codex', 'config.toml'),
      check: (raw) => raw.includes('[mcp_servers.claude-mem]') || raw.includes('claude-mem'),
    },
  ];

  for (const ide of ides) {
    if (!existsSync(ide.path)) {
      results.push({
        name: ide.name,
        status: 'warn',
        detail: 'IDE config not found (IDE may not be installed)',
      });
      continue;
    }
    try {
      const raw = readFileSync(ide.path, 'utf8');
      if (ide.check(raw)) {
        results.push({ name: ide.name, status: 'pass', detail: 'claude-mem entry present' });
      } else {
        results.push({
          name: ide.name,
          status: 'fail',
          detail: 'claude-mem entry missing',
          hint: 'Re-run `npx claude-mem install` to inject MCP config.',
        });
      }
    } catch (e: any) {
      results.push({
        name: ide.name,
        status: 'fail',
        detail: `read error: ${e?.message ?? e}`,
      });
    }
  }
  return results;
}

// ─── Worker-mode checks ────────────────────────────────────────────────────

function checkWorkerSqlite(): CheckResult {
  if (existsSync(DB_PATH)) {
    const sizeKb = Math.round(statSync(DB_PATH).size / 1024);
    return { name: 'SQLite database', status: 'pass', detail: `${DB_PATH} (${sizeKb} KB)` };
  }
  return {
    name: 'SQLite database',
    status: 'warn',
    detail: 'db file not yet created',
    hint: 'Normal for fresh installs. File appears after first session.',
  };
}

function checkWorkerPid(): CheckResult {
  const pidPath = join(DATA_DIR, 'worker.pid');
  if (!existsSync(pidPath)) {
    return {
      name: 'Worker process',
      status: 'warn',
      detail: 'worker.pid missing — worker not running',
      hint: 'Run `npx claude-mem start` to launch the worker.',
    };
  }
  const ageMs = Date.now() - statSync(pidPath).mtimeMs;
  if (ageMs > 24 * 3600 * 1000) {
    return {
      name: 'Worker process',
      status: 'warn',
      detail: `worker.pid is stale (${Math.round(ageMs / 3600 / 1000)}h old)`,
      hint: 'Worker may have crashed. Run `npx claude-mem restart`.',
    };
  }
  return { name: 'Worker process', status: 'pass', detail: 'worker.pid fresh' };
}

async function checkWorkerHttp(): Promise<CheckResult> {
  const portStr = SettingsDefaultsManager.get('CLAUDE_MEM_WORKER_PORT');
  const url = `http://127.0.0.1:${portStr}/health`;
  const res = await fetchWithTimeout(url);
  if (res.ok) {
    return { name: 'Worker HTTP /health', status: 'pass', detail: url };
  }
  return {
    name: 'Worker HTTP /health',
    status: 'fail',
    detail: res.err ?? `HTTP ${res.status}`,
    hint: `Worker not reachable at ${url}. Try \`npx claude-mem restart\`.`,
  };
}

function checkChromaDir(): CheckResult {
  if (existsSync(VECTOR_DB_DIR)) {
    return { name: 'Chroma vector store', status: 'pass', detail: VECTOR_DB_DIR };
  }
  return {
    name: 'Chroma vector store',
    status: 'warn',
    detail: 'vector-db dir missing',
    hint: 'Will be created on first observation. Not blocking.',
  };
}

// ─── Server-beta checks ────────────────────────────────────────────────────

function checkDocker(): CheckResult {
  const res = safeExec('docker info --format "{{.ServerVersion}}"');
  if (res.ok && res.out.trim()) {
    return { name: 'Docker daemon', status: 'pass', detail: `engine ${res.out.trim()}` };
  }
  return {
    name: 'Docker daemon',
    status: 'fail',
    detail: 'docker info failed',
    hint: 'Install Docker Desktop and ensure the daemon is running.',
  };
}

function checkComposeStack(): CheckResult {
  // fix — docker compose needs the --env-file path explicitly when the
  // .env file isn't in the project directory. install writes ~/.claude-mem/.env
  // which holds POSTGRES_USER / POSTGRES_PASSWORD; without --env-file the
  // compose YAML's `${POSTGRES_USER:?required}` interpolation aborts with a
  // 'variable missing' error before `ps` even runs.
  const envFile = join(homedir(), '.claude-mem', '.env');
  const envFlag = existsSync(envFile) ? `--env-file ${envFile}` : '';
  const res = safeExec(`docker compose --project-directory ${MARKETPLACE_ROOT} ${envFlag} ps --format json`);
  if (!res.ok) {
    return {
      name: 'docker compose stack',
      status: 'fail',
      detail: 'compose ps failed',
      hint: `cd ${MARKETPLACE_ROOT} && docker compose up -d`,
    };
  }
  const services = res.out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const needed = ['postgres', 'valkey', 'worker'];
  const missing = needed.filter((n) => !services.some((s: any) => (s?.Service ?? '').includes(n)));
  if (missing.length === 0) {
    return { name: 'docker compose stack', status: 'pass', detail: `${services.length} services up` };
  }
  return {
    name: 'docker compose stack',
    status: 'fail',
    detail: `missing services: ${missing.join(', ')}`,
    hint: `cd ${MARKETPLACE_ROOT} && docker compose up -d`,
  };
}

async function checkPostgresReachable(): Promise<CheckResult> {
  // Just open a TCP socket — we don't need to auth.
  const net = await import('net');
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const cleanup = () => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    };
    sock.setTimeout(2000);
    sock.once('connect', () => {
      cleanup();
      resolve({ name: 'Postgres TCP (127.0.0.1:55432)', status: 'pass', detail: 'dev profile exposed' });
    });
    sock.once('timeout', () => {
      cleanup();
      resolve({
        name: 'Postgres TCP (127.0.0.1:55432)',
        status: 'fail',
        detail: 'connection timeout',
        hint: 'Ensure docker-compose.override.yml uncomments the postgres ports block.',
      });
    });
    sock.once('error', (e) => {
      cleanup();
      resolve({
        name: 'Postgres TCP (127.0.0.1:55432)',
        status: 'fail',
        detail: e.message,
        hint: 'Ensure docker-compose.override.yml uncomments the postgres ports block.',
      });
    });
    sock.connect(55432, '127.0.0.1');
  });
}

// fix — install writes the API key into settings.json under
// CLAUDE_MEM_SERVER_BETA_API_KEY, NOT into a separate file. The old
// implementation looked for ~/.claude-mem/server-beta-api-key which never
// existed in real installs.
function checkServerBetaApiKey(): CheckResult {
  try {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    const key = (settings.CLAUDE_MEM_SERVER_BETA_API_KEY ?? '').trim();
    if (!key) {
      return {
        name: 'Server-beta API key',
        status: 'fail',
        detail: 'settings.json has empty CLAUDE_MEM_SERVER_BETA_API_KEY',
        hint: 'Re-run `npx claude-mem install --runtime server-beta` to bootstrap.',
      };
    }
    return { name: 'Server-beta API key', status: 'pass', detail: `${key.length} chars (from settings.json)` };
  } catch (e: any) {
    return {
      name: 'Server-beta API key',
      status: 'fail',
      detail: `settings.json read error: ${e?.message ?? e}`,
      hint: 'Verify ~/.claude-mem/settings.json exists and is readable.',
    };
  }
}

// fix — (a) read CLAUDE_MEM_SERVER_BETA_URL from settings.json
// instead of the UID-derived default (which points at the wrong port when
// install hardcoded 37877 in the docker stack); (b) probe /healthz, not
// /v1/health (only /healthz exists on the server).
async function checkServerBetaHttp(): Promise<CheckResult[]> {
  let url: string;
  let apiKey = '';
  try {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    url = (settings.CLAUDE_MEM_SERVER_BETA_URL ?? '').trim() || SettingsDefaultsManager.get('CLAUDE_MEM_SERVER_BETA_URL');
    apiKey = (settings.CLAUDE_MEM_SERVER_BETA_API_KEY ?? '').trim();
  } catch {
    url = SettingsDefaultsManager.get('CLAUDE_MEM_SERVER_BETA_URL');
  }
  const results: CheckResult[] = [];
  const health = await fetchWithTimeout(`${url}/healthz`);
  results.push(
    health.ok
      ? { name: 'Server-beta /healthz', status: 'pass', detail: url }
      : {
          name: 'Server-beta /healthz',
          status: 'fail',
          detail: health.err ?? `HTTP ${health.status}`,
          hint: `Server not reachable at ${url}. Check \`docker compose logs claude-mem-server\`.`,
        },
  );
  // /v1/memories/batch — Express collapses GET /v1/memories/batch to the
  // GET /v1/memories/:id route (batch becomes the id), so a GET probe matches
  // the wrong handler. POST with an empty body triggers the batch route's
  // zod validator and returns 400 (route present) or 401 (auth missing).
  // Both prove the endpoint is wired.
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 3000);
  let batchStatus = 0;
  let batchErr: string | undefined;
  try {
    const probeHeaders: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey) probeHeaders.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${url}/v1/memories/batch`, {
      method: 'POST',
      headers: probeHeaders,
      body: JSON.stringify({ ids: [] }),
      signal: ctl.signal,
    });
    batchStatus = res.status;
  } catch (e: any) {
    batchErr = e?.message ?? String(e);
  } finally {
    clearTimeout(t);
  }
  // Route-exists status codes:
  //   400 = validator rejected empty ids (route + handler reached)
  //   401 = unauthenticated  (route present, auth failed)
  //   403 = forbidden / scope missing (route present, auth ok but api key lacks
  //         memories:read scope — still proves the route is wired)
  //   2xx = accepted
  if (batchStatus === 400 || batchStatus === 401 || batchStatus === 403 || (batchStatus >= 200 && batchStatus < 300)) {
    results.push({ name: 'Endpoint /v1/memories/batch', status: 'pass', detail: `responded ${batchStatus}` });
  } else {
    results.push({
      name: 'Endpoint /v1/memories/batch',
      status: 'fail',
      detail: batchErr ?? `HTTP ${batchStatus}`,
      hint: 'Endpoint missing — server-beta build may be stale.',
    });
  }
  return results;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export async function runDoctor(): Promise<number> {
  console.log();
  console.log(pc.bold('claude-mem doctor'));
  console.log(pc.dim('───────────────────────────────────────────────'));

  // Load settings
  let runtime = 'worker';
  try {
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    runtime = settings.CLAUDE_MEM_RUNTIME || 'worker';
  } catch {
    /* defaults */
  }
  console.log(pc.dim(`runtime: ${pc.bold(runtime)}`));
  console.log(pc.dim(`data dir: ${DATA_DIR}`));
  console.log();

  const allResults: CheckResult[] = [];

  console.log(pc.bold('Common'));
  for (const r of [checkPluginInstalled(), checkPluginNodeModules(), checkBundleSizes()]) {
    printResult(r);
    allResults.push(r);
  }
  console.log();

  console.log(pc.bold('IDE MCP configs '));
  for (const r of checkIdeConfigs()) {
    printResult(r);
    allResults.push(r);
  }
  console.log();

  if (runtime === 'server-beta') {
    console.log(pc.bold('Server-beta runtime'));
    const r1 = checkDocker();
    printResult(r1);
    allResults.push(r1);
    if (r1.status === 'pass') {
      const r2 = checkComposeStack();
      printResult(r2);
      allResults.push(r2);
      const r3 = await checkPostgresReachable();
      printResult(r3);
      allResults.push(r3);
    }
    const r4 = checkServerBetaApiKey();
    printResult(r4);
    allResults.push(r4);
    for (const r of await checkServerBetaHttp()) {
      printResult(r);
      allResults.push(r);
    }
  } else {
    console.log(pc.bold('Worker runtime'));
    const checks = [checkWorkerSqlite(), checkWorkerPid(), checkChromaDir()];
    for (const r of checks) {
      printResult(r);
      allResults.push(r);
    }
    const httpResult = await checkWorkerHttp();
    printResult(httpResult);
    allResults.push(httpResult);
  }

  console.log();
  console.log(pc.dim('───────────────────────────────────────────────'));
  const pass = allResults.filter((r) => r.status === 'pass').length;
  const fail = allResults.filter((r) => r.status === 'fail').length;
  const warn = allResults.filter((r) => r.status === 'warn').length;
  const total = allResults.length;
  const summary = `${pass}/${total} passed, ${fail} failed, ${warn} warnings`;
  if (fail === 0) {
    console.log(pc.green(`✓ ${summary}`));
    console.log();
    return 0;
  }
  console.log(pc.red(`✗ ${summary}`));
  console.log();
  return 1;
}
