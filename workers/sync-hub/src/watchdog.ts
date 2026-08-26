/**
 * Watchdog — hourly cost/behavior monitor for the SyncHub DO namespace
 * (plan Phase 5 task 1).
 *
 * Runs in the SCHEDULED handler of the stateless front Worker (cron in
 * wrangler.jsonc) — NEVER in the Durable Object (anti-pattern #3: no
 * outbound I/O from the DO; the watchdog is pure outbound I/O). It queries
 * the Cloudflare GraphQL Analytics API for the last hour of DO metrics,
 * compares them against thresholds derived from the validated workload
 * model, and escalates:
 *
 *   ESCALATION LADDER
 *   1. healthy                      → nothing (a JSON log line only).
 *   2. any metric ≥ alert threshold → Discord alert (webhook, secret
 *      binding DISCORD_WEBHOOK_URL — payload shape copied from
 *      scripts/discord-release-notify.js).
 *   3. duration / rowsWritten / rowsRead ≥ kill threshold → auto-trip the
 *      kill switch (KV flag, src/kill-switch.ts) FIRST, then Discord.
 *      Remediation is structural: tripped ⇒ clients drop to the Phase 3
 *      poll path (WS refused, X-Sync-Mode: poll) — the product keeps
 *      working, the socket lane that pins DOs goes away.
 *   4. requests ≥ kill threshold    → severe Discord alert but NO auto-trip:
 *      poll mode does not reduce HTTP request volume (poll mode IS HTTP),
 *      so tripping the switch would not remediate — a human decides.
 *   A breach that persists re-alerts on every hourly run — intended:
 *   silence would hide an ongoing incident, and hourly cadence bounds the
 *   noise at one message per hour.
 *
 * DATASETS / FIELDS (verified 2026-07-18 against live Cloudflare docs —
 * developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/
 * lists the datasets; exact field names confirmed via the published GraphQL
 * schema (AccountDurableObjectsPeriodicGroupsSum et al.)):
 *   - durableObjectsInvocationsAdaptiveGroups
 *       sum { requests, errors }         filter: scriptName, datetime_geq/leq
 *   - durableObjectsPeriodicGroups
 *       sum { duration      — GB*s ("Sum of Duration - GB*s"),
 *             rowsRead      — "Sum of rows read (by sqlite backed DOs)",
 *             rowsWritten   — "Sum of rows written (by sqlite backed DOs)",
 *             activeTime    — microseconds (informational),
 *             inboundWebsocketMsgCount (informational) }
 *       dimensions include namespaceId (NOT scriptName) — so the periodic
 *       dataset is filtered by WATCHDOG_DO_NAMESPACE_ID when configured.
 *   Endpoint + auth verbatim from
 *   developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/:
 *   POST https://api.cloudflare.com/client/v4/graphql with
 *   `Authorization: Bearer <token>` (token scope: Account Analytics: Read).
 *
 * FAILURE CONTRACT: an unconfigured or failing watchdog NEVER false-alerts
 * and never crashes the Worker — missing config → logged skip; GraphQL
 * error → logged `query_failed`, no Discord, no kill switch. A Discord
 * failure never blocks the kill-switch write (the switch is the guardrail;
 * the ping is a courtesy).
 */

import { postDiscordEmbed, type DiscordEmbed, type DiscordEmbedField } from "./discord";
import { tripKillSwitch } from "./kill-switch";

export const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

// ---------------------------------------------------------------------------
// Thresholds — hourly, fleet-wide, derived from the decision record's
// validated workload model (~$5/mo at 100 users; 2 devices/user; duration
// ≈ 0 when hibernation works). Each is overridable via the same-named env
// var (wrangler.jsonc vars) so an incident or a fleet 10x never needs a
// code change.
// ---------------------------------------------------------------------------

/**
 * Requests/hour. Worst-case ALL 200 devices in active sessions at once:
 * 30 s pulls (120/h) + debounced pushes (≤60/h) + status ≈ 200 req/h/device
 * → 40,000/h absolute ceiling; typical concurrency (≲20% active) ≈ 8k/h.
 * ALERT 60,000 = 1.5x the all-active ceiling — sustained it is ≈44M/mo
 * ≈ $6.5/mo in DO requests alone ($0.15/M), i.e. invoice-visible.
 * KILL 600,000 = 10x alert — unambiguous runaway/flood (≈$65/mo run-rate).
 * Requests NEVER auto-trip (ladder rule 4).
 */
