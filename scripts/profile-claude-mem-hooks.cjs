'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, '.local', 'hook-profiles');
const PORT = 37877;
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const NODE = process.versions.bun ? 'node' : process.execPath;
const BUN = process.env.BUN || path.join(os.homedir(), '.bun', 'bin', 'bun.exe');
const MAX_CAPTURE = 2 * 1024 * 1024;

const hookSpecs = [
  { hook: 'SessionStart', handler: 'context', event: 'SessionStart', expectRoute: '/api/context/inject', expectOutput: 'PROFILE_TIMELINE_CONTEXT' },
  { hook: 'UserPromptSubmit', handler: 'session-init', event: 'UserPromptSubmit', expectRoute: '/api/sessions/init' },
  { hook: 'PreToolUse', handler: 'file-context', event: 'PreToolUse', expectRoute: '/api/observations/by-file', expectOutput: 'PROFILE_FILE_HISTORY' },
  { hook: 'PostToolUse', handler: 'observation', event: 'PostToolUse', expectRoute: '/api/spool/nudge', expectSpool: true },
  { hook: 'Stop', handler: 'summarize', event: 'Stop', expectRoute: '/api/spool/nudge', expectSpool: true },
  { hook: 'PostCompact', handler: 'post-compact', event: 'PostCompact', postCompact: true },
  { hook: 'SubagentStart', handler: 'subagent-context', event: 'SubagentStart', expectRoute: '/api/context/inject', expectOutput: 'PROFILE_TIMELINE_CONTEXT' },
];

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function cpuSnapshot() {
  return os.cpus().reduce((sum, cpu) => ({ total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0), idle: sum.idle + cpu.times.idle }), { total: 0, idle: 0 });
}

function cpuPercent(before, after) {
  const total = after.total - before.total;
  return total > 0 ? Math.round(Math.max(0, Math.min(100, 100 * (1 - (after.idle - before.idle) / total))) * 10) / 10 : null;
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function filesUnder(root, predicate, result = []) {
  if (!fs.existsSync(root)) return result;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) filesUnder(file, predicate, result);
    else if (predicate(file)) result.push(file);
  }
  return result;
}

function hasExited(child) { return child.exitCode !== null || child.signalCode !== null; }

async function killOwnedTree(child, timeoutMs = 15000) {
  if (!child || typeof child.kill !== 'function') throw new Error('cleanup requires the owned ChildProcess');
  // An exited child no longer owns its old PID. Never target it again.
  if (hasExited(child)) return { attempted: false, exited: true };
  const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
    ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  const outcome = await new Promise(resolve => {
    let done = false;
    const finish = result => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { killer.kill(); finish({ timedOut: true }); }, timeoutMs);
    killer.once('error', error => finish({ error: error.message }));
    killer.once('exit', code => finish({ taskkillCode: code }));
  });
  if (!hasExited(child)) await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  return { attempted: true, ...outcome, exited: hasExited(child) };
}

