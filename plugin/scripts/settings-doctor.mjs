#!/usr/bin/env bun
// claude-mem settings-doctor — inspects ~/.claude-mem/settings.json for footguns.
// Spec: docs/sprint2/07-tdd-plan-v2.md Phase 3.
//
// Usage:
//   bun settings-doctor.mjs [path-to-settings.json]
//   (defaults to ~/.claude-mem/settings.json)

import { readFileSync, existsSync } from 'node:fs';
import { SETTINGS_PATH } from './lib/paths.mjs';

const target = process.argv[2] || SETTINGS_PATH;
if (!existsSync(target)) {
  process.stderr.write(`[settings-doctor] no settings file at ${target}\n`);
  process.exit(2);
}
const s = JSON.parse(readFileSync(target, 'utf-8'));
const issues = [];

function add(sev, key, msg, fix) {
  issues.push({ sev, key, msg, fix });
}

// P0 — Security
if (s.CLAUDE_MEM_WORKER_HOST && s.CLAUDE_MEM_WORKER_HOST !== '127.0.0.1' && s.CLAUDE_MEM_WORKER_HOST !== 'localhost') {
  add('P0', 'CLAUDE_MEM_WORKER_HOST',
      `Worker is bound to ${s.CLAUDE_MEM_WORKER_HOST} (non-loopback). Network may read/write memory.`,
      'set "CLAUDE_MEM_WORKER_HOST": "127.0.0.1"');
}
if (s.CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS) {
  add('P0', 'CLAUDE_MEM_ALLOW_LOCAL_DEV_BYPASS',
      'Undocumented dev bypass flag is set. Verify intent.',
      'remove unless intentionally bypassing claude-mem security checks');
}

// P1 — Noise reduction
if (s.CLAUDE_MEM_TELEGRAM_ENABLED === 'true' && !s.CLAUDE_MEM_TELEGRAM_BOT_TOKEN) {
  add('P1', 'CLAUDE_MEM_TELEGRAM_ENABLED',
      'Telegram is enabled but bot token is empty — silent no-op.',
      'set "CLAUDE_MEM_TELEGRAM_ENABLED": "false" to suppress 5 unused Telegram rows');
}
if (s.CLAUDE_MEM_CHROMA_ENABLED === 'false') {
  const chromaKeys = Object.keys(s).filter(k => k.startsWith('CLAUDE_MEM_CHROMA_') && k !== 'CLAUDE_MEM_CHROMA_ENABLED');
  if (chromaKeys.length >= 4) {
    add('P1', 'CLAUDE_MEM_CHROMA_*',
        `${chromaKeys.length} Chroma settings present but Chroma is disabled.`,
        'remove unused Chroma keys (or move to extensions: sub-block in a future settings schema)');
  }
}

// P2 — Likely dead settings
if (s.CLAUDE_MEM_PYTHON_VERSION) {
  add('P2', 'CLAUDE_MEM_PYTHON_VERSION',
      'Bun-based plugin has no Python interpretation path.',
      'remove (legacy artifact)');
}
if (s.CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED === 'false') {
  add('P2', 'CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED',
      'Per upstream #641 this feature is not implemented (half-baked setting).',
      'remove or wait for upstream implementation');
}

// P3 — Provider redundancy
const gemini = Object.keys(s).filter(k => k.startsWith('CLAUDE_MEM_GEMINI_')).length;
const openrouter = Object.keys(s).filter(k => k.startsWith('CLAUDE_MEM_OPENROUTER_')).length;
if (gemini >= 4 && openrouter >= 4) {
  add('P3', 'PROVIDER_REDUNDANCY',
      `${gemini} Gemini + ${openrouter} OpenRouter settings repeat the same shape.`,
      'consider a CLAUDE_MEM_PROVIDER_<name>_<field> overlay schema in a future version');
}

// Output
if (issues.length === 0) {
  process.stdout.write('[settings-doctor] no issues found.\n');
  process.exit(0);
}

process.stdout.write(`[settings-doctor] ${issues.length} issue(s) in ${target}\n\n`);
for (const { sev, key, msg, fix } of issues) {
  process.stdout.write(`  [${sev}] ${key}\n        ${msg}\n        → ${fix}\n\n`);
}
process.exit(0);
