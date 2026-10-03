// SPDX-License-Identifier: Apache-2.0
//
// Deploy a self-hosted, end-to-end encrypted Sync Hub to YOUR Cloudflare
// account (Workers Free plan) and write the connection settings:
//   1. wrangler deploy --config wrangler.self-host.jsonc (prints the URL);
//   2. generate SELF_HOST_TOKEN + SELF_HOST_USER_ID and `wrangler secret put`
//      them through stdin (never argv, the terminal or shell history);
//   3. wait until /v1/sync/status accepts them;
//   4. write CLAUDE_MEM_CLOUD_SYNC_{HUB_URL,TOKEN,USER_ID} to a 0600 env file
//      (default ~/.cloudflare/cmem-sync.env). Nothing secret is printed.
//
// Then, on each device: bun scripts/sync-e2e.ts init|import, configure --env-file <file>.
//
// Usage (from workers/sync-hub, after `bun install` and `wrangler login`):
//   node scripts/self-host-setup.mjs [--out <file>]

import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = 'wrangler.self-host.jsonc';

const { values: opts } = parseArgs({
	options: {
		out: { type: 'string', default: resolve(homedir(), '.cloudflare', 'cmem-sync.env') },
	},
});

function fail(message) {
	console.error(`self-host-setup: ${message}`);
	process.exit(1);
}

const outFile = resolve(opts.out);
if (existsSync(outFile)) fail(`${outFile} already exists; move it away or pass another --out`);

function wrangler(args, { input, capture = false } = {}) {
	const bin = resolve(PACKAGE_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
	if (!existsSync(bin)) fail('wrangler is not installed; run `bun install` in workers/sync-hub');
	const result = spawnSync(process.execPath, [bin, ...args, '--config', CONFIG], {
		cwd: PACKAGE_ROOT,
		input,
		encoding: 'utf8',
		stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'],
		env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
	});
	if (capture && result.stdout) process.stdout.write(result.stdout);
	if (result.status !== 0) fail(`wrangler ${args.join(' ')} exited with ${result.status}`);
	return result.stdout ?? '';
}

console.log('Deploying the self-hosted hub …');
const deployOutput = wrangler(['deploy'], { capture: true });
const hubUrl = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(deployOutput)?.[0];
if (!hubUrl) fail('could not find the workers.dev URL in the deploy output');

const token = randomBytes(32).toString('base64url');
const userId = randomUUID();
console.log('Setting SELF_HOST_TOKEN and SELF_HOST_USER_ID …');
wrangler(['secret', 'put', 'SELF_HOST_USER_ID'], { input: userId });
wrangler(['secret', 'put', 'SELF_HOST_TOKEN'], { input: token });

console.log('Waiting for the hub to accept the new token …');
const deadline = Date.now() + 90_000;
for (;;) {
	const res = await fetch(`${hubUrl}/v1/sync/status`, {
		headers: { Authorization: `Bearer ${token}`, 'X-User-Id': userId },
	}).catch(() => null);
	if (res?.status === 200) break;
	if (Date.now() > deadline) fail(`hub never accepted the token (last HTTP ${res?.status ?? 'network error'})`);
	await new Promise((r) => setTimeout(r, 3_000));
}

mkdirSync(dirname(outFile), { recursive: true, mode: 0o700 });
writeFileSync(
	outFile,
	[
		`# claude-mem self-hosted sync hub, created ${new Date().toISOString()}`,
		`CLAUDE_MEM_CLOUD_SYNC_HUB_URL=${hubUrl}`,
		`CLAUDE_MEM_CLOUD_SYNC_TOKEN=${token}`,
		`CLAUDE_MEM_CLOUD_SYNC_USER_ID=${userId}`,
		'',
	].join('\n'),
	{ mode: 0o600, flag: 'wx' },
);

console.log(`
Hub ready at ${hubUrl}; settings saved to ${outFile}.
On each device (repo root):
  bun scripts/sync-e2e.ts init        # first device only; then "export" to back up the key
  bun scripts/sync-e2e.ts import      # other devices: paste the exported key
  bun scripts/sync-e2e.ts configure --env-file ${outFile}
  npm run worker:restart`);
