#!/usr/bin/env bun
/**
 * Sync-hub canary (plan Phase 5 task 3) — a standalone Bun script, NOT a
 * Worker. One synthetic user, two fake device identities, a trickle write
 * every N minutes, asserting convergence: device B must see device A's op
 * within a bound (and vice versa — origins alternate per cycle).
 *
 * WHY IT EXISTS: the canary user's DO has a KNOWN, CONSTANT workload, so
 * its duration metric is a known constant — which is what makes the
 * watchdog's hibernation-defeat detector (duration GB-s ≈ 0) sensitive.
 * Scope: the canary exercises the HTTP lanes only (it holds no WebSocket),
 * so its DO catches HTTP-path regressions; WS-lane hibernation defeats are
 * covered by the watchdog's fleet-wide duration alerting, not the canary.
 * It runs 24/7 on any box (launchd/systemd/cron examples in
 * ../DEPLOY.md) and prints one structured JSON line per event to stdout —
 * redirect to a file for history.
 *
 * MODES
 *   default        trickle loop: one tiny op per cycle, alternating origin
 *                  device, convergence asserted per cycle.
 *   --flood        deliberately noisy: fires --flood-requests cheap GETs at
 *                  /v1/sync/changes to push the hub's hourly request count
 *                  over a (temporarily lowered) watchdog threshold — the
 *                  end-to-end alert-chain rehearsal in DEPLOY.md
 *                  ("threshold-trip verification"). Never run against prod
 *                  without lowering WATCHDOG_REQUESTS_ALERT first; at the
 *                  default 60k threshold a meaningful flood costs real
 *                  requests.
 *
 * USAGE
 *   bun canary.ts [--hub URL] [--user ID] [--token TOKEN]
 *                 [--interval-ms N=300000] [--timeout-ms N=10000]
 *                 [--cycles N=0 (0 = forever)]
 *                 [--flood] [--flood-requests N=5000]
 *   Env fallbacks: CANARY_HUB_URL, CANARY_USER_ID, CANARY_TOKEN.
 *   The URL defaults to `wrangler dev` (http://localhost:8787). Supply a
 *   verifier-backed test user's CANARY_USER_ID and CANARY_TOKEN.
 *
 * OUTPUT (one JSON object per line)
 *   {"event":"cycle","cycle":3,"origin":"canary-dev-a","converged":true,
 *    "latency_ms":412,"seq":"57","sync_mode":"live",...}
 *   sync_mode mirrors the hub's X-Sync-Mode header ("live" when absent,
 *   "poll" while the kill switch is tripped) — the canary doubles as a
 *   kill-switch observability probe.
 *
 * The canary is read/write-only against the public HTTP API — it imports
 * nothing from the hub or the plugin, so it can run anywhere Bun runs.
 */

/* Minimal ambient typing: this file typechecks against the workerd runtime
 * types the sync-hub tsconfig already loads (fetch/Response/URL/console/
 * setTimeout). `export {}` makes this a module so the `process` declaration
 * below stays module-scoped (Bun provides the real one at runtime) instead
 * of colliding with any transitively-loaded Node globals. */
export {};

declare const process: {
	argv: string[];
	env: Record<string, string | undefined>;
	exit(code?: number): never;
};

interface Args {
	hub: string;
	user: string;
	token: string;
	intervalMs: number;
	timeoutMs: number;
	cycles: number;
	flood: boolean;
	floodRequests: number;
}

const DEVICE_A = "canary-dev-a";
const DEVICE_B = "canary-dev-b";

function usage(): never {
	console.log(
		"usage: bun canary.ts [--hub URL] [--user ID] [--token TOKEN] " +
			"[--interval-ms N] [--timeout-ms N] [--cycles N] [--flood] [--flood-requests N]",
	);
	process.exit(2);
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		hub: process.env.CANARY_HUB_URL ?? "http://localhost:8787",
		user: process.env.CANARY_USER_ID ?? "canary-user",
		token: process.env.CANARY_TOKEN ?? "canary-token",
		intervalMs: 300_000, // one tiny op per device every 5 minutes
		timeoutMs: 10_000, // convergence bound per cycle
		cycles: 0, // 0 = run forever (the 24/7 deployment)
		flood: false,
		floodRequests: 5_000,
	};
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = (): string => {
			const value = argv[++i];
			if (value === undefined) usage();
			return value;
		};
		if (flag === "--hub") args.hub = next();
		else if (flag === "--user") args.user = next();
		else if (flag === "--token") args.token = next();
		else if (flag === "--interval-ms") args.intervalMs = Number(next());
		else if (flag === "--timeout-ms") args.timeoutMs = Number(next());
		else if (flag === "--cycles") args.cycles = Number(next());
		else if (flag === "--flood") args.flood = true;
		else if (flag === "--flood-requests") args.floodRequests = Number(next());
		else if (flag === "--help" || flag === "-h") usage();
		else usage();
	}
	args.hub = args.hub.replace(/\/+$/, "");
	for (const [name, value] of [
		["--interval-ms", args.intervalMs],
		["--timeout-ms", args.timeoutMs],
		["--cycles", args.cycles],
		["--flood-requests", args.floodRequests],
	] as Array<[string, number]>) {
		if (!Number.isFinite(value) || value < 0) {
			console.error(`invalid ${name}`);
			usage();
		}
	}
	return args;
}