async function runChild({ file, args, cwd, env, input, timeoutMs }) {
  return new Promise(resolve => {
    const started = process.hrtime.bigint();
    const child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const pid = child.pid;
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), overflow = false, settled = false, finishing = false, timedOut = false, timer;
    let exitElapsedMs = null, timeoutElapsedMs = null, closed = false, cleanupPromise = null;
    let closeResolve;
    const closePromise = new Promise(resolveClose => { closeResolve = resolveClose; });
    const append = (current, chunk) => {
      if (current.length >= MAX_CAPTURE) { overflow = true; return current; }
      const room = MAX_CAPTURE - current.length;
      if (chunk.length > room) overflow = true;
      return Buffer.concat([current, chunk.subarray(0, room)]);
    };
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const finish = async (exitCode, signal, spawnFailure) => {
      if (settled || finishing) return;
      finishing = true;
      if (timer) clearTimeout(timer);
      const cleanup = cleanupPromise ? await cleanupPromise : spawnFailure;
      if (!closed && !spawnFailure) await Promise.race([closePromise, sleep(2000)]);
      settled = true;
      try { child.stdin.destroy(); } catch {}
      child.stdout.destroy(); child.stderr.destroy();
      const cleanupFailed = (!closed && !spawnFailure) || cleanup?.exited === false || !!(cleanup?.attempted && (cleanup.timedOut || cleanup.error || cleanup.taskkillCode !== 0));
      if (cleanupFailed) child.unref();
      resolve({ pid, exitCode, signal, timedOut, cleanup, cleanupFailed, overflow,
        elapsedMs: (timedOut ? timeoutElapsedMs : exitElapsedMs) ?? Number(process.hrtime.bigint() - started) / 1e6,
        cleanupElapsedMs: timedOut ? Number(process.hrtime.bigint() - started) / 1e6 - timeoutElapsedMs : 0,
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    };
    child.once('error', error => finish(null, null, { spawnError: error.message }));
    child.once('exit', () => { exitElapsedMs = Number(process.hrtime.bigint() - started) / 1e6; });
    child.once('close', (code, signal) => { closed = true; closeResolve(); void finish(code, signal, null); });
    child.stdin.on('error', () => {});
    child.stdin.write(input);
    // Flush is implicit in Node's pipe write. Intentionally keep stdin open
    // until the hook exits, matching the host callback behavior under test.
    timer = setTimeout(async () => {
      timedOut = true;
      timeoutElapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      cleanupPromise = killOwnedTree(child);
      await cleanupPromise;
      void finish(child.exitCode, 'TIMEOUT', null);
    }, Math.max(0, timeoutMs - Number(process.hrtime.bigint() - started) / 1e6));
  });
}

async function startFixture(runDir, nonce) {
  const ready = path.join(runDir, 'fixture-ready.json');
  const error = path.join(runDir, 'fixture-error.json');
  for (const file of [ready, error]) { try { fs.unlinkSync(file); } catch {} }
  const child = spawn(NODE, [path.join(__dirname, 'profile-claude-mem-hooks-fixture.cjs'), runDir, nonce, String(PORT)], {
    cwd: runDir, windowsHide: true, stdio: 'ignore'
  });
  let spawnError = null;
  child.once('error', error => { spawnError = error; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(error)) {
      const detail = fs.readFileSync(error, 'utf8');
      await killOwnedTree(child);
      throw new Error(`fixture bind failed: ${detail}`);
    }
    if (fs.existsSync(ready)) {
      const record = JSON.parse(fs.readFileSync(ready, 'utf8'));
      if (record.nonce !== nonce || record.pid !== child.pid || record.port !== PORT) {
        await killOwnedTree(child);
        throw new Error('fixture readiness identity mismatch');
      }
      return { child, ready: record, evidencePath: path.join(runDir, 'fixture-requests.jsonl') };
    }
    if (spawnError) throw spawnError;
    if (hasExited(child)) throw new Error(`fixture exited before readiness (${child.exitCode})`);
    await sleep(25);
  }
  await killOwnedTree(child);
  throw new Error('fixture did not become ready within 15 seconds');
}

function extractEntries(manifest) {
  const result = {};
  for (const spec of hookSpecs) {
    const entry = manifest.hooks?.[spec.hook]?.[0]?.hooks?.[0];
    if (!entry || typeof entry.commandWindows !== 'string' || !Number.isFinite(entry.timeout)) {
      throw new Error(`manifest entry missing for ${spec.hook}`);
    }
    result[spec.hook] = { commandWindows: entry.commandWindows, deadlineMs: entry.timeout * 1000 };
  }
  return result;
}

function payload(spec, projectDir, sampleDir, id) {
  const common = { session_id: `profile-session-${id}`, cwd: projectDir, hook_event_name: spec.event };
  if (spec.hook === 'SessionStart') return { ...common, source: 'startup' };
  if (spec.hook === 'UserPromptSubmit') return { ...common, prompt: `Profile semantic context ${id}`, transcript_path: path.join(sampleDir, 'transcript.jsonl') };
  if (spec.hook === 'PreToolUse') return { ...common, tool_name: 'mcp__profile__read_file', tool_input: { path: path.join(projectDir, 'profile-input.txt') } };
  if (spec.hook === 'PostToolUse') return { ...common, tool_name: 'mcp__profile__read_file', tool_input: { path: path.join(projectDir, 'profile-input.txt') }, tool_response: { content: `response-${id}` }, tool_use_id: `tool-${id}` };
  if (spec.hook === 'Stop') return { ...common, last_assistant_message: `Synthetic completion ${id}`, transcript_path: path.join(sampleDir, 'transcript.jsonl'), stop_hook_active: false };
  if (spec.hook === 'PostCompact') return common;
  return { ...common, agent_id: `subagent-${id}`, agent_type: 'explore' };
}

function parseOutput(text) {
  const trimmed = text.trim();
  if (!trimmed) return { validJson: false, parsed: null, reason: 'empty stdout' };
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { validJson: true, parsed, reason: null }
      : { validJson: false, parsed, reason: 'stdout JSON is not an object' };
  } catch (error) { return { validJson: false, parsed: null, reason: `malformed stdout JSON: ${error.message}` }; }
}