export const WATCHDOG_REQUESTS_ALERT = 60_000;
export const WATCHDOG_REQUESTS_KILL = 600_000;

/**
 * Duration GB-s/hour — THE hibernation-defeat detector. With hibernation
 * working, duration is handler-execution only: even the 40k/h all-active
 * request ceiling at ~5 ms/handler is 200 s × 0.125 GB = 25 GB-s/h; the
 * 24/7 canary contributes a small known constant. One DO pinned awake is
 * 3,600 s × 0.125 GB = 450 GB-s/h — which is exactly the documented
 * $4.11/device/mo trap (450 × 730 h × $12.50/M GB-s ≈ $4.11).
 * ALERT 50 = 2x the theoretical handler ceiling, yet only ~11% of one
 * pinned DO — a single pinned DO trips this within ~7 minutes of the hour.
 * KILL 450 = ≥ one full DO-hour pinned. Auto-trip REMEDIATES causally:
 * poll mode refuses new sockets and clients close existing ones on their
 * next HTTP response, un-pinning the DOs.
 */
export const WATCHDOG_DURATION_ALERT_GBS = 50;
export const WATCHDOG_DURATION_KILL_GBS = 450;

/**
 * Rows written/hour (SQLite billing: $1.00/M, the $34k-runaway metric —
 * note each setAlarm() is billed as one row written). Healthy writes track
 * requests: every push/pull upserts the device row (1 row) plus pushed op
 * rows → ≈50k/h at the all-active ceiling.
 * ALERT 150,000 = 3x — sustained ≈110M/mo ≈ $110/mo: the alarm-loop
 * failure class caught at a tiny fraction of its blast radius.
 * KILL 1,500,000 = 10x alert (≈$1,100/mo run-rate) — trip immediately.
 */
export const WATCHDOG_ROWS_WRITTEN_ALERT = 150_000;
export const WATCHDOG_ROWS_WRITTEN_KILL = 1_500_000;

/**
 * Rows read/hour (SQLite billing: $0.001/M — cost-trivial, so this is a
 * BEHAVIOR detector, not an invoice one). Healthy: a poll with no new data
 * reads ~10 rows → ≈400k/h ceiling; a fresh-device bootstrap legitimately
 * reads an entire log (100k+) in one burst.
 * ALERT 5,000,000 ≈ 12x the ceiling — clears any legitimate bootstrap
 * burst; sustained it means a hot scan loop (e.g. a repair scan gone
 * quadratic). KILL 50,000,000 = 10x alert: still only ≈$36/mo but
 * unambiguously a runaway query pattern.
 */
export const WATCHDOG_ROWS_READ_ALERT = 5_000_000;
export const WATCHDOG_ROWS_READ_KILL = 50_000_000;

/** Metrics whose KILL breach auto-trips the switch (ladder rule 3; requests is rule 4 — never auto-trips). */
const AUTO_TRIP_METRICS: ReadonlySet<string> = new Set([
	"duration_gbs",
	"rows_written",
	"rows_read",
]);

interface ThresholdSpec {
	metric: string;
	label: string;
	alertDefault: number;
	killDefault: number;
	alertEnv: string;
	killEnv: string;
}

const THRESHOLDS: ThresholdSpec[] = [
	{
		metric: "requests",
		label: "requests/hour",
		alertDefault: WATCHDOG_REQUESTS_ALERT,
		killDefault: WATCHDOG_REQUESTS_KILL,
		alertEnv: "WATCHDOG_REQUESTS_ALERT",
		killEnv: "WATCHDOG_REQUESTS_KILL",
	},
	{
		metric: "duration_gbs",
		label: "duration GB-s/hour",
		alertDefault: WATCHDOG_DURATION_ALERT_GBS,
		killDefault: WATCHDOG_DURATION_KILL_GBS,
		alertEnv: "WATCHDOG_DURATION_ALERT_GBS",
		killEnv: "WATCHDOG_DURATION_KILL_GBS",
	},
	{
		metric: "rows_written",
		label: "rows written/hour",
		alertDefault: WATCHDOG_ROWS_WRITTEN_ALERT,
		killDefault: WATCHDOG_ROWS_WRITTEN_KILL,
		alertEnv: "WATCHDOG_ROWS_WRITTEN_ALERT",
		killEnv: "WATCHDOG_ROWS_WRITTEN_KILL",
	},
	{
		metric: "rows_read",
		label: "rows read/hour",
		alertDefault: WATCHDOG_ROWS_READ_ALERT,
		killDefault: WATCHDOG_ROWS_READ_KILL,
		alertEnv: "WATCHDOG_ROWS_READ_ALERT",
		killEnv: "WATCHDOG_ROWS_READ_KILL",
	},
];