function log(record: Record<string, unknown>): void {
	console.log(JSON.stringify({ ts: new Date().toISOString(), ...record }));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * RFC-8259 JSON with recursively sorted object keys — the hub's canonical
 * wire form (src/canonical-content.ts). Reimplemented locally on purpose:
 * the canary imports nothing from the hub.
 */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const parts = Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
		return `{${parts.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** Unpadded base64url SHA-256 (matches the hub's digest form). */
async function sha256Base64Url(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	let binary = "";
	for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Max of two canonical unsigned decimal strings (hub cursors are uint64). */
function decimalMax(left: string, right: string): string {
	return BigInt(left) >= BigInt(right) ? left : right;
}

class Canary {
	private readonly args: Args;
	/** Per-device pull cursor (hub seq, canonical unsigned decimal string). */
	private readonly cursors: Record<string, string> = { [DEVICE_A]: "0", [DEVICE_B]: "0" };
	/** Last X-Sync-Mode seen on any response ("live" when absent). */
	private syncMode = "live";
	/** Unique-per-run origin-id prefix (no state file needed). */
	private readonly runId = Date.now().toString(36);

	constructor(args: Args) {
		this.args = args;
	}

	private headers(deviceId: string): Record<string, string> {
		return {
			Authorization: `Bearer ${this.args.token}`,
			"X-User-Id": this.args.user,
			"X-Device-Id": deviceId,
		};
	}

	private noteMode(res: Response): void {
		this.syncMode = res.headers.get("X-Sync-Mode") ?? "live";
	}

	/**
	 * Push one canonical protocol-v2 observation op (the full envelope the
	 * hub validates in src/canonical-content.ts). Returns the acked seq plus
	 * the operation digest — the digest is how the replica recognizes the op.
	 */
	private async push(
		deviceId: string,
		localId: string,
		info: Record<string, string>,
	): Promise<{ seq: string; headSeq: string; opSha: string }> {
		const payload = {
			created_at: new Date().toISOString(),
			created_at_epoch: Date.now().toString(10),
			memory_session_id: `canary-${this.runId}`,
			project: "sync-canary",
			text: JSON.stringify(info),
			title: "sync-hub canary op",
			type: "canary",
		};
		const envelope = {
			body_schema_version: 1,
			deleted: false,
			deleted_at: null,
			entity_rev: "1",
			id: `observation:${await sha256Base64Url(
				canonicalJson(["cmem-doc-id-v1", "device", "observation", deviceId, localId]),
			)}`,
			kind: "observation",
			mutation: null,
			origin_device_id: deviceId,
			origin_local_id: localId,
			payload,
			payload_schema_version: 2,
			payload_sha256: await sha256Base64Url(canonicalJson(payload)),
		};
		const body = canonicalJson(envelope);
		const operationSha256 = await sha256Base64Url(body);
		const res = await fetch(`${this.args.hub}/v1/sync/ops`, {
			method: "POST",
			headers: { ...this.headers(deviceId), "Content-Type": "application/json" },
			body: JSON.stringify({
				protocol_version: 2,
				ops: [{ body, operation_sha256: operationSha256 }],
			}),
			signal: AbortSignal.timeout(this.args.timeoutMs),
		});
		this.noteMode(res);
		if (!res.ok) {
			throw new Error(`push ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
		}
		const parsed = (await res.json()) as {
			acked: Array<{ operation_sha256: string; seq: string }>;
			head_seq: string;
		};
		const ack = parsed.acked.find((a) => a.operation_sha256 === operationSha256);
		if (!ack) throw new Error("push response did not ack the canary op");
		return { seq: ack.seq, headSeq: parsed.head_seq, opSha: operationSha256 };
	}

	private async pull(
		deviceId: string,
		since: string,
	): Promise<{ ops: Array<{ seq: string; operation_sha256: string }>; headSeq: string }> {
		const res = await fetch(`${this.args.hub}/v1/sync/changes?since=${since}&limit=500`, {
			headers: this.headers(deviceId),
			signal: AbortSignal.timeout(this.args.timeoutMs),
		});
		this.noteMode(res);
		if (!res.ok) {
			throw new Error(`pull ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
		}
		const parsed = (await res.json()) as {
			ops: Array<{ seq: string; operation_sha256: string }>;
			head_seq: string;
		};
		return { ops: parsed.ops, headSeq: parsed.head_seq };
	}

	/** Start both cursors at the current head — only NEW ops matter. */
	async init(): Promise<void> {
		const res = await fetch(`${this.args.hub}/v1/sync/status`, {
			headers: this.headers(DEVICE_A),
			signal: AbortSignal.timeout(this.args.timeoutMs),
		});
		this.noteMode(res);
		if (!res.ok) {
			throw new Error(`status ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
		}
		const status = (await res.json()) as { head_seq: string; epoch: string };
		this.cursors[DEVICE_A] = String(status.head_seq);
		this.cursors[DEVICE_B] = String(status.head_seq);
		log({
			event: "init",
			hub: this.args.hub,
			user: this.args.user,
			head_seq: status.head_seq,
			epoch: status.epoch,
			sync_mode: this.syncMode,
		});
	}

	/**
	 * One trickle cycle: origin pushes a tiny op; the OTHER device polls its
	 * cursor forward until it sees that exact op (or the bound expires).
	 */
	async cycle(n: number): Promise<boolean> {
		const origin = n % 2 === 0 ? DEVICE_A : DEVICE_B;
		const replica = origin === DEVICE_A ? DEVICE_B : DEVICE_A;
		// Canonical decimal, unique per push: ms timestamp + zero-padded cycle.
		const localId = `${Date.now()}${String(n % 1000).padStart(3, "0")}`;
		const startedAt = Date.now();
		try {
			const pushed = await this.push(origin, localId, {
				canary: "true",
				cycle: String(n),
				sent_at: new Date(startedAt).toISOString(),
			});
			// Poll the replica cursor forward until the op shows up.
			let converged = false;
			const deadline = startedAt + this.args.timeoutMs;
			while (Date.now() < deadline && !converged) {
				const page = await this.pull(replica, this.cursors[replica]);
				for (const op of page.ops) {
					this.cursors[replica] = decimalMax(this.cursors[replica], op.seq);
					if (op.operation_sha256 === pushed.opSha) {
						converged = true;
					}
				}
				if (!converged) await sleep(500);
			}
			// Advance the origin's cursor too so both stay near head (and its
			// own echo is consumed, keeping pages tiny forever).
			const originPage = await this.pull(origin, this.cursors[origin]);
			for (const op of originPage.ops) {
				this.cursors[origin] = decimalMax(this.cursors[origin], op.seq);
			}
			log({
				event: "cycle",
				cycle: n,
				origin,
				origin_local_id: localId,
				seq: pushed.seq,
				converged,
				latency_ms: Date.now() - startedAt,
				bound_ms: this.args.timeoutMs,
				sync_mode: this.syncMode,
			});
			return converged;
		} catch (e) {
			log({
				event: "error",
				cycle: n,
				origin,
				error: String(e).slice(0, 300),
				sync_mode: this.syncMode,
			});
			return false;
		}
	}

	/**
	 * Flood mode: cheap, honest request volume (each GET is a real request
	 * against the canary user's DO, with an empty page in the response). 20
	 * in flight keeps it fast without abusing the ~1,000 req/s per-DO soft
	 * limit.
	 */
	async flood(): Promise<void> {
		const total = this.args.floodRequests;
		const concurrency = 20;
		const startedAt = Date.now();
		let sent = 0;
		let failed = 0;
		const head = this.cursors[DEVICE_A];
		const worker = async (): Promise<void> => {
			for (;;) {
				if (sent >= total) return;
				sent++;
				try {
					await this.pull(DEVICE_A, head);
				} catch {
					failed++;
				}
			}
		};
		log({ event: "flood_start", requests: total, concurrency });
		await Promise.all(Array.from({ length: concurrency }, () => worker()));
		log({
			event: "flood_done",
			requests: total,
			failed,
			elapsed_ms: Date.now() - startedAt,
			sync_mode: this.syncMode,
		});
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const canary = new Canary(args);
	try {
		await canary.init();
	} catch (e) {
		log({ event: "fatal", error: String(e).slice(0, 300) });
		process.exit(1);
	}

	if (args.flood) {
		await canary.flood();
		return;
	}

	let failures = 0;
	for (let n = 0; args.cycles === 0 || n < args.cycles; n++) {
		if (n > 0) await sleep(args.intervalMs);
		const converged = await canary.cycle(n);
		if (!converged) failures++;
	}
	// Bounded runs (--cycles) are CI/verification runs: fail loudly.
	if (args.cycles > 0 && failures > 0) {
		log({ event: "done", cycles: args.cycles, failures });
		process.exit(1);
	}
	log({ event: "done", cycles: args.cycles, failures });
}

void main();