function aggregate(hook, samples, deadlineMs) {
  const validTimes = samples.filter(s => s.valid).map(s => s.elapsedMs).sort((a, b) => a - b);
  const median = validTimes.length ? validTimes[Math.floor(validTimes.length / 2)] : null;
  return {
    hook, deadlineMs, sampleCount: samples.length, validCount: validTimes.length,
    invalids: samples.filter(s => !s.valid).length,
    deadlineBreaches: samples.filter(s => s.timedOut || s.elapsedMs > deadlineMs).length,
    violations: samples.flatMap(s => s.violations),
    minMs: validTimes.length ? validTimes[0] : null, medianMs: median,
    maxMs: validTimes.length ? validTimes[validTimes.length - 1] : null,
    samples
  };
}

function childEnvironment(overrides, inherited = process.env) {
  const allowed = /^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|USERNAME|USERDOMAIN)$/i;
  return { ...Object.fromEntries(Object.entries(inherited).filter(([key]) => allowed.test(key))),
    CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_WORKER_AUTOSTART: 'false', ...overrides };
}

function validateRaw(raw, output) {
  const violations = [];
  if (raw.exitCode !== 0) violations.push(`exit code ${raw.exitCode}`);
  if (raw.timedOut) violations.push('profiler hard timeout');
  if (raw.cleanupFailed) violations.push('owned process cleanup failed');
  if (raw.overflow) violations.push('output capture limit exceeded');
  if (!output.validJson) violations.push(output.reason);
  if (/hook error|uncaught|unhandled|exception/i.test(raw.stderr)) violations.push('error diagnostic on stderr');
  return violations;
}

