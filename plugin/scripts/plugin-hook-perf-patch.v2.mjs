#!/usr/bin/env bun
// claude-mem perf-patch v2 — rewrites hooks.json/codex-hooks.json so that
// hook commands go through hook-client.mjs (UDS → daemon-server.mjs) instead of
// spawning a fresh worker-service.cjs per hook. Plus Sprint-2 hook-coverage fixes:
//   --fix-session-start-matcher → adds "resume" to SessionStart matcher (bug-fix P0)
//   --fix-posttooluse-matcher    → broadens PostToolUse to include MultiEdit|Task|Skill
//   --tighten-timeouts           → reduces Setup 300→30, PostToolUse 120→30
//   --apply-uds                  → reroute commands through hook-client.mjs
//   --apply-codex-cleanup        → drop $SHELL prelude + bun-runner indirection
//   --rollback                   → restore from .uds-bak
//   --all                        → applies every patch in safe order

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { parseArgs } from 'util';
import { INTERESTING_TOOLS_REGEX, SESSION_START_MATCHER, BACKUP_SUFFIX } from './lib/constants.mjs';

const { values: args } = parseArgs({
  options: {
    target:                        { type: 'string' },
    'apply-uds':                   { type: 'boolean', default: false },
    'apply-codex-cleanup':         { type: 'boolean', default: false },
    'fix-session-start-matcher':   { type: 'boolean', default: false },
    'fix-posttooluse-matcher':     { type: 'boolean', default: false },
    'tighten-timeouts':            { type: 'boolean', default: false },
    all:                           { type: 'boolean', default: false },
    rollback:                      { type: 'string' },
  },
  strict: true,
});

function backup(p) {
  const bak = `${p}${BACKUP_SUFFIX}`;
  if (!existsSync(bak)) {
    copyFileSync(p, bak);
    process.stderr.write(`[patcher] backup → ${bak}\n`);
  }
}

// Shared scaffold: backup → parse → triple-loop with mutator → write.
function patchHooks(hooksJson, label, mutator) {
  backup(hooksJson);
  const cfg = JSON.parse(readFileSync(hooksJson, 'utf-8'));
  let changed = 0;
  for (const event of Object.keys(cfg.hooks || {})) {
    for (const matcher of cfg.hooks[event] || []) {
      changed += mutator(matcher, event, cfg) || 0;
    }
  }
  writeFileSync(hooksJson, JSON.stringify(cfg, null, 2));
  process.stderr.write(`[patcher] ${label}: ${changed} change(s) in ${hooksJson}\n`);
  return changed;
}

function rewriteToUDSClient(hooksJson) {
  const CLIENT = '$_P/scripts/hook-client.mjs';
  return patchHooks(hooksJson, 'UDS-route', (matcher) => {
    let c = 0;
    for (const h of matcher.hooks || []) {
      if (h.type !== 'command' || typeof h.command !== 'string') continue;
      const next = h.command.replace(
        /bun\s+"[^"]*worker-service\.cjs"\s+hook\s+(claude-code|codex)\s+(\w+)/g,
        (_m, plat, evt) => `bun "${CLIENT}" --platform ${plat} --event ${evt}`,
      ).replace(
        /node\s+"[^"]*bun-runner\.js"\s+"[^"]*worker-service\.cjs"\s+hook\s+(claude-code|codex)\s+(\w+)/g,
        (_m, plat, evt) => `bun "${CLIENT}" --platform ${plat} --event ${evt}`,
      );
      if (next !== h.command) { h.command = next; c++; }
    }
    return c;
  });
}

