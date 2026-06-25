#!/usr/bin/env bun
// claude-mem hook-client — thin UDS client with fast-skip + auto-spawn.
// Spec: docs/sprint2/07-tdd-plan-v2.md Phase 1 (P0-Fixes).
//
// Sprint-2 changes vs Sprint-1:
//  - P0-1: awaits socket.write drain + sock.end callback before exit (no data-loss race)
//  - P1: parseArgs strict=true (typo detection)
//  - P1: readStdin timeout tracked + diagnosed on stderr
//  - DRY: INTERESTING_TOOLS pulled from lib/constants.mjs

import { connect } from 'node:net';
import { spawn } from 'bun';
import { parseArgs } from 'util';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { INTERESTING_TOOLS } from './lib/constants.mjs';
import { DEFAULT_SOCK } from './lib/paths.mjs';

const { values: args } = parseArgs({
  options: {
    event:    { type: 'string' },
    platform: { type: 'string', default: 'claude-code' },
    socket:   { type: 'string' },
  },
  strict: true,
});

const SOCK = args.socket || process.env.CLAUDE_MEM_SOCK || DEFAULT_SOCK;
const INTERESTING = new Set(INTERESTING_TOOLS);

async function readStdin(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({ data: '', timedOut: false });
    const chunks = [];
    const done = (data, timedOut) => { process.stdin.pause(); resolve({ data, timedOut }); };
    const timer = setTimeout(
      () => done(Buffer.concat(chunks).toString('utf-8'), true),
      timeoutMs,
    );
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); done(Buffer.concat(chunks).toString('utf-8'), false); });
    process.stdin.on('error', () => { clearTimeout(timer); done('', false); });
  });
}

const { data: raw, timedOut } = await readStdin();
if (timedOut && raw.length > 0) {
  process.stderr.write(`[hook-client] stdin read timed out at 2000ms with ${raw.length} bytes — payload may be truncated\n`);
}
let evt = {};
try { evt = JSON.parse(raw || '{}'); } catch {}