export interface WatchdogMetrics {
	requests: number;
	errors: number;
	duration_gbs: number;
	rows_read: number;
	rows_written: number;
	active_time_us: number;
	inbound_ws_messages: number;
}

export interface WatchdogBreach {
	metric: string;
	label: string;
	value: number;
	alertThreshold: number;
	killThreshold: number;
	severe: boolean;
	/** severe AND in the auto-trip set. */
	autoTrip: boolean;
}

export interface WatchdogResult {
	status: "skipped" | "query_failed" | "healthy" | "alert" | "severe";
	reason?: string;
	metrics?: WatchdogMetrics;
	breaches: WatchdogBreach[];
	discord: "sent" | "failed" | "not_configured" | "skipped";
	killSwitch: "tripped" | "already_tripped" | "none";
	windowStart?: string;
	windowEnd?: string;
}

export interface WatchdogDeps {
	/** Injectable for tests; defaults to globalThis.fetch. */
	fetchImpl?: typeof fetch;
	/** Injectable clock (tests). */
	now?: () => number;
}

function envNumber(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return fallback;
	return parsed;
}

function sumField(groups: unknown, field: string): number {
	if (!Array.isArray(groups)) return 0;
	let total = 0;
	for (const group of groups) {
		const sum = (group as { sum?: Record<string, unknown> } | null)?.sum;
		const value = sum?.[field];
		if (typeof value === "number" && Number.isFinite(value)) total += value;
	}
	return total;
}

/**
 * Build the GraphQL query. Variable declarations use the lowercase `string`
 * scalar exactly as the querying-workers-metrics tutorial does. The periodic
 * dataset has no scriptName dimension, so it is filtered by namespaceId when
 * WATCHDOG_DO_NAMESPACE_ID is configured (account-wide otherwise — correct
 * for an account whose only DO namespace is the sync hub, and documented as
 * a deploy step in DEPLOY.md).
 */
function buildQuery(namespaceId: string): string {
	const periodicFilter = namespaceId
		? "{namespaceId: $namespaceId, datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd}"
		: "{datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd}";
	const namespaceVar = namespaceId ? ", $namespaceId: string" : "";
	return `query SyncHubWatchdog($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string${namespaceVar}) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      invocations: durableObjectsInvocationsAdaptiveGroups(
        limit: 1000,
        filter: {scriptName: $scriptName, datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd}
      ) {
        sum { requests errors }
      }
      periodic: durableObjectsPeriodicGroups(
        limit: 1000,
        filter: ${periodicFilter}
      ) {
        sum { duration rowsRead rowsWritten activeTime inboundWebsocketMsgCount }
      }
    }
  }
}`;
}

interface GraphQLOutcome {
	ok: true;
	metrics: WatchdogMetrics;
}

interface GraphQLFailure {
	ok: false;
	reason: string;
}

