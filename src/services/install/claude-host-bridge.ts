// SPDX-License-Identifier: Apache-2.0
//
// / Phase 2 — Claude host-bridge launcher.
//
// On macOS the user's Claude Code OAuth credentials may live ONLY in the
// Keychain — `~/.claude/.credentials.json` doesn't exist. Bind-mounting the
// Keychain into a Docker container is not possible, so the worker container
// would have to bake in a snapshot. Snapshots go stale when the user switches
// accounts or when Claude CLI refreshes the OAuth token.
//
// The host-bridge solves this cleanly: a tiny localhost HTTP proxy on the
// host shells out to the locally-installed `claude` CLI for every generation
// request. The Docker container POSTs prompts at
// http://host.docker.internal:<port>/v1/generate. The host's `claude` CLI
// handles auth (via Keychain or .credentials.json — same as a normal
// interactive session), so:
//   - account switches propagate INSTANTLY (next request uses the new account)
//   - token refresh is automatic (CLI handles it)
//   - the user's installed CLAUDE_MEM_CLAUDE_MODEL (4.5/4.6/4.7) is what gets
//     used, NOT a frozen-at-install model
//
// Lifecycle:
//   - The bridge is a tiny Node script at ~/.claude-mem/claude-host-bridge.cjs
//     (~150 LOC).
//   - On macOS we install a launchd plist that keeps it running across
//     reboots and restarts it if it crashes.
//   - On Linux/WSL we install a systemd user unit with the same semantics.
//   - The port is allocated dynamically (ephemeral, written to .env).
//   - Authentication: shared secret in the .env; the container reads it from
//     CLAUDE_MEM_CLAUDE_BRIDGE_TOKEN and signs every request. Prevents other
//     processes on the host from accidentally using the bridge.

import { spawnSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { paths } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';

export interface HostBridgeResult {
  ok: boolean;
  bridgeUrl: string;
  bridgeToken: string;
  message: string;
}

const BRIDGE_SCRIPT_BASENAME = 'claude-host-bridge.cjs';
const LAUNCHD_LABEL = 'ai.claude-mem.host-bridge';
const SYSTEMD_UNIT_NAME = 'claude-mem-host-bridge.service';

/**
 * Idempotent: returns the existing bridge URL when the service is already
 * running, otherwise writes the script + service definition and starts it.
 */
export function ensureClaudeHostBridge(): HostBridgeResult {
  try {
    // 1. Verify `claude` CLI is on PATH — bridge can't function without it.
    if (!claudeCliReachable()) {
      return {
        ok: false,
        bridgeUrl: '',
        bridgeToken: '',
        message:
          '`claude` CLI not found on PATH — install @anthropic-ai/claude-code globally before enabling subscription auth',
      };
    }

    // 2. Prepare data dir + script + token.
    const dataDir = paths.dataDir();
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }
    const scriptPath = join(dataDir, BRIDGE_SCRIPT_BASENAME);
    const tokenPath = join(dataDir, 'host-bridge-token');

    writeFileSync(scriptPath, BRIDGE_SCRIPT_SOURCE, {
      encoding: 'utf-8',
      mode: 0o755,
    });

    let bridgeToken: string;
    if (existsSync(tokenPath)) {
      bridgeToken = readFileSync(tokenPath, 'utf-8').trim();
    } else {
      bridgeToken = randomBytes(32).toString('hex');
      writeFileSync(tokenPath, bridgeToken, {
        encoding: 'utf-8',
        mode: 0o600,
      });
    }
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      /* non-POSIX */
    }

    // 3. Allocate a port (ephemeral; first install picks 37990 by default,
    //    later installs reuse the same port).
    const portPath = join(dataDir, 'host-bridge-port');
    let port: number;
    if (existsSync(portPath)) {
      const parsed = Number.parseInt(readFileSync(portPath, 'utf-8').trim(), 10);
      port = Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : 37990;
    } else {
      port = 37990;
      writeFileSync(portPath, String(port), { encoding: 'utf-8', mode: 0o600 });
    }

    // 4. Resolve the claude CLI path NOW (not at daemon start) so launchd/
    //    systemd don't have to figure out PATH — their environments are
    //    minimal and often miss ~/.local/bin or volta shims.
    const claudePath = resolveClaudeCliPath() ?? 'claude';

    // 5. Register the service definition + start it.
    if (process.platform === 'darwin') {
      const launchResult = installLaunchdAgent(scriptPath, port, tokenPath, claudePath);
      if (!launchResult.ok) {
        return {
          ok: false,
          bridgeUrl: '',
          bridgeToken: '',
          message: `failed to install launchd agent: ${launchResult.message}`,
        };
      }
    } else if (process.platform === 'linux') {
      const systemdResult = installSystemdUnit(scriptPath, port, tokenPath, claudePath);
      if (!systemdResult.ok) {
        return {
          ok: false,
          bridgeUrl: '',
          bridgeToken: '',
          message: `failed to install systemd user unit: ${systemdResult.message}`,
        };
      }
    } else {
      return {
        ok: false,
        bridgeUrl: '',
        bridgeToken: '',
        message: `host-bridge auto-install not supported on ${process.platform} — run the bridge manually: node ${scriptPath} --port ${port} --token <see ${tokenPath}>`,
      };
    }

    // 5. Wait briefly for the bridge to bind and verify it answers.
    const reachable = waitForBridge(port, 6000);
    if (!reachable.ok) {
      return {
        ok: false,
        bridgeUrl: '',
        bridgeToken: '',
        message: `bridge service started but is not answering on 127.0.0.1:${port} (${reachable.message})`,
      };
    }

    return {
      ok: true,
      bridgeUrl: `http://host.docker.internal:${port}`,
      bridgeToken,
      message: `Bridge running on 127.0.0.1:${port}; container connects via host.docker.internal`,
    };
  } catch (err) {
    return {
      ok: false,
      bridgeUrl: '',
      bridgeToken: '',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// Tear down the host-bridge so uninstall doesn't leave a running service
// pointing at a stale token. Idempotent — safe to call when nothing is
// installed. Returns ok:true even when nothing was removed so the caller's
// rollback flow doesn't fail on first-time uninstalls.
export function stopClaudeHostBridge(): { ok: boolean; message: string; removedFiles: string[] } {
  const removedFiles: string[] = [];
  const home = homedir();

  try {
    if (process.platform === 'darwin') {
      const plistPath = join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
      if (existsSync(plistPath)) {
        spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
        try {
          unlinkSync(plistPath);
          removedFiles.push(plistPath);
        } catch { /* already gone */ }
      }
    } else if (process.platform === 'linux') {
      const unitDir = join(home, '.config', 'systemd', 'user');
      const unitPath = join(unitDir, SYSTEMD_UNIT_NAME);
      if (existsSync(unitPath)) {
        spawnSync('systemctl', ['--user', 'stop', SYSTEMD_UNIT_NAME], { stdio: 'ignore' });
        spawnSync('systemctl', ['--user', 'disable', SYSTEMD_UNIT_NAME], { stdio: 'ignore' });
        try {
          unlinkSync(unitPath);
          removedFiles.push(unitPath);
        } catch { /* already gone */ }
        spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
      }
    }
    // Token + port files live in paths.dataDir(); remove them too so a
    // future install starts from a clean state.
    const tokenPath = join(paths.dataDir(), 'host-bridge-token');
    const portPath = join(paths.dataDir(), 'host-bridge-port');
    for (const f of [tokenPath, portPath]) {
      if (existsSync(f)) {
        try { unlinkSync(f); removedFiles.push(f); } catch { /* */ }
      }
    }
    return {
      ok: true,
      message: removedFiles.length
        ? `host-bridge stopped; removed ${removedFiles.length} file(s)`
        : 'host-bridge was not installed',
      removedFiles,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      removedFiles,
    };
  }
}

function claudeCliReachable(): boolean {
  return resolveClaudeCliPath() !== null;
}

// Returns the absolute path to the host's `claude` binary, or null when
// not on PATH. Used at install time so the daemon ExecStart references
// the binary directly — launchd/systemd start with a minimal PATH and
// won't find binaries in non-standard locations like ~/.local/bin.
function resolveClaudeCliPath(): string | null {
  try {
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (which.status !== 0) return null;
    const out = (which.stdout ?? '').trim();
    if (!out) return null;
    return out.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

function installLaunchdAgent(
  scriptPath: string,
  port: number,
  tokenPath: string,
  claudePath: string,
): { ok: boolean; message: string } {
  const home = homedir();
  const agentsDir = join(home, 'Library', 'LaunchAgents');
  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
  }
  const plistPath = join(agentsDir, `${LAUNCHD_LABEL}.plist`);
  const logPath = join(paths.logsDir(), 'host-bridge.log');
  if (!existsSync(paths.logsDir())) {
    mkdirSync(paths.logsDir(), { recursive: true });
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${scriptPath}</string>
    <string>--port</string>
    <string>${port}</string>
    <string>--token-file</string>
    <string>${tokenPath}</string>
    <string>--claude-path</string>
    <string>${claudePath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${dirname(claudePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
  try {
    writeFileSync(plistPath, plist, { encoding: 'utf-8', mode: 0o600 });
    // Unload first so changes to the plist (script path, port) take effect.
    spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    const load = spawnSync('launchctl', ['load', plistPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    if (load.status !== 0) {
      return {
        ok: false,
        message: `launchctl load returned ${load.status}: ${(load.stderr ?? '').trim() || '(no stderr)'}`,
      };
    }
    return { ok: true, message: `launchd agent ${LAUNCHD_LABEL} loaded` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function installSystemdUnit(
  scriptPath: string,
  port: number,
  tokenPath: string,
  claudePath: string,
): { ok: boolean; message: string } {
  const home = homedir();
  const unitDir = join(home, '.config', 'systemd', 'user');
  if (!existsSync(unitDir)) {
    mkdirSync(unitDir, { recursive: true });
  }
  const unitPath = join(unitDir, SYSTEMD_UNIT_NAME);

  const unit = `[Unit]
Description=claude-mem Claude CLI host-bridge
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${scriptPath} --port ${port} --token-file ${tokenPath} --claude-path ${claudePath}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
  try {
    writeFileSync(unitPath, unit, { encoding: 'utf-8', mode: 0o600 });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    spawnSync('systemctl', ['--user', 'enable', SYSTEMD_UNIT_NAME], { stdio: 'ignore' });
    const start = spawnSync('systemctl', ['--user', 'restart', SYSTEMD_UNIT_NAME], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    if (start.status !== 0) {
      return {
        ok: false,
        message: `systemctl restart returned ${start.status}: ${(start.stderr ?? '').trim() || '(no stderr)'}`,
      };
    }
    return { ok: true, message: `systemd user unit ${SYSTEMD_UNIT_NAME} active` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function waitForBridge(port: number, timeoutMs: number): { ok: boolean; message: string } {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';
  while (Date.now() < deadline) {
    // Probe /healthz via a worker thread that uses Node's built-in http
    // module. Avoids depending on `curl`, which is absent by default on
    // Debian/Ubuntu minimal, Alpine, and many WSL images — those installs
    // previously failed silently here even when the bridge process started
    // successfully.
    const probeScript = `
      const http = require('http');
      const req = http.get('http://127.0.0.1:${port}/healthz', { timeout: 1500 }, (res) => {
        const code = res.statusCode || 0;
        res.resume();
        process.stdout.write(String(code));
        process.exit(0);
      });
      req.on('timeout', () => { req.destroy(); process.stdout.write('timeout'); process.exit(0); });
      req.on('error', (err) => { process.stdout.write('error:' + err.message); process.exit(0); });
    `;
    const probe = spawnSync(process.execPath, ['-e', probeScript], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = (probe.stdout ?? '').trim();
    if (result === '200') {
      return { ok: true, message: 'healthz returned 200' };
    }
    if (result.startsWith('error:') || result === '' || result === 'timeout') {
      lastError = result || 'timeout';
    } else {
      lastError = `healthz returned ${result}`;
    }
    // Poll loop without `await`: install code runs synchronously.
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),200)'], {
      stdio: 'ignore',
    });
  }
  return { ok: false, message: lastError };
}

// ─────────────────────────────────────────────────────────────────────────────
// The bridge script itself. Embedded here as a string template so the install
// flow can drop a fresh copy on every install (idempotent). The script is a
// standalone Node program — no dependencies on the rest of the codebase —
// so it stays small and self-contained.
// ─────────────────────────────────────────────────────────────────────────────

const BRIDGE_SCRIPT_SOURCE = `#!/usr/bin/env node
// claude-mem Claude host-bridge — see src/services/install/claude-host-bridge.ts.
// Listens on 127.0.0.1:<port> and accepts authenticated POST /v1/generate
// requests. Shells out to the local 'claude' CLI for each request so the
// host's current account, token, and model selection are always used.

const http = require('http');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
function flag(name) {
  const idx = args.indexOf('--' + name);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const PORT = Number.parseInt(flag('port') || '37990', 10);
// Token is read from a file rather than passed as a CLI argument so it
// doesn't show up in 'ps' / /proc/<pid>/cmdline for any local user.
// --token <value> still works for back-compat but logs a warning.
const TOKEN_FILE = flag('token-file') || '';
let TOKEN = '';
if (TOKEN_FILE) {
  try {
    TOKEN = require('fs').readFileSync(TOKEN_FILE, 'utf-8').trim();
  } catch (err) {
    console.error('[host-bridge] failed to read --token-file:', err && err.message);
    process.exit(2);
  }
} else {
  TOKEN = flag('token') || '';
  if (TOKEN) {
    console.error('[host-bridge] WARN: --token via CLI arg is visible in ps; prefer --token-file');
  }
}
// Resolved at install time so the daemon doesn't have to figure out PATH.
// Defaults to 'claude' if not provided — will work when on PATH, otherwise
// returns a clear ENOENT.
const CLAUDE_BIN = flag('claude-path') || 'claude';
if (!TOKEN) {
  console.error('[host-bridge] --token-file or --token is required');
  process.exit(2);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function handleGenerate(req, res) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== TOKEN) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'ValidationError', message: 'invalid JSON body' }));
    return;
  }
  const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : '';
  const model = typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : undefined;
  if (!prompt) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'ValidationError', message: 'prompt required' }));
    return;
  }

  // Invoke the local claude CLI in non-interactive mode. The CLI handles
  // auth via Keychain / .credentials.json transparently.
  const cliArgs = ['--print', '--output-format', 'text'];
  if (model) cliArgs.push('--model', model);
  const child = spawn(CLAUDE_BIN, cliArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString('utf-8'); });
  child.stderr.on('data', (c) => { stderr += c.toString('utf-8'); });
  child.on('error', (err) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'BridgeError', message: 'failed to spawn claude: ' + err.message }));
  });
  child.on('exit', (code) => {
    if (code !== 0) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: 'ClaudeCliError',
        exitCode: code,
        stderr: stderr.slice(-2000),
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text: stdout }));
  });
  child.stdin.end(prompt);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, runtime: 'host-bridge' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/generate') {
    await handleGenerate(req, res);
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'NotFound' }));
});
server.listen(PORT, '127.0.0.1', () => {
  console.log('[host-bridge] listening on 127.0.0.1:' + PORT);
});
`;
