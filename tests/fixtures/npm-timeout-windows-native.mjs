import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.platform, 'win32', 'this fixture requires actual Windows');
const [helperPath, mode = 'hang'] = process.argv.slice(2);
assert.ok(['hang', 'success', 'error', 'kill-failure'].includes(mode));
const root = mkdtempSync(join(tmpdir(), 'cmem windows npm timeout '));
const fixturePath = join(root, 'owned-npm-fixture.cjs');
const pidFile = join(root, 'owned-npm.pid');
const taskkillPath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
const originalExecFile = childProcess.execFile;
let observed;
let pid;
let settled = false;

function identity(pid) {
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p | Select-Object ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress }`],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5000 });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  return JSON.parse(result.stdout);
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function cleanupOwnedFixture() {
  if (!pid || !alive(pid)) return;
  const before = identity(pid);
  if (!before?.CommandLine?.includes(fixturePath)) return;
  const current = identity(pid);
  if (!current || current.CreationDate !== before.CreationDate || !current.CommandLine?.includes(fixturePath)) return;
  childProcess.spawnSync(taskkillPath, ['/PID', String(pid), '/T', '/F'],
    { windowsHide: true, shell: false, timeout: 5000, stdio: 'ignore' });
}

const oldPath = process.env.PATH;
const oldTimeout = process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS;
let observationTimer;
try {
  writeFileSync(fixturePath, `const fs=require('node:fs');\nfs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));\nconsole.log('owned npm stdout');console.error('owned npm stderr');\nconst mode=process.argv[2];\nif(mode==='success')process.exit(0);else if(mode==='error')process.exit(23);else setInterval(()=>{},100);\n`);
  writeFileSync(join(root, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`);
  process.env.PATH = root + ';' + oldPath;
  process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = '1000';
  if (mode === 'kill-failure') {
    // Only the utility failure is injected. npm/cmd.exe and the retained pipes are native.
    childProcess.execFile = (command, args, options, callback) => {
      if (command !== 'taskkill') return originalExecFile(command, args, options, callback);
      queueMicrotask(() => callback(Object.assign(new Error('owned taskkill unavailable fixture'), { code: 'ENOENT' })));
      return new childProcess.ChildProcess();
    };
    syncBuiltinESMExports();
  }
  const { runNpmStrict } = await import(pathToFileURL(helperPath).href);
  const start = performance.now();
  const resultPromise = runNpmStrict(root, [mode]).then(result => { settled = true; return result; });
  const result = await Promise.race([resultPromise, new Promise(resolve => {
    observationTimer = setTimeout(() => resolve(null), 4000);
  })]);
  pid = Number(readFileSync(pidFile, 'utf8'));
  const descendantAlive = alive(pid);
  observed = { platform: process.platform, node: process.version, mode, elapsedMs: performance.now() - start,
    settled, descendantAlive, result, fixturePid: pid, utilityFailureInjected: mode === 'kill-failure' };
  console.log(JSON.stringify(observed));
  assert.ok(result, 'timeout must settle while the descendant retains the output pipes');
  if (mode === 'success' || mode === 'error') {
    assert.equal(result.timedOut, false);
    assert.equal(result.code, mode === 'success' ? 0 : 23);
  } else {
    assert.equal(result.timedOut, true);
    assert.equal(result.code, 124);
    assert.ok(observed.elapsedMs < 3500, 'settlement must stay bounded by timeout and grace');
    if (mode === 'hang') assert.equal(descendantAlive, false, 'native taskkill must terminate npm too');
    else assert.match(result.stderr, /owned taskkill unavailable fixture/);
  }
  assert.match(result.stdout, /owned npm stdout/);
  assert.match(result.stderr, /owned npm stderr/);
} finally {
  clearTimeout(observationTimer);
  if (!pid) { try { pid = Number(readFileSync(pidFile, 'utf8')); } catch {} }
  cleanupOwnedFixture();
  childProcess.execFile = originalExecFile;
  syncBuiltinESMExports();
  if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  if (oldTimeout === undefined) delete process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS; else process.env.CLAUDE_MEM_INSTALL_TIMEOUT_MS = oldTimeout;
  rmSync(root, { recursive: true, force: true });
}