async function queryMetrics(
	env: Env,
	fetchImpl: typeof fetch,
	windowStart: string,
	windowEnd: string,
	accountId: string,
	/** Already trimmed by runWatchdog — the ONE place the secret is read
	 * (a trailing-newline paste in `wrangler secret put` must not survive
	 * into the Authorization header). */
	token: string,
): Promise<GraphQLOutcome | GraphQLFailure> {
	const namespaceId = (env.WATCHDOG_DO_NAMESPACE_ID ?? "").trim();
	const scriptName = (env.WATCHDOG_SCRIPT_NAME ?? "").trim() || "sync-hub";
	const variables: Record<string, string> = {
		accountTag: accountId,
		datetimeStart: windowStart,
		datetimeEnd: windowEnd,
		scriptName,
	};
	if (namespaceId) variables.namespaceId = namespaceId;

	let res: Response;
	try {
		res = await fetchImpl(GRAPHQL_ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query: buildQuery(namespaceId), variables }),
		});
	} catch (e) {
		return { ok: false, reason: `graphql fetch failed: ${String(e)}` };
	}
	if (!res.ok) {
		const body = (await res.text().catch(() => "")).slice(0, 300);
		return { ok: false, reason: `graphql http ${res.status}: ${body}` };
	}
	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch {
		return { ok: false, reason: "graphql response is not JSON" };
	}
	const record = parsed as {
		errors?: unknown;
		data?: { viewer?: { accounts?: unknown } };
	} | null;
	if (Array.isArray(record?.errors) && record.errors.length > 0) {
		return {
			ok: false,
			reason: `graphql errors: ${JSON.stringify(record.errors).slice(0, 300)}`,
		};
	}
	const accounts = record?.data?.viewer?.accounts;
	if (!Array.isArray(accounts) || accounts.length === 0) {
		return { ok: false, reason: "graphql returned no accounts (check ACCOUNT_ID)" };
	}
	const account = accounts[0] as { invocations?: unknown; periodic?: unknown };
	return {
		ok: true,
		metrics: {
			requests: sumField(account.invocations, "requests"),
			errors: sumField(account.invocations, "errors"),
			duration_gbs: sumField(account.periodic, "duration"),
			rows_read: sumField(account.periodic, "rowsRead"),
			rows_written: sumField(account.periodic, "rowsWritten"),
			active_time_us: sumField(account.periodic, "activeTime"),
			inbound_ws_messages: sumField(account.periodic, "inboundWebsocketMsgCount"),
		},
	};
}

function evaluate(env: Env, metrics: WatchdogMetrics): WatchdogBreach[] {
	const vars = env as unknown as Record<string, string | undefined>;
	const breaches: WatchdogBreach[] = [];
	for (const spec of THRESHOLDS) {
		const value = metrics[spec.metric as keyof WatchdogMetrics];
		const alertThreshold = envNumber(vars[spec.alertEnv], spec.alertDefault);
		const killThreshold = envNumber(vars[spec.killEnv], spec.killDefault);
		// Breach gate is min(alert, kill), NOT alert alone: an operator who
		// lowers only the kill threshold (e.g. the DEPLOY.md §5 rehearsal)
		// must get exactly what the config says — gating on alert would make
		// a kill-below-alert configuration silently inert.
		if (value < Math.min(alertThreshold, killThreshold)) continue;
		const severe = value >= killThreshold;
		breaches.push({
			metric: spec.metric,
			label: spec.label,
			value,
			alertThreshold,
			killThreshold,
			severe,
			autoTrip: severe && AUTO_TRIP_METRICS.has(spec.metric),
		});
	}
	return breaches;
}

/**
 * Discord embed, shape copied from scripts/discord-release-notify.js
 * (posted via the shared src/discord.ts helper, which owns the
 * {embeds: [embed]} envelope). The webhook URL is a SECRET binding — never
 * hardcoded.
 */
function buildDiscordEmbed(
	severe: boolean,
	breaches: WatchdogBreach[],
	metrics: WatchdogMetrics,
	killSwitch: WatchdogResult["killSwitch"],
	windowStart: string,
	windowEnd: string,
): DiscordEmbed {
	const fields: DiscordEmbedField[] = breaches.map((b) => ({
		name: `${b.severe ? "🔴" : "🟠"} ${b.label}`,
		value: `${b.value.toLocaleString("en-US")} (alert ≥ ${b.alertThreshold.toLocaleString("en-US")}, kill ≥ ${b.killThreshold.toLocaleString("en-US")})`,
		inline: false,
	}));
	fields.push({
		name: "Kill switch",
		value:
			killSwitch === "tripped"
				? "AUTO-TRIPPED — clients are dropping to poll mode. Clear with `wrangler kv key delete` (see DEPLOY.md) once resolved."
				: killSwitch === "already_tripped"
					? "Already tripped (still in poll mode)."
					: "Not tripped.",
		inline: false,
	});
	return {
		title: severe
			? "🚨 sync-hub watchdog: SEVERE threshold breach"
			: "⚠️ sync-hub watchdog: threshold breach",
		description:
			`DO metrics for ${windowStart} → ${windowEnd} (last hour).\n` +
			`requests=${metrics.requests.toLocaleString("en-US")}, ` +
			`duration=${metrics.duration_gbs.toFixed(2)} GB-s, ` +
			`rowsRead=${metrics.rows_read.toLocaleString("en-US")}, ` +
			`rowsWritten=${metrics.rows_written.toLocaleString("en-US")}, ` +
			`errors=${metrics.errors.toLocaleString("en-US")}, ` +
			`inboundWsMsgs=${metrics.inbound_ws_messages.toLocaleString("en-US")}`,
		color: severe ? 0xdc2626 : 0xf59e0b, // red / amber
		fields,
		footer: {
			text: "sync-hub watchdog • poll mode keeps the product complete",
		},
		timestamp: new Date().toISOString(),
	};
}