async function main(argv = process.argv.slice(2)) {
  const sampleArg = argv.indexOf('--samples');
  const samplesPerHook = sampleArg >= 0 ? Number(argv[sampleArg + 1]) : 3;
  if (!Number.isInteger(samplesPerHook) || samplesPerHook < 3) throw new Error('--samples must be an integer of at least 3');
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  let state, incremental;
  const publishStatus = (status, extra = {}) => {
    for (const name of ['before.json', 'after.json', 'report.json']) atomicJson(path.join(OUT, name), {
      schemaVersion: 2, runId, status, generatedAt: new Date().toISOString(), ...extra,
    });
  };
  publishStatus('preparing');
  try {
  const markerPath = path.join(OUT, 'parent-build-ready.json');
  if (!fs.existsSync(markerPath)) throw new Error(`parent marker absent: ${markerPath}`);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const sourceManifest = marker.manifest.path;
  const expected = [marker.baseline.runner, marker.baseline.worker, marker.optimized.runner, marker.optimized.worker, marker.optimized.hook, marker.manifest];
  for (const item of expected) if (sha256(item.path) !== item.sha256) throw new Error(`parent artifact hash mismatch: ${item.path}`);

  const runDir = path.join(OUT, `run-${runId}`);
  fs.mkdirSync(runDir, { recursive: true });
  const manifestSnapshot = path.join(runDir, 'codex-hooks.json');
  fs.copyFileSync(sourceManifest, manifestSnapshot);
  const manifestBytes = fs.readFileSync(manifestSnapshot);
  if (crypto.createHash('sha256').update(manifestBytes).digest('hex') !== marker.manifest.sha256) throw new Error('frozen manifest copy hash mismatch');
  const entries = extractEntries(JSON.parse(manifestBytes.toString('utf8')));

  const variants = {
    baseline: { runner: marker.baseline.runner, worker: marker.baseline.worker },
    optimized: { runner: marker.optimized.runner, worker: marker.optimized.worker, hook: marker.optimized.hook },
  };
  for (const [name, variant] of Object.entries(variants)) {
    const install = path.join(runDir, 'installs', name);
    const scripts = path.join(install, 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    fs.copyFileSync(variant.runner.path, path.join(scripts, 'bun-runner.js'));
    fs.copyFileSync(variant.worker.path, path.join(scripts, 'worker-service.cjs'));
    if (variant.hook) fs.copyFileSync(variant.hook.path, path.join(scripts, 'hook-service.cjs'));
    fs.copyFileSync(path.join(REPO, 'plugin', 'package.json'), path.join(install, 'package.json'));
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(install, 'node_modules'), 'junction');
    variant.install = install;
    variant.hashes = Object.fromEntries(filesUnder(scripts, () => true).map(file => [path.basename(file), sha256(file)]));
  }

  const nonce = crypto.randomBytes(12).toString('hex');
  const fixture = await startFixture(runDir, nonce);
  state = { schemaVersion: 2, status: 'running', runId, startedAt: new Date().toISOString(), completedSamples: 0, samplesPerHook, samples: { baseline: {}, optimized: {} } };
  incremental = path.join(runDir, 'incremental.json');
  atomicJson(incremental, state);
  publishStatus('running', { incremental });
  try {
    for (const spec of hookSpecs) {
      for (let index = 0; index < samplesPerHook; index++) {
        // Interleave paired variants for each sample index to reduce load-order bias.
        for (const variantName of index % 2 === 0 ? ['baseline', 'optimized'] : ['optimized', 'baseline']) {
          const variant = variants[variantName];
          const id = `${spec.hook}-${index}-${variantName}-${crypto.randomBytes(5).toString('hex')}`;
          const sampleDir = path.join(runDir, 'samples', id);
          const projectDir = path.join(sampleDir, 'project');
          const dataDir = path.join(sampleDir, 'data');
          const configDir = path.join(sampleDir, 'claude-config');
          fs.mkdirSync(projectDir, { recursive: true }); fs.mkdirSync(dataDir); fs.mkdirSync(configDir);
          fs.writeFileSync(path.join(projectDir, 'profile-input.txt'), 'x'.repeat(2048));
          fs.writeFileSync(path.join(sampleDir, 'transcript.jsonl'), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Synthetic ${id}` }] } }) + '\n');
          fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
            CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_WORKER_AUTOSTART: 'false',
            CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(PORT),
            CLAUDE_MEM_CONTEXT_SHOW_TERMINAL_OUTPUT: 'false', CLAUDE_MEM_CONTEXT_SHOW_LAST_MESSAGE: 'false',
            CLAUDE_MEM_SEMANTIC_INJECT: 'true', CLAUDE_MEM_TELEMETRY: 'false', CLAUDE_MEM_PROVIDER: 'none'
          }));
          const entry = entries[spec.hook];
          const commandFile = path.join(sampleDir, `${spec.hook}.command.ps1`);
          // Preserve every commandWindows byte, then add only a shell-status wrapper.
          fs.writeFileSync(commandFile, entry.commandWindows + '\r\nexit $LASTEXITCODE\r\n', 'utf8');
          const env = childEnvironment({ CLAUDE_PLUGIN_ROOT: variant.install, PLUGIN_ROOT: '', CLAUDE_CONFIG_DIR: configDir,
            CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_WORKER_HOST: '127.0.0.1', CLAUDE_MEM_WORKER_PORT: String(PORT),
            CLAUDE_MEM_TELEMETRY: 'false', DO_NOT_TRACK: '1', BUN, CLAUDE_MEM_INTERNAL: '',
            CLAUDE_MEM_DISABLE_TOOL_HOOKS: '', CLAUDE_MEM_DISABLE_FILE_CONTEXT: '', CLAUDE_MEM_DISABLE_OBSERVATION: '' });
          const hookPayload = payload(spec, projectDir, sampleDir, id);
          const matcher = JSON.parse(manifestBytes).hooks[spec.hook][0].matcher;
          if (spec.hook === 'PreToolUse' && matcher && matcher !== '*' && !new RegExp(matcher).test(hookPayload.tool_name)) throw new Error('synthetic tool does not match frozen PreToolUse matcher');
          const requestsBefore = readJsonLines(fixture.evidencePath).length;
          const cpuBefore = cpuSnapshot();
          const raw = await runChild({ file: POWERSHELL, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', commandFile], cwd: projectDir, env,
            input: JSON.stringify(hookPayload), timeoutMs: entry.deadlineMs + 3000 });
          const observedCpuPercent = cpuPercent(cpuBefore, cpuSnapshot());
          if (raw.cleanupFailed) throw new Error(`cleanup failed for owned child ${raw.pid}; aborting before any further callback`);
          let evidence = readJsonLines(fixture.evidencePath).slice(requestsBefore);
          const output = parseOutput(raw.stdout);
          const spoolFiles = filesUnder(path.join(dataDir, 'state', 'hook-spool'), file => file.endsWith('.json')).filter(file => {
            const record = JSON.parse(fs.readFileSync(file, 'utf8'));
            return record.kind === spec.handler && record.payload?.contentSessionId === hookPayload.session_id;
          });
          const markerFiles = filesUnder(dataDir, file => /codex-compaction-pending/i.test(file));
          const violations = validateRaw(raw, output);
          if (spec.expectRoute && !evidence.some(r => r.url.startsWith(spec.expectRoute))) violations.push(`missing fixture route ${spec.expectRoute}`);
          if (spec.expectOutput && !output.parsed?.hookSpecificOutput?.additionalContext?.includes(spec.expectOutput)) violations.push(`missing model-context marker ${spec.expectOutput}`);
          if (spec.expectSpool && spoolFiles.length === 0) violations.push('missing durable spool evidence');
          let postCompactProof = null;
          if (spec.postCompact) {
            if (markerFiles.length === 0) violations.push('PostCompact did not create a durable pending marker');
            const proofSpec = hookSpecs.find(s => s.hook === 'PostToolUse');
            const proofEntry = entries.PostToolUse;
            const beforeProof = readJsonLines(fixture.evidencePath).length;
            // Verify the pending gate through the real handler without timing a
            // second Windows launcher. This is functional proof, not a hook
            // latency sample; the PostCompact timing above is unchanged.
            const proofBudgetMs = 30_000;
            const proofRaw = await runChild({ file: BUN, args: [path.join(variant.install, 'scripts', variant.hook ? 'hook-service.cjs' : 'worker-service.cjs'), 'hook', 'codex', 'observation'], cwd: os.tmpdir(),
              env: { ...env, CLAUDE_MEM_HOOK_ORIGINAL_CWD: projectDir }, input: JSON.stringify(payload(proofSpec, projectDir, sampleDir, id)), timeoutMs: proofBudgetMs });
            if (proofRaw.cleanupFailed) throw new Error(`cleanup failed for owned proof child ${proofRaw.pid}`);
            const proofEvidence = readJsonLines(fixture.evidencePath).slice(beforeProof);
            const markerAfter = filesUnder(dataDir, file => /codex-compaction-pending/i.test(file));
            const proofOutput = parseOutput(proofRaw.stdout);
            const proofViolations = validateRaw(proofRaw, proofOutput);
            if (proofRaw.elapsedMs > proofBudgetMs) proofViolations.push('functional proof exceeded its budget');
            postCompactProof = { exitCode: proofRaw.exitCode, timedOut: proofRaw.timedOut, stdout: proofRaw.stdout,
              method: 'direct Bun hook CLI; excluded from native-command latency', budgetMs: proofBudgetMs,
              validJson: proofOutput.validJson, elapsedMs: proofRaw.elapsedMs, violations: proofViolations,
              contextRequested: proofEvidence.some(r => r.url.startsWith('/api/context/inject')),
              timelineInjected: !!proofOutput.parsed?.hookSpecificOutput?.additionalContext?.includes('PROFILE_TIMELINE_CONTEXT'), markerConsumed: markerAfter.length === 0 };
            if (proofViolations.length || !postCompactProof.contextRequested || !postCompactProof.timelineInjected || !postCompactProof.markerConsumed) {
              violations.push('PostCompact pending gate did not affect exactly the next read-capable callback');
            }
            evidence = evidence.concat(proofEvidence);
          }
          const sample = { index, id, elapsedMs: Math.round(raw.elapsedMs * 10) / 10, exitCode: raw.exitCode, timedOut: raw.timedOut,
            cpuPercent: observedCpuPercent, cpuWindowIncludesCleanup: raw.timedOut,
            deadlineMs: entry.deadlineMs, validJson: output.validJson, valid: violations.length === 0, violations,
            stdout: raw.stdout, stderr: raw.stderr, fixtureEvidence: evidence, spoolFiles: spoolFiles.map(f => path.relative(sampleDir, f)),
            pendingMarkersBeforeProof: markerFiles.map(f => path.relative(sampleDir, f)), postCompactProof, cleanup: raw.cleanup, cleanupElapsedMs: raw.cleanupElapsedMs };
          (state.samples[variantName][spec.hook] ||= []).push(sample);
          state.completedSamples++;
          atomicJson(incremental, state);
          process.stdout.write(JSON.stringify({ hook: spec.hook, variant: variantName, index, elapsedMs: sample.elapsedMs, valid: sample.valid, violations }) + '\n');
          if (raw.cleanupFailed) throw new Error(`cleanup failed for owned child ${raw.pid}; aborting to avoid overlapping samples`);
        }
      }
    }
  } finally {
    const cleanup = await killOwnedTree(fixture.child);
    if (!cleanup.exited || (cleanup.attempted && cleanup.taskkillCode !== 0)) throw new Error(`fixture cleanup failed for owned child ${fixture.child.pid}`);
  }

  for (const item of expected) if (sha256(item.path) !== item.sha256) throw new Error(`parent artifact changed during run: ${item.path}`);
  const provenance = { markerPath, markerSha256: sha256(markerPath), manifest: { source: sourceManifest, frozenCopy: manifestSnapshot, sha256: sha256(manifestSnapshot) },
    machine: { platform: process.platform, release: os.release(), logicalCpus: os.cpus().length, node: process.version, cpuMeasure: 'approximate utilization from os.cpus() deltas during each sample' },
    shell: 'Windows PowerShell 5.1', callbackClaim: 'synthetic isolated invocation of exact Codex manifest commandWindows; not a native Codex callback',
    stdin: 'complete JSON written and flushed to pipe; stdin kept open until child exit', fixture: { origin: `http://127.0.0.1:${PORT}`, pid: fixture.ready.pid, nonce },
    variants: Object.fromEntries(Object.entries(variants).map(([name, v]) => [name, { install: v.install, hashes: v.hashes }])) };
  const limitations = ['Machine had earlier 100% CPU readings; per-sample counter estimates describe load during this run.', 'Runs are synthetic Windows PowerShell 5.1 manifest-command invocations, not native Codex callbacks.', 'No live memory database, provider, credentials, or external network was used.', 'Medians are descriptive only; this report does not claim statistically significant speedup.'];
  const docs = {};
  for (const variantName of Object.keys(variants)) {
    const hooks = hookSpecs.map(spec => aggregate(spec.hook, state.samples[variantName][spec.hook] || [], entries[spec.hook].deadlineMs));
    docs[variantName] = { schemaVersion: 2, status: hooks.some(h => h.invalids) ? 'complete-with-invalid-samples' : hooks.some(h => h.deadlineBreaches) ? 'complete-with-deadline-breaches' : 'complete-valid',
      label: variantName === 'baseline' ? 'before' : 'after', generatedAt: new Date().toISOString(), samplesPerHook, provenance, hooks, limitations };
    atomicJson(path.join(OUT, variantName === 'baseline' ? 'before.json' : 'after.json'), docs[variantName]);
  }
  const allHooks = [...docs.baseline.hooks, ...docs.optimized.hooks];
  const status = allHooks.some(h => h.invalids) ? 'complete-with-invalid-samples' : allHooks.some(h => h.deadlineBreaches) ? 'complete-with-deadline-breaches' : 'complete-valid';
  const report = { schemaVersion: 2, status, generatedAt: new Date().toISOString(), runId, provenance, limitations,
    comparison: hookSpecs.map(spec => {
      const before = docs.baseline.hooks.find(h => h.hook === spec.hook); const after = docs.optimized.hooks.find(h => h.hook === spec.hook);
      return { hook: spec.hook, before: { minMs: before.minMs, medianMs: before.medianMs, maxMs: before.maxMs, deadlineBreaches: before.deadlineBreaches, invalids: before.invalids },
        after: { minMs: after.minMs, medianMs: after.medianMs, maxMs: after.maxMs, deadlineBreaches: after.deadlineBreaches, invalids: after.invalids },
        medianDeltaMs: before.medianMs !== null && after.medianMs !== null ? Math.round((after.medianMs - before.medianMs) * 10) / 10 : null };
    }) };
  atomicJson(path.join(OUT, 'report.json'), report);
  state.status = status; state.completedAt = new Date().toISOString(); atomicJson(incremental, state);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if ([...docs.baseline.hooks, ...docs.optimized.hooks].some(h => h.invalids || h.deadlineBreaches)) process.exitCode = 2;
  return report;
  } catch (error) {
    if (state && incremental) { state.status = 'failed'; state.error = error.message; atomicJson(incremental, state); }
    publishStatus('failed', { error: error.message });
    throw error;
  }
}

module.exports = { runChild, startFixture, killOwnedTree, parseOutput, childEnvironment, validateRaw, main };
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
