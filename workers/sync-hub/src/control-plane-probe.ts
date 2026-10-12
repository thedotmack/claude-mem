/**
 * Control-plane uptime probe — external check that cmem.ai's DB-backed
 * control plane is alive (launch plan Phase 5 task 4).
 *
 * WHY (the Jul 20–22 lesson): Supabase paused the project silently and
 * signups failed for 52 hours with no page. The static landing page kept
 * answering 200 the whole time, so "the site is up" proved nothing. The
 * probe therefore lives HERE, in the sync-hub Worker — outside the
 * Vercel/Supabase failure domain — and hits a DB-BACKED endpoint, never the
 * landing page.
 *
 * WHAT IT CHECKS: GET {TOKEN_VERIFY_URL} with a deliberately bogus bearer
 * token and the all-zero user id. A HEALTHY control plane answers 401/403
 * WITH A JSON BODY — that specific answer requires the Pro app AND its
 * Postgres lookup to be alive (the endpoint queries pro_users to reject the
 * token). A paused database yields 5xx/timeout/HTML instead. And a 2xx for
 * a bogus token is a SECURITY alarm (auth bypass), paged with a distinct
 * red message.
 *
 * ANTI-FLAP: KV state in AUTH_CACHE under "control:uptime-probe" (same
 * namespace-sharing rationale as the kill switch — src/kill-switch.ts).
 * Absent key = healthy steady state: a log line only, NO KV write. The
 * FIRST failure alerts only after one immediate in-run retry confirms it;
 * while failing, re-alert at most every 30 minutes; recovery posts one
 * green embed and clears the key. KV is written ONLY on state transitions
 * and re-alert ticks — never on the healthy 5-minute steady state.
 *
 * MAINTENANCE SILENCE: put {"silenced_until":"<ISO-8601>"} at the state key
 * (DEPLOY.md §7). The probe skips entirely (no fetch, no alerts) until that
 * instant, then cleans the key up quietly on its first healthy run.
 *
 * FAILURE CONTRACT (mirrors the watchdog): runControlPlaneProbe never
 * throws; a Discord post failure is swallowed with a log and never blocks
 * the KV state write; an unconfigured TOKEN_VERIFY_URL is a logged skip.
 * The scheduled handler additionally isolates this module behind its one
 * permitted top-level try/catch, so even a probe implementation bug cannot
 * escape the handler — and it can never touch the sync routes either way.
 */

import { postDiscordEmbed, type DiscordEmbed, type DiscordEmbedField } from "./discord";

/** The 5-minute cron this module owns (dispatch on event.cron in index.ts). */
export const CONTROL_PLANE_PROBE_CRON = "*/5 * * * *";

/** KV key (in AUTH_CACHE, `control:` prefix like the kill switch). */
export const PROBE_STATE_KEY = "control:uptime-probe";

/** Deliberately invalid credentials — the probe asserts that REJECTION works. */
export const PROBE_TOKEN = "cmem-uptime-probe-invalid-token";
export const PROBE_USER_ID = "00000000-0000-0000-0000-000000000000";

/** Hard deadline for each probe request. */
export const PROBE_TIMEOUT_MS = 10_000;

/** While failing, re-page at most this often. */
export const PROBE_REALERT_MS = 30 * 60 * 1000;

const FOOTER = "sync-hub control-plane probe • healthy = 401/403 + JSON for a bogus token";

interface ProbeObservation {
	healthy: boolean;
	/** Machine-readable failure class ("" when healthy). */
	kind:
		| ""
		| "unreachable"
		| "timeout"
		| "http_5xx"
		| "non_json"
		| "unexpected_status"
		| "security_2xx";
	/** Human-readable one-liner for logs and the Discord embed. */
	reason: string;
	httpStatus: number | null;
}