/**
 * One watchdog pass. Never throws. Returns a structured result the
 * scheduled handler logs as one JSON line (visible via observability).
 */
export async function runWatchdog(env: Env, deps: WatchdogDeps = {}): Promise<WatchdogResult> {
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const now = deps.now ?? Date.now;

	const result: WatchdogResult = {
		status: "healthy",
		breaches: [],
		discord: "skipped",
		killSwitch: "none",
	};

	const accountId = (env.ACCOUNT_ID ?? "").trim();
	const token = (env.ANALYTICS_API_TOKEN ?? "").trim();
	if (accountId === "" || token === "") {
		// Unconfigured is a deliberate state (local dev, fresh deploy) — a
		// loud log line, never a false alert and never a crash.
		result.status = "skipped";
		result.reason = "ACCOUNT_ID and/or ANALYTICS_API_TOKEN not configured";
		return result;
	}

	// Trailing 60-minute window. The hourly cadence bounds detection latency;
	// adaptive-dataset ingest lag can shave a few tail minutes off the
	// window, which the ≥1.5x threshold headroom absorbs.
	const end = new Date(now());
	const start = new Date(end.getTime() - 60 * 60 * 1000);
	result.windowStart = start.toISOString();
	result.windowEnd = end.toISOString();

	const outcome = await queryMetrics(env, fetchImpl, result.windowStart, result.windowEnd, accountId, token);
	if (!outcome.ok) {
		// GraphQL failure: logged, NO alert, NO kill switch — a broken
		// analytics pipe must not fabricate an incident.
		result.status = "query_failed";
		result.reason = outcome.reason;
		console.error("sync-hub watchdog query failed:", outcome.reason);
		return result;
	}
	result.metrics = outcome.metrics;

	const breaches = evaluate(env, outcome.metrics);
	result.breaches = breaches;
	if (breaches.length === 0) {
		result.status = "healthy";
		return result;
	}
	const severe = breaches.some((b) => b.severe);
	result.status = severe ? "severe" : "alert";

	// Kill switch FIRST (ladder rule 3): the structural remediation must
	// never wait on — or be lost to — a Discord failure.
	if (breaches.some((b) => b.autoTrip)) {
		try {
			const trip = await tripKillSwitch(env, {
				source: "watchdog",
				window_start: result.windowStart,
				window_end: result.windowEnd,
				breaches: breaches
					.filter((b) => b.autoTrip)
					.map((b) => ({ metric: b.metric, value: b.value, kill: b.killThreshold })),
			});
			result.killSwitch = trip.alreadyTripped ? "already_tripped" : "tripped";
		} catch (e) {
			// KV write failure: nothing left to do but scream — the Discord
			// alert below still goes out with killSwitch = "none".
			console.error("sync-hub watchdog failed to trip the kill switch:", e);
		}
	}

	const webhook = (env.DISCORD_WEBHOOK_URL ?? "").trim();
	if (webhook === "") {
		result.discord = "not_configured";
		console.error(
			"sync-hub watchdog: threshold breach but DISCORD_WEBHOOK_URL is not configured",
			JSON.stringify(breaches),
		);
		return result;
	}
	try {
		const embed = buildDiscordEmbed(
			severe,
			breaches,
			outcome.metrics,
			result.killSwitch,
			result.windowStart,
			result.windowEnd,
		);
		await postDiscordEmbed(webhook, embed, fetchImpl);
		result.discord = "sent";
	} catch (e) {
		result.discord = "failed";
		console.error("sync-hub watchdog Discord alert failed:", e);
	}
	return result;
}