// Sprint-2 fix: `event=context` is a READ-AND-INJECT event (SessionStart timeline).
// It must emit `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`
// not the queue-only `{"continue":true,"suppressOutput":true}` from the UDS path.
// Delegate to legacy worker-service.cjs which owns the context-generation logic.
if (args.event === 'context') {
  // SessionStart: spawn worker-service.cjs, capture its stdout, transform JSON schema
  // to match Claude Code v2.1.152+ hook spec (systemMessage must be inside
  // hookSpecificOutput, not at root), and re-emit on hook-client's own stdout pipe.
  const { spawnSync } = await import('node:child_process');
  const wsPath = join(dirname(process.argv[1]), 'worker-service.cjs');
  if (!existsSync(wsPath)) {
    process.stderr.write(`[hook-client] worker-service.cjs not found at ${wsPath}\n`);
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    process.exit(0);
  }
  const r = spawnSync('bun', [wsPath, 'hook', args.platform, 'context'], {
    input: raw,
    stdio: ['pipe', 'pipe', 'inherit'],          // capture child's stdout, inherit stderr only
    timeout: 25000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status === 0 && r.stdout && r.stdout.length > 0) {
    try {
      const j = JSON.parse(r.stdout.toString('utf-8'));
      // Schema migration: Claude Code ≥v2.1.152 expects systemMessage inside
      // hookSpecificOutput. claude-mem v13.3.0 still emits it at root.
      if (j && j.systemMessage && j.hookSpecificOutput && !j.hookSpecificOutput.systemMessage) {
        j.hookSpecificOutput.systemMessage = j.systemMessage;
        delete j.systemMessage;
      }
      // Option-D Workaround (Sprint-3): write COMPACT banner to terminal's tty so
      // Claude Code's capture pipes don't suppress it. Workaround for Claude Code
      // regression since v2.1.114 (Issue #50542). Best-effort multi-strategy.
      //
      // DISABLED BY DEFAULT (Sprint-3 finding 2026-05-31): /dev/tty writes collide
      // with Claude Code's ink-renderer — banner overlaps input field + ccstatusline.
      // Code retained for future re-enablement once Claude Code fixes the systemMessage
      // rendering regression (or if a non-tty rendering path becomes available).
      //
      // To re-enable: export CLAUDE_MEM_BANNER_TTY_WRITE=1
      const BANNER_TTY_ENABLED = process.env.CLAUDE_MEM_BANNER_TTY_WRITE === '1';
      const smRaw = j?.hookSpecificOutput?.systemMessage;
      // Build compact, ANSI-stripped 1-screen banner from additionalContext
      const acRaw = j?.hookSpecificOutput?.additionalContext || '';
      const stripAnsi = (s) => s.replace(/\[[0-9;]*m/g, '');
      const buildCompactBanner = () => {
        // ULTRA-compact 3-line banner — Ink-UI safe (no scroll trigger).
        // Provides essential signal: project, stats, latest sessions.
        const ac = stripAnsi(acRaw);
        const lines = ac.split('\n');
        const projectMatch = (lines[0] || '').match(/\[([^\]]+)\]/);
        const project = projectMatch ? projectMatch[1] : 'project';
        const statsLine = lines.find(l => /Stats:/.test(l)) || '';
        const statsMatch = statsLine.match(/Stats:\s*(\d+)\s*obs\s*\(([^)]+)\)\s*\|\s*([^|]+)\|\s*(\d+%)/);
        const stats = statsMatch
          ? `${statsMatch[1]} obs · ${statsMatch[4]} saved`
          : 'context loaded';
        // Get top 3 session refs (S1234 etc.) — ANSI-stripped format has no '#'
        const sessions = [];
        for (const l of lines) {
          const m = l.match(/^#?(S\d{3,5})\s+(.{1,60})/);
          if (m && sessions.length < 3) sessions.push(m[1]);
        }
        const date = (new Date()).toISOString().slice(0, 16).replace('T', ' ');
        return [
          `📚 claude-mem · [${project}] · ${stats} · ${date} GMT`,
          `   Recent: ${sessions.join(' · ') || 'context'} · use mem-search to drill in`,
          `   Live: http://localhost:37701 · /mem-search · 3-layer: search → timeline → get_observations`,
        ].join('\n');
      };
      const sm = buildCompactBanner();
      if (BANNER_TTY_ENABLED && sm && smRaw && typeof smRaw === 'string') {
        const { writeFileSync, appendFileSync } = await import('node:fs');
        const debugLog = `${process.env.HOME}/.claude-mem/logs/hook-banner-debug.log`;
        const trace = (msg) => { try { appendFileSync(debugLog, `[${new Date().toISOString()}] ${msg}\n`); } catch {} };

        trace(`event=context smRaw=${smRaw.length} compact=${sm.length} ttyEnv=${process.env.TTY || 'unset'} term=${process.env.TERM || 'unset'}`);

        // Strategy 1: direct /dev/tty
        let s1ok = false;
        try {
          writeFileSync('/dev/tty', '\n' + sm + '\n\n');
          s1ok = true;
          trace('strategy-1 /dev/tty write OK');
        } catch (e) {
          trace(`strategy-1 /dev/tty FAIL: ${e.code || e.message}`);
        }

        // Strategy 2: $TTY env var
        if (!s1ok && process.env.TTY) {
          try {
            writeFileSync(process.env.TTY, '\n' + sm + '\n\n');
            s1ok = true;
            trace(`strategy-2 $TTY=${process.env.TTY} write OK`);
          } catch (e) {
            trace(`strategy-2 $TTY FAIL: ${e.code || e.message}`);
          }
        }

        // Strategy 4: walk parent-process-tree to find a process WITH tty assignment
        // (terminal emulator above Claude Code), then write directly to that tty device.
        // Hook subprocess has no controlling TTY (ENXIO on /dev/tty), but ancestors do.
        if (!s1ok) {
          try {
            const { spawnSync } = await import('node:child_process');
            const ttyOf = (pid) => {
              const r = spawnSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf-8' });
              return (r.stdout || '').trim();
            };
            const ppidOf = (pid) => {
              const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf-8' });
              const v = parseInt((r.stdout || '').trim(), 10);
              return Number.isFinite(v) && v > 0 ? v : 0;
            };
            let cur = process.pid;
            for (let i = 0; i < 10 && !s1ok; i++) {
              cur = ppidOf(cur);
              if (!cur) break;
              const tty = ttyOf(cur);
              trace(`strategy-4 walk pid=${cur} tty='${tty}'`);
              if (tty && tty !== '?' && tty !== '??') {
                const ttyPath = '/dev/' + tty;
                try {
                  // Write compact 3-line banner BEFORE Ink initializes its UI.
                  // No scroll trigger → Ink renders welcome-box on top, banner stays
                  // as scrollback ABOVE welcome-box (user sees it briefly + on scroll-up).
                  writeFileSync(ttyPath, sm + '\n');
                  s1ok = true;
                  trace(`strategy-4 wrote to ${ttyPath} (${sm.length} bytes, compact 3-line)`);
                  break;
                } catch (e) {
                  trace(`strategy-4 ${ttyPath} FAIL: ${e.code || e.message}`);
                }
              }
            }
          } catch (e) {
            trace(`strategy-4 walk error: ${e.message}`);
          }
        }

        // Strategy 5: last resort, write to stderr (may or may not render)
        if (!s1ok) {
          try {
            process.stderr.write('\n' + sm + '\n\n');
            trace('strategy-5 stderr write attempted');
          } catch (e) {
            trace(`strategy-5 stderr FAIL: ${e.message}`);
          }
        }
      }
      const out = JSON.stringify(j);
      process.stdout.write(out);
      // ensure pipe drain before exit
      if (process.stdout.writable) await new Promise(res => process.stdout.write('', res));
    } catch {
      // JSON parse failed — pass through raw
      process.stdout.write(r.stdout);
    }
  } else if (r.stdout) {
    process.stdout.write(r.stdout);
  }
  process.exit(r.status ?? 0);
}

// Fast-skip BEFORE any I/O (sub-5ms target after Bun cold-start)
if (args.event === 'observation') {
  const interesting = evt.hook_event_name === 'PostToolUse' && INTERESTING.has(evt.tool_name);
  if (!interesting) {
    process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
    process.exit(0);
  }
}

async function tryConnect(path) {
  return new Promise((resolve, reject) => {
    const sock = connect({ path });
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

async function ensureDaemon() {
  try { return await tryConnect(SOCK); }
  catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ECONNREFUSED') throw e;
    const daemonScript = join(dirname(process.argv[1]), 'daemon-server.mjs');
    if (!existsSync(daemonScript)) throw new Error(`daemon not found: ${daemonScript}`);
    const child = spawn({
      cmd: ['bun', daemonScript, '--socket', SOCK],
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, CLAUDE_MEM_DAEMON: '1' },
    });
    child.unref?.();
    for (const delay of [60, 120, 200, 400]) {
      await Bun.sleep(delay);
      try { return await tryConnect(SOCK); } catch {}
    }
    throw new Error('daemon failed to come up within ~780ms');
  }
}

// P0-1 (Sprint-2 deployment hardening): write + await daemon ACK (with timeout).
// Pure fire-and-forget via Bun-UDS proved fragile — early FIN sometimes dropped
// the frame before the daemon's data() callback fired. Reading the one-line
// reply costs ~1-2 ms RPC and guarantees insert delivery.
function rpc(sock, payload, timeoutMs = 200) {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (val) => { if (done) return; done = true; try { sock.end(); } catch {}; resolve(val); };
    sock.on('data', (d) => {
      buf += d.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) {
        try { finish(JSON.parse(buf.slice(0, i))); } catch (e) { finish({ ok: false, error: e.message }); }
      }
    });
    sock.on('error', (e) => finish({ ok: false, error: e.message }));
    sock.write(payload, (err) => { if (err) finish({ ok: false, error: err.message }); });
    setTimeout(() => finish({ ok: false, error: 'reply-timeout' }), timeoutMs);
  });
}

try {
  const sock = await ensureDaemon();
  const msg = JSON.stringify({
    kind: 'hook',
    platform: args.platform,
    event: args.event,
    payload: evt,
  }) + '\n';
  const reply = await rpc(sock, msg);
  if (!reply.ok || reply.queued === false) {
    process.stderr.write(`[hook-client] daemon did not queue: ${JSON.stringify(reply)}\n`);
  }
} catch (e) {
  process.stderr.write(`[hook-client] ${e.message}\n`);
}

process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
process.exit(0);