export interface ProbeResult {
	status:
		| "skipped" // TOKEN_VERIFY_URL unconfigured
		| "silenced" // maintenance silence window active (no fetch at all)
		| "healthy" // steady state — log line only
		| "blip" // single failure, confirm-retry healthy — nothing done
		| "alerted" // confirmed first failure — paged + state written
		| "suppressed" // still failing, inside the 30-min re-alert window
		| "realerted" // still failing, window elapsed — paged again
		| "recovered" // healthy after a failure state — green post + cleared
		| "silence_cleared"; // healthy after an EXPIRED silence — cleared quietly
	kind?: string;
	reason?: string;
	httpStatus?: number | null;
	security?: boolean;
	discord: "sent" | "failed" | "not_configured" | "skipped";
	kv: "written" | "cleared" | "none" | "error";
}

export interface ProbeDeps {
	/** Injectable for tests; defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Injectable clock (tests). */
	now?: () => number;
	/** Test seam only; production always uses PROBE_TIMEOUT_MS. */
	timeoutMs?: number;
}

/**
 * One GET against the verify endpoint, classified. HEALTHY iff the response
 * is 401/403 with a JSON content-type AND a body that parses as JSON —
 * exactly the answer that requires the app and its Postgres lookup to both
 * be alive. Everything else is a named failure class.
 */