function applyCodexCleanup(hooksJson) {
  return patchHooks(hooksJson, 'codex-cleanup', (matcher, event) => {
    let c = 0;
    for (const h of matcher.hooks || []) {
      if (h.type !== 'command' || typeof h.command !== 'string') continue;
      const before = h.command;
      h.command = h.command
        .replace(/_HP=\$\(printenv PATH 2>\/dev\/null \|\| true\);[\s\S]*?export PATH="[^"]*";\s*/g, '')
        .replace(/node\s+"[^"]*\/bun-runner\.js"\s+/g, 'bun ');
      if (h.command !== before) c++;
    }
    if (event === 'PostToolUse' && matcher.matcher === '.*') {
      matcher.matcher = INTERESTING_TOOLS_REGEX;
      c++;
    }
    return c;
  });
}

function fixSessionStartMatcher(hooksJson) {
  return patchHooks(hooksJson, 'session-start +resume', (matcher, event) => {
    if (event !== 'SessionStart') return 0;
    if (typeof matcher.matcher !== 'string') return 0;
    if (matcher.matcher.includes('resume')) return 0;
    matcher.matcher = SESSION_START_MATCHER;
    return 1;
  });
}

function fixPostToolUseMatcher(hooksJson) {
  return patchHooks(hooksJson, 'posttooluse +MultiEdit|Task|Skill', (matcher, event) => {
    if (event !== 'PostToolUse') return 0;
    if (typeof matcher.matcher !== 'string') return 0;
    if (matcher.matcher === '.*' || matcher.matcher === '*') return 0; // codex-cleanup handles these
    if (matcher.matcher === INTERESTING_TOOLS_REGEX) return 0; // already broadened
    matcher.matcher = INTERESTING_TOOLS_REGEX;
    return 1;
  });
}

function tightenTimeouts(hooksJson) {
  return patchHooks(hooksJson, 'tighten-timeouts', (matcher, event) => {
    let c = 0;
    for (const h of matcher.hooks || []) {
      if (h.type !== 'command') continue;
      const old = h.timeout;
      if (event === 'Setup' && h.timeout > 30) { h.timeout = 30; c++; }
      else if (event === 'PostToolUse' && h.timeout > 30) { h.timeout = 30; c++; }
      else if (event === 'SessionStart' && h.timeout > 30) { h.timeout = 30; c++; }
      else if (event === 'UserPromptSubmit' && h.timeout > 10) { h.timeout = 10; c++; }
      if (old !== h.timeout) {/* no-op, counted above */}
    }
    return c;
  });
}

function rollback(hooksJson) {
  const bak = `${hooksJson}${BACKUP_SUFFIX}`;
  if (!existsSync(bak)) {
    process.stderr.write(`[patcher] no backup found at ${bak}\n`);
    process.exit(1);
  }
  copyFileSync(bak, hooksJson);
  process.stderr.write(`[patcher] rolled back ${hooksJson} ← ${bak}\n`);
}

if (args.rollback) {
  rollback(args.rollback);
} else {
  if (!args.target) {
    process.stderr.write(
      'Usage: --target <hooks.json> [--apply-uds] [--apply-codex-cleanup]\n' +
      '         [--fix-session-start-matcher] [--fix-posttooluse-matcher] [--tighten-timeouts]\n' +
      '         [--all] | --rollback <hooks.json>\n'
    );
    process.exit(2);
  }
  const flags = {
    uds: args['apply-uds'] || args.all,
    codex: args['apply-codex-cleanup'] || args.all,
    ss: args['fix-session-start-matcher'] || args.all,
    pt: args['fix-posttooluse-matcher'] || args.all,
    tt: args['tighten-timeouts'] || args.all,
  };
  if (flags.codex) applyCodexCleanup(args.target);
  if (flags.ss) fixSessionStartMatcher(args.target);
  if (flags.pt) fixPostToolUseMatcher(args.target);
  if (flags.tt) tightenTimeouts(args.target);
  if (flags.uds) rewriteToUDSClient(args.target);
  if (!Object.values(flags).some(Boolean)) {
    process.stderr.write('[patcher] nothing to do — pass --apply-uds, --apply-codex-cleanup, --fix-*-matcher, --tighten-timeouts, or --all\n');
    process.exit(2);
  }
}
