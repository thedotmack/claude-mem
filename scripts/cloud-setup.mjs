#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// claude-mem for Claude Code cloud sessions (claude.ai/code), where plugins are
// unavailable. Run from the environment's setup script (before Claude starts):
//
//   git clone --depth 1 -b <branch> https://github.com/<owner>/claude-mem.git ~/claude-mem \
//     && node ~/claude-mem/scripts/cloud-setup.mjs
//
// It installs the plugin runtime from this checkout and wires it up as
// USER-LEVEL hooks (~/.claude/settings.json) plus the search MCP server, the
// same commands plugin/hooks/hooks.json runs. Cloud profile: SQLite-only search
// (no Chroma download or re-embedding), no welcome hint. With
// CLAUDE_MEM_CLOUD_SYNC_E2E_KEY set in the environment, the key file is written
// (0600, never printed) and end-to-end encrypted sync is enabled; the hub URL,
// token and user id are read from the CLAUDE_MEM_CLOUD_SYNC_* environment
// variables by the worker itself. Each VM mints its own device id.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(ROOT, 'plugin');
const HOME = homedir();
const DATA_DIR = join(HOME, '.claude-mem');
const CLAUDE_SETTINGS = join(HOME, '.claude', 'settings.json');

function run(cmd, args, options = {}) {
	const result = spawnSync(cmd, args, { stdio: 'inherit', ...options });
	if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}`);
}

function readJson(path) {
	return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

console.log('claude-mem cloud setup: installing plugin runtime …');
// Native tree-sitter builds are only for smart-explore and need a toolchain.
run('bun', ['install', '--production', '--ignore-scripts'], { cwd: PLUGIN });

// plugin/scripts is rebuilt at release time, so a checkout of unreleased
// source can carry a worker bundle without end-to-end encryption. Build it
// from source in that case rather than start a worker that can't open (or
// seal) anything on a self-hosted hub.
const WORKER_BUNDLE = join(PLUGIN, 'scripts', 'worker-service.cjs');
if (!readFileSync(WORKER_BUNDLE, 'utf8').includes('CLAUDE_MEM_CLOUD_SYNC_E2E_KEY')) {
	console.log('claude-mem cloud setup: worker bundle predates E2E sync, building from source …');
	run('bun', ['install', '--ignore-scripts'], { cwd: ROOT });
	run('node', ['scripts/build-hooks.js'], { cwd: ROOT });
}

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const settingsPath = join(DATA_DIR, 'settings.json');
const settings = {
	...readJson(settingsPath),
	CLAUDE_MEM_CHROMA_ENABLED: 'false',
	CLAUDE_MEM_WELCOME_HINT_ENABLED: 'false',
	CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'claude-code-cloud',
};
const key = (process.env.CLAUDE_MEM_CLOUD_SYNC_E2E_KEY ?? '').trim();
if (key) {
	writeFileSync(join(DATA_DIR, 'sync-e2e.key'), `${key}\n`, { mode: 0o600 });
	settings.CLAUDE_MEM_CLOUD_SYNC_E2E = 'true';
	console.log('claude-mem cloud setup: E2E key written, encrypted sync enabled.');
}
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

// Pin the worker to this checkout. Without it, whichever process spawns the
// worker first (usually the MCP server) resolves worker-service.cjs from its
// cwd, and a cloud session working in a claude-mem repo would run that
// checkout's worker (e.g. one without E2E) instead of this one.
const runner = (args) => `CLAUDE_PLUGIN_ROOT="${PLUGIN}" CLAUDE_MEM_WORKER_SCRIPT_PATH="${WORKER_BUNDLE}" node "${PLUGIN}/scripts/bun-runner.js" "${WORKER_BUNDLE}" ${args}`;

// The plugin's own hooks (events, matchers, timeouts and async flags) with
// each worker-service.cjs command pointed at this checkout. Hooks that don't
// run the worker (Setup's version check) are left out.
const hooks = {};
for (const [event, groups] of Object.entries(readJson(join(PLUGIN, 'hooks', 'hooks.json')).hooks)) {
	for (const group of groups) {
		const cloudHooks = group.hooks.flatMap((h) => {
			const args = /worker-service\.cjs" ([^"]+)$/.exec(h.command ?? '')?.[1];
			if (!args) return [];
			return [{ type: 'command', command: runner(args), ...(h.timeout ? { timeout: h.timeout } : {}), ...(h.async ? { async: true } : {}) }];
		});
		if (cloudHooks.length === 0) continue;
		(hooks[event] ??= []).push({ ...(group.matcher ? { matcher: group.matcher } : {}), hooks: cloudHooks });
	}
}
mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
const claudeSettings = readJson(CLAUDE_SETTINGS);
// Replace any previous claude-mem cloud hooks, keep everything else.
const existing = claudeSettings.hooks ?? {};
for (const [event, groups] of Object.entries(hooks)) {
	const kept = (existing[event] ?? []).filter((g) => !JSON.stringify(g).includes(`${PLUGIN}/scripts/worker-service.cjs`));
	existing[event] = [...kept, ...groups];
}
claudeSettings.hooks = existing;
writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify(claudeSettings, null, 2)}\n`);
console.log(`claude-mem cloud setup: hooks written to ${CLAUDE_SETTINGS}`);

// Re-registering replaces an entry left by an earlier (cached) setup run.
spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'claude-mem'], { stdio: 'ignore' });
const mcp = spawnSync('claude', ['mcp', 'add', '--scope', 'user', 'claude-mem', '-e', `CLAUDE_MEM_WORKER_SCRIPT_PATH=${WORKER_BUNDLE}`, '--', 'node', `${PLUGIN}/scripts/mcp-server.cjs`], { stdio: 'inherit' });
console.log(mcp.status === 0 ? 'claude-mem cloud setup: MCP search server registered.' : 'claude-mem cloud setup: MCP registration skipped (claude mcp add failed).');
console.log('claude-mem cloud setup: done.');