async function probeOnce(
	url: string,
	fetchImpl: typeof fetch,
	timeoutMs: number,
): Promise<ProbeObservation> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort("control-plane probe deadline exceeded");
			reject(new Error("probe_timeout"));
		}, timeoutMs);
	});
	let res: Response;
	try {
		// Race a hard deadline — never depend on the fetch implementation
		// honoring AbortSignal (same rationale as fetchProjectionWithTimeout).
		res = await Promise.race([
			fetchImpl(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${PROBE_TOKEN}`,
					"X-User-Id": PROBE_USER_ID,
				},
				signal: controller.signal,
			}),
			deadline,
		]);
	} catch (e) {
		if (e instanceof Error && e.message === "probe_timeout") {
			return {
				healthy: false,
				kind: "timeout",
				reason: `no response within ${timeoutMs}ms`,
				httpStatus: null,
			};
		}
		return {
			healthy: false,
			kind: "unreachable",
			reason: `fetch failed: ${String(e)}`,
			httpStatus: null,
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}

	if (res.status >= 200 && res.status < 300) {
		// The bogus token was ACCEPTED — an auth bypass, not an outage.
		return {
			healthy: false,
			kind: "security_2xx",
			reason: `HTTP ${res.status} for a deliberately invalid token`,
			httpStatus: res.status,
		};
	}
	if (res.status === 401 || res.status === 403) {
		const contentType = res.headers.get("Content-Type") ?? "";
		if (!contentType.toLowerCase().includes("json")) {
			// An HTML 401 is an edge/proxy answering FOR a dead app.
			return {
				healthy: false,
				kind: "non_json",
				reason: `HTTP ${res.status} with non-JSON content-type "${contentType}"`,
				httpStatus: res.status,
			};
		}
		try {
			await res.json();
		} catch {
			return {
				healthy: false,
				kind: "non_json",
				reason: `HTTP ${res.status} claims JSON but the body does not parse`,
				httpStatus: res.status,
			};
		}
		return { healthy: true, kind: "", reason: "", httpStatus: res.status };
	}
	if (res.status >= 500) {
		return {
			healthy: false,
			kind: "http_5xx",
			reason: `HTTP ${res.status}`,
			httpStatus: res.status,
		};
	}
	return {
		healthy: false,
		kind: "unexpected_status",
		reason: `HTTP ${res.status} (expected 401/403 + JSON)`,
		httpStatus: res.status,
	};
}

/**
 * Parse the KV state. null = no state. A present-but-unparseable value is
 * treated as a failing state of unknown age (an operator hand-put counts).
 */
function parseState(raw: string | null): Record<string, unknown> | null {
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

async function writeState(
	env: Env,
	state: Record<string, unknown>,
): Promise<"written" | "error"> {
	try {
		await env.AUTH_CACHE.put(PROBE_STATE_KEY, JSON.stringify(state));
		return "written";
	} catch (e) {
		console.error("sync-hub control-plane probe: KV state write failed:", e);
		return "error";
	}
}

async function deleteState(env: Env): Promise<"cleared" | "error"> {
	try {
		await env.AUTH_CACHE.delete(PROBE_STATE_KEY);
		return "cleared";
	} catch (e) {
		console.error("sync-hub control-plane probe: KV state delete failed:", e);
		return "error";
	}
}

async function sendProbeEmbed(
	env: Env,
	embed: DiscordEmbed,
	fetchImpl: typeof fetch,
): Promise<"sent" | "failed" | "not_configured"> {
	const webhook = (env.DISCORD_WEBHOOK_URL ?? "").trim();
	if (webhook === "") {
		console.error(
			"sync-hub control-plane probe: alert due but DISCORD_WEBHOOK_URL is not configured",
		);
		return "not_configured";
	}
	try {
		await postDiscordEmbed(webhook, embed, fetchImpl);
		return "sent";
	} catch (e) {
		// Swallowed by design: a Discord outage must never throw out of the
		// scheduled handler, and the KV state write has already happened.
		console.error("sync-hub control-plane probe: Discord post failed:", e);
		return "failed";
	}
}

function buildDownEmbed(
	url: string,
	observation: ProbeObservation,
	firstFailureAt: string,
	nowIso: string,
	realert: boolean,
): DiscordEmbed {
	const fields: DiscordEmbedField[] = [
		{ name: "Probe target", value: url, inline: false },
		{ name: "Observed", value: observation.reason, inline: false },
		{ name: "Failing since", value: firstFailureAt, inline: false },
		{
			name: "Policy",
			value:
				"Confirmed by an immediate in-run retry; re-pages every 30 min while failing; " +
				"green embed on recovery. Maintenance silence: DEPLOY.md §7.",
			inline: false,
		},
	];
	if (observation.kind === "security_2xx") {
		return {
			title: "🟥 SECURITY: cmem.ai verify endpoint ACCEPTED a bogus token",
			description:
				`GET ${url} answered 2xx to a deliberately invalid bearer token ` +
				`(${observation.reason}). That is an authentication bypass, not an ` +
				"outage — any token may currently be treated as valid. Treat as a " +
				"security incident, not a reliability one.",
			color: 0x7f1d1d, // darkest red — visually distinct from the outage embed
			fields,
			footer: { text: FOOTER },
			timestamp: nowIso,
		};
	}
	return {
		title: realert
			? "🚨 cmem.ai control plane STILL DOWN (uptime probe)"
			: "🚨 cmem.ai control plane DOWN (uptime probe)",
		description:
			`GET ${url} no longer answers 401/403 + JSON for a bogus token — the Pro ` +
			"app and/or its Postgres lookup is not responding (the exact failure " +
			"mode of the Jul 20–22 silent Supabase pause). Signups and token " +
			`verification are likely failing NOW. Observed: ${observation.reason}.`,
		color: 0xdc2626, // red
		fields,
		footer: { text: FOOTER },
		timestamp: nowIso,
	};
}

function buildRecoveredEmbed(url: string, firstFailureAt: string, nowIso: string): DiscordEmbed {
	return {
		title: "✅ cmem.ai control plane recovered (uptime probe)",
		description:
			`GET ${url} answers 401/403 + JSON again — the Pro app and its Postgres ` +
			"lookup are back. Failure state cleared.",
		color: 0x16a34a, // green
		fields: [
			{ name: "Probe target", value: url, inline: false },
			{ name: "Was failing since", value: firstFailureAt, inline: false },
		],
		footer: { text: FOOTER },
		timestamp: nowIso,
	};
}

/**
 * One probe pass. Never throws. Returns a structured result the scheduled
 * handler logs as one JSON line (visible via observability).
 */
export async function runControlPlaneProbe(
	env: Env,
	deps: ProbeDeps = {},
): Promise<ProbeResult> {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const now = deps.now ?? Date.now;
	const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;

	const result: ProbeResult = { status: "healthy", discord: "skipped", kv: "none" };

	const url = (env.TOKEN_VERIFY_URL ?? "").trim();
	if (url === "") {
		// Unconfigured is a deliberate state (local dev) — a loud log line,
		// never a false alert and never a crash.
		result.status = "skipped";
		result.reason = "TOKEN_VERIFY_URL not configured";
		return result;
	}

	// State BEFORE probing: a maintenance silence must suppress even the fetch.
	let raw: string | null = null;
	try {
		raw = await env.AUTH_CACHE.get(PROBE_STATE_KEY);
	} catch (e) {
		// Fail toward alerting: unreadable state is treated as "no prior
		// state", so a real outage still pages (possibly more often than every
		// 30 min while KV itself is broken — the acceptable direction).
		console.error("sync-hub control-plane probe: KV state read failed:", e);
	}
	const state = parseState(raw);
	const nowMs = now();
	const nowIso = new Date(nowMs).toISOString();

	// Maintenance silence marker (operator-written, DEPLOY.md §7).
	const silence = typeof state?.silenced_until === "string" ? state.silenced_until : null;
	if (silence !== null) {
		const until = Date.parse(silence);
		if (Number.isFinite(until) && until > nowMs) {
			result.status = "silenced";
			result.reason = `silenced until ${silence}`;
			return result;
		}
	}

	const observation = await probeOnce(url, fetchImpl, timeoutMs);

	// The prior state is a probe-written failure record unless it is a
	// (now expired) operator silence marker.
	const failingBefore = state !== null && silence === null;

	if (observation.healthy) {
		if (state === null) {
			// Healthy steady state: log line only. Deliberately NO KV write.
			return result;
		}
		if (silence !== null) {
			// Expired maintenance silence + healthy endpoint: clean up quietly —
			// there was never an alert to green-close.
			result.status = "silence_cleared";
			result.kv = await deleteState(env);
			return result;
		}
		// Transition failing → healthy: one green embed, then clear the state.
		result.status = "recovered";
		const firstFailureAt =
			typeof state.first_failure_at === "string" ? state.first_failure_at : "unknown";
		result.kv = await deleteState(env);
		result.discord = await sendProbeEmbed(
			env,
			buildRecoveredEmbed(url, firstFailureAt, nowIso),
			fetchImpl,
		);
		return result;
	}

	result.kind = observation.kind;
	result.reason = observation.reason;
	result.httpStatus = observation.httpStatus;

	if (failingBefore) {
		// Already in the failing state: no confirm-retry needed, and no KV
		// write unless this tick re-alerts (steady failing state stays quiet).
		const lastAlertParsed =
			typeof state.last_alert_at === "string" ? Date.parse(state.last_alert_at) : NaN;
		const due = !Number.isFinite(lastAlertParsed) || nowMs - lastAlertParsed >= PROBE_REALERT_MS;
		if (!due) {
			result.status = "suppressed";
			return result;
		}
		const firstFailureAt =
			typeof state.first_failure_at === "string" ? state.first_failure_at : nowIso;
		const security = observation.kind === "security_2xx";
		result.security = security;
		result.status = "realerted";
		// State first, ping second (the watchdog's switch-first ordering): the
		// record is load-bearing, the Discord post is a courtesy.
		result.kv = await writeState(env, {
			status: "failing",
			first_failure_at: firstFailureAt,
			last_alert_at: nowIso,
			kind: observation.kind,
			reason: observation.reason,
			security,
		});
		result.discord = await sendProbeEmbed(
			env,
			buildDownEmbed(url, observation, firstFailureAt, nowIso, true),
			fetchImpl,
		);
		return result;
	}

	// First failure (or a failure right after an expired silence): confirm
	// with ONE immediate in-run retry before paging — a single blip never
	// alerts. A real auth bypass (security_2xx) is deterministic and confirms.
	const confirm = await probeOnce(url, fetchImpl, timeoutMs);
	if (confirm.healthy) {
		result.status = "blip";
		return result;
	}
	// The confirming observation is the most recent evidence — report it.
	result.kind = confirm.kind;
	result.reason = confirm.reason;
	result.httpStatus = confirm.httpStatus;
	const security = confirm.kind === "security_2xx";
	result.security = security;
	result.status = "alerted";
	result.kv = await writeState(env, {
		status: "failing",
		first_failure_at: nowIso,
		last_alert_at: nowIso,
		kind: confirm.kind,
		reason: confirm.reason,
		security,
	});
	result.discord = await sendProbeEmbed(
		env,
		buildDownEmbed(url, confirm, nowIso, nowIso, false),
		fetchImpl,
	);
	return result;
}
