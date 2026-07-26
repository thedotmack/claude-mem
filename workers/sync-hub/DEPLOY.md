# sync-hub — Deploy Runbook

Production deployment steps for the two-lane sync hub (plan
`plans/2026-07-17-phase5-two-lane-sync.md`). Everything below is a
**production-only** action: local Vitest and the canonical matrix E2E need none
of it. The matrix starts an ephemeral local Miniflare Worker/SQLite Durable
Object plus loopback-only verifier/projector sidecars.

Prime directive for every knob in this file: **cost guardrails are
structural — watchdog trips → poll mode, never "stop working."** A tripped
kill switch degrades sync latency to the Phase 3 poll path (~$0.03/user/mo
indefinitely); it never loses data and never stops the product.

---

## 1. Prerequisites (Phase 1)

### 1.1 KV namespace (`AUTH_CACHE`)

```sh
cd workers/sync-hub
wrangler kv namespace create AUTH_CACHE
```

Paste the returned id into `wrangler.jsonc` → `kv_namespaces[0].id`
(replacing the `00000000…` placeholder). This one namespace serves two
purposes, separated by key prefix:

- `verdict:<sha256>` — positive token-verification verdicts (short TTL).
- `control:kill-switch` — the kill-switch flag (no TTL; see §3).

A dedicated `SYNC_CONTROL` namespace was considered and rejected: the
switch must exist in every environment the Worker deploys to, and a second
namespace is one more thing whose absence fails the whole deploy — the
wrong failure mode for an emergency brake (full rationale in
`src/kill-switch.ts`).

### 1.2 Token verification (`TOKEN_VERIFY_URL`)

The Pro route exists at `https://cmem.ai/api/pro/sync/verify`. Deployment order
is load-bearing: deploy the Pro route first, canary it with a test-account token
and exact `X-User-Id` binding, then configure this URL and activate SyncHub.
Never activate the Hub while the route is absent or uncanaried. HARD CONTRACT
(enforced by `src/index.ts:authenticateRequest`): on 2xx the endpoint MUST
return the canonical user id the token belongs to, as JSON `{userId}` or
`{user_id}`. Without that binding any valid subscriber token could act as any
claimed user id.

SyncHub is the sole positive cache in this composed verification path. The Pro
route performs a fresh identity lookup, while `AUTH_CACHE` positives are fixed
at 60 seconds (Cloudflare KV's minimum). This preserves the dashboard promise
that rotating a setup token stops uploads within 60 seconds and bounds any
time-limited entitlement overrun to the same interval.

There is no local or production authentication bypass. Vitest intercepts the
verify request with Miniflare's mocked outbound service; manual `wrangler dev`
sessions require a reachable verifier and a test-account token.

### 1.3 Canonical projection and repair

Deploy Pro's `POST /api/internal/sync/project` route before this Worker. Set one
random shared credential in both deployments (never a normal user token):

```sh
cd workers/sync-hub
wrangler secret put CMEM_INTERNAL_PROJECTOR_SECRET
```

The Worker posts at most 100 canonical operations / 4,000,000 encoded bytes to
`INTERNAL_PROJECTOR_URL`. The byte cap covers the complete JSON request,
including the envelope, brackets, and commas. Timing is deliberately fenced:

```text
Hub response-body abort (45s) < Pro maxDuration (60s) < Hub lease (90s)
```

The Hub heartbeats immediately before the bounded fetch and performs the token
check plus checkpoint compare-and-set in one synchronous transaction. A stale
request cannot checkpoint after a successor acquires a new token.

If a fetch times out/aborts, fails at the network, returns a retryable status,
or yields a truncated, invalid, or ambiguous response, the Hub deliberately
keeps the 90-second lease until its natural expiry. The upstream handler may
have ignored cancellation and may still be applying the request. Early lease
release is allowed only after a valid response has been checkpointed, an
authoritative checkpoint already proves the target complete, or Pro returns
its deterministic nonretryable 409 outcome.

A public push returns 200 only after the Hub's authoritative `projected_seq`
covers the committed `head_seq`. Retryable projection failures after a durable
append return 503 with `durable:true` and `retryable:true`; retrying the
identical operation reuses its sequence and resumes projection. Pro's
deterministic document/revision rejection returns nonretryable 409 and never
advances the Hub checkpoint.

Pro's scheduled repair job calls the secret-authenticated endpoint once per
user whose projection may lag:

```sh
curl -fsS https://<sync-hub>/internal/v1/projection/drain \
  -H "Authorization: Bearer $CMEM_INTERNAL_PROJECTOR_SECRET" \
  -H 'Content-Type: application/json' \
  --data '{"protocol_version":1,"user_id":"<canonical-lowercase-uuid>"}'
```

An optional decimal-string `through_seq` caps the repair. Success returns the
Hub epoch, head, and `projected_through_seq`; 503 is durable/retryable and a
deterministic Pro document rejection is 409/nonretryable. Never
infer projection success from Pro alone: only the Hub checkpoint is
authoritative.

Physical `canonical_ops` compaction is unconditionally disabled for launch.
The Durable Object alarm remains scheduled for deployment compatibility but is
a no-op that deletes zero rows; there is no environment variable, threshold,
or endpoint that can enable deletion. Keep the full ordered log until a
snapshot/reset bootstrap protocol exists, so a newly first-seen device at
cursor `0` can always replay contiguous history.

### 1.4 Device admission ceiling

The Durable Object admits at most 64 distinct device ids per user, atomically,
across push, pull, and WebSocket touch paths. A 65th id on an admitting path
returns `409 {"error":"device_limit_exceeded"}`; already-registered devices
continue normally. Public status and internal metadata are read-only for an
unknown id, so connectivity probes cannot consume or exhaust device slots;
status may refresh last-seen/name only for an already-registered device.
Unknown-device renames also create nothing. Treat the stable 409 from an
admitting path as an account/device-management condition, not a retriable
transport failure.

### 1.5 Local Pro/Hub Miniflare E2E hook

The canonical client matrix is the safe default from the repository root:

```sh
npm run e2e:sync-matrix
```

It drives exactly two file-backed client stacks against the actual bundled
Worker and SQLite Durable Object. The Hub, token verifier, and projector all
bind ephemeral `127.0.0.1` ports; runtime guards reject any non-loopback URL.
It covers WebSocket hints plus HTTP authority, concurrent writes, offline
retry, restart, delete/revive, all three mutation types, decimal cursors, and
the projection checkpoint reaching the head. The runner owns clean shutdown
and leaves no persistent Hub or client state.

`test/miniflare-pro-e2e.ts` exports
`createSyncHubMiniflareE2EOptions(...)`. A sibling Pro Vitest config passes its
relative Hub checkout path as `workerRoot`, plus explicit loopback projection
and verification URLs. The returned options run the real
`src/index.ts`/`SyncHub` Durable Object with `wrangler.jsonc`; they intentionally
contain no outbound-service mock. For example, an orchestrator may use:

```sh
CMEM_PRO_REPO_PATH=../../../../claude-mem-pro \
INTERNAL_PROJECTOR_URL=http://127.0.0.1:3005/api/internal/sync/project \
TOKEN_VERIFY_URL=http://127.0.0.1:3005/api/pro/sync/verify \
CMEM_INTERNAL_PROJECTOR_SECRET=local-e2e-projector-secret-32-chars \
npm run test:pro-sync-e2e --prefix "$CMEM_PRO_REPO_PATH"
```

The Pro-side command owns server lifecycle and supplies its relative Hub path
to the helper. No production URL or workstation-specific absolute path belongs
in the E2E config.

### 1.6 Internal per-user reset (pre-launch state hygiene)

`POST /internal/v1/sync/reset` wipes ONE user's Durable Object back to
pristine state: empty log/heads/devices, projection checkpoint `0`, and a
fresh random epoch (so any device still holding an old cursor is forced to
re-bootstrap instead of silently mixing histories). Purpose: clearing
stale/corrupt **pre-launch** per-user DO state — it deletes the user's entire
ordered log, so never point it at a live post-launch account casually.
Auth and body contract mirror the drain endpoint (§1.3): the shared
`CMEM_INTERNAL_PROJECTOR_SECRET` bearer, exact-keys JSON body, 401 without the
secret, 400 on any contract deviation. The kill switch (§3) is Workers KV
state and is deliberately untouched by a reset.

```sh
curl -fsS https://<sync-hub>/internal/v1/sync/reset \
  -H "Authorization: Bearer $CMEM_INTERNAL_PROJECTOR_SECRET" \
  -H 'Content-Type: application/json' \
  --data '{"protocol_version":1,"user_id":"<canonical-lowercase-uuid>"}'
# → 200 {"protocol_version":1,"epoch":"<new>","head_seq":"0"}
```

For a Bun- or process-isolated Pro client, start the actual Hub in its own Node
process instead of importing workerd into Bun:

```sh
INTERNAL_PROJECTOR_URL=http://127.0.0.1:3005/api/internal/sync/project \
TOKEN_VERIFY_URL=http://127.0.0.1:3005/api/pro/sync/verify \
CMEM_INTERNAL_PROJECTOR_SECRET=local-e2e-projector-secret-32-chars \
npm run e2e:serve -- --host 127.0.0.1 --port 0
```

`test/run-miniflare-pro-e2e.mjs` prints one machine-readable ready line such as
`{"event":"ready","url":"http://127.0.0.1:58471/","pid":12345}`. The
caller sends requests to that URL and terminates the process with SIGTERM or
SIGINT. The wrapper disposes Miniflare, prints an `event:"stopped"` line, and
exits zero. Its runtime dependencies resolve from this package's
`workers/sync-hub/node_modules`; both `miniflare` and `esbuild` are direct
development dependencies.

---

## 2. Watchdog (Phase 5 task 1)

Hourly cron (`triggers.crons = ["7 * * * *"]`, already in `wrangler.jsonc`)
runs the `scheduled` handler → `src/watchdog.ts`. It queries the GraphQL
Analytics API for the last hour of DO metrics and escalates per the ladder
in §2.4.

### 2.1 Vars (`wrangler.jsonc` or dash)

| Var | Value |
|---|---|
| `ACCOUNT_ID` | Cloudflare account tag — the 32-hex id from the dash URL or the Workers overview sidebar. Empty ⇒ watchdog logs `{"status":"skipped"}` every hour and does nothing else. |
| `WATCHDOG_DO_NAMESPACE_ID` | The SyncHub DO namespace id — narrows the `durableObjectsPeriodicGroups` query (that dataset has no `scriptName` dimension). Optional while sync-hub is the account's only DO namespace. Fetch it: `curl -s -H "Authorization: Bearer <API_TOKEN>" https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/workers/durable_objects/namespaces` (or dash → Durable Objects). |
| `WATCHDOG_SCRIPT_NAME` | Only if the Worker is renamed; defaults to `sync-hub`. |
| `WATCHDOG_*_ALERT` / `WATCHDOG_*_KILL` | Threshold overrides; empty ⇒ code defaults (derivations in `src/watchdog.ts`). |

### 2.2 Secrets

```sh
cd workers/sync-hub
wrangler secret put ANALYTICS_API_TOKEN
wrangler secret put DISCORD_WEBHOOK_URL
```

- `ANALYTICS_API_TOKEN`: create at dash → My Profile → API Tokens with the
  scope **Account → Account Analytics → Read** (nothing else). Reference:
  developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/
- `DISCORD_WEBHOOK_URL`: the runtime credential lives in
  `~/Scripts/claude-mem/.env` as `DISCORD_UPDATES_WEBHOOK` — paste that
  value into the secret prompt. **Never hardcode or commit a webhook URL.**
  (Payload shape matches `scripts/discord-release-notify.js`.)

Secrets are deliberately NOT vars: a same-named var would shadow/conflict
with the secret at deploy time (typing lives in `src/secrets.d.ts`).

### 2.3 Datasets and thresholds (reference)

Datasets/fields (verified 2026-07-18 against
developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/
and the published GraphQL schema): `durableObjectsInvocationsAdaptiveGroups`
`sum{requests errors}` (filter `scriptName`, `datetime_geq/leq`);
`durableObjectsPeriodicGroups` `sum{duration rowsRead rowsWritten activeTime
inboundWebsocketMsgCount}` (filter `namespaceId`, `datetime_geq/leq`).
`sum.duration` is already in GB-s.

Hourly fleet-wide thresholds (defaults; derivations as comments in
`src/watchdog.ts`, anchored to the validated ~$5/mo @ 100-user model):

| Metric | Alert | Kill | Auto-trips switch? |
|---|---|---|---|
| requests/hour | 60,000 | 600,000 | **No** — poll mode is still HTTP; a human decides |
| duration GB-s/hour | 50 | 450 (= one DO pinned a full hour = the $4.11/device/mo trap) | Yes — causal remediation (closing sockets un-pins) |
| rows written/hour | 150,000 | 1,500,000 | Yes |
| rows read/hour | 5,000,000 | 50,000,000 | Yes |

### 2.4 Escalation ladder

1. Healthy → one `{"status":"healthy"}` log line (observability), nothing else.
2. Any metric ≥ alert → Discord alert (amber embed, all breaches listed).
3. duration / rows-written / rows-read ≥ kill → **kill switch auto-tripped
   first**, then Discord (red embed, "AUTO-TRIPPED"). A Discord failure
   never blocks the KV write.
4. requests ≥ kill → red Discord alert, **no auto-trip** (see table).
5. GraphQL query failure → `{"status":"query_failed"}` log line; NO alert,
   NO trip (a broken analytics pipe must not fabricate an incident).

### 2.5 Cron activation + smoke

The cron ships in `wrangler.jsonc`; `wrangler deploy` activates it (verify:
dash → Workers → sync-hub → Settings → Triggers → Cron Triggers). Local
smoke (verified in this repo):

```sh
wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=7+*+*+*+*"
# log: sync-hub watchdog: {"status":"skipped",...} (unconfigured = safe skip)
```

---

## 3. Kill switch operations (Phase 5 task 2)

State = presence of KV key `control:kill-switch` in `AUTH_CACHE`. Tripped ⇒
WS upgrades answer `503 {"error":…,"mode":"poll"}` and every HTTP sync
response carries `X-Sync-Mode: poll`; clients close their sockets, suppress
reconnects, and keep polling (their polls are also the re-probe).

```sh
cd workers/sync-hub
# Trip manually (any value works — presence is the contract):
wrangler kv key put --binding AUTH_CACHE "control:kill-switch" \
  '{"source":"manual","tripped_at":"'"$(date -u +%FT%TZ)"'","reason":"<why>"}' --remote
# Inspect:
wrangler kv key get --binding AUTH_CACHE "control:kill-switch" --remote
# Clear (recovery — the ONLY way; the watchdog never auto-clears, to avoid flapping):
wrangler kv key delete --binding AUTH_CACHE "control:kill-switch" --remote
```

Propagation bound: KV edge propagation (≤ ~60 s) + per-isolate cache
(`KILL_SWITCH_CACHE_MS`, default 30 s) + one client poll interval (≤ 30 s
active / 5 min idle — the stretched-to-idle tier while a socket is live is
the worst case). Existing hibernating sockets are not force-closed
server-side; clients drop them on their next stamped HTTP response, which
the bound above covers for EVERY held socket: a client holding a socket is
by definition polling at ≤ the idle tier, because a client whose pull loop
suspends (1 h with no sessions) tears its socket down with the loop and
only reconnects when activity resumes it.

---

## 4. Canary deployment (Phase 5 task 3)

`canary/canary.ts` — standalone Bun script, two fake devices, one tiny op
per cycle, convergence asserted, one JSON line per event on stdout. Its DO's
duration metric being a known constant is what keeps the watchdog's
hibernation detector sensitive.

```sh
CANARY_HUB_URL=https://sync-hub.<account>.workers.dev \
CANARY_USER_ID=canary-user \
CANARY_TOKEN=<a real cmem.ai token provisioned for the canary user> \
bun workers/sync-hub/canary/canary.ts >> ~/.claude-mem/logs/sync-canary.jsonl
```

Note: production auth is real — provision a dedicated cmem.ai account/token
for the canary user (the hub binds tokens to canonical user ids, §1.2).

24/7 via launchd (macOS box; `~/Library/LaunchAgents/ai.cmem.sync-canary.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.cmem.sync-canary</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/bun</string>
    <string>/path/to/claude-mem/workers/sync-hub/canary/canary.ts</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>CANARY_HUB_URL</key><string>https://sync-hub.ACCOUNT.workers.dev</string>
    <key>CANARY_USER_ID</key><string>canary-user</string>
    <key>CANARY_TOKEN</key><string>REDACTED</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/USER/.claude-mem/logs/sync-canary.jsonl</string>
  <key>StandardErrorPath</key><string>/Users/USER/.claude-mem/logs/sync-canary.err</string>
</dict></plist>
```

`launchctl load ~/Library/LaunchAgents/ai.cmem.sync-canary.plist`

systemd equivalent: a simple `[Service] ExecStart=bun …/canary.ts
Restart=always` unit; cron equivalent: `@reboot` + the script's own loop.
Log growth: one line per 5 min ≈ 30 MB/year — rotate yearly or via
`newsyslog`/`logrotate`.

---

## 5. Threshold-trip verification (the alert chain, end to end)

Rehearse after first deploy and after any watchdog change. Uses the canary's
`--flood` mode plus a temporarily lowered threshold so the rehearsal costs
~5,000 requests instead of 60,000+.

1. Lower the trip point (vars are cheap to change; secrets stay put):
   `wrangler deploy` after setting `"WATCHDOG_REQUESTS_ALERT": "1000",
   "WATCHDOG_REQUESTS_KILL": "4000"` — requests are used here precisely
   because they never auto-trip in real operation; add
   `"WATCHDOG_ROWS_READ_ALERT": "10000", "WATCHDOG_ROWS_READ_KILL": "20000"`
   to rehearse the auto-trip path too (5k floods read ≥ 1 device row each
   plus meta). Lower BOTH values of a pair so the alert/severe tiers keep
   their meaning during the rehearsal; a kill set below alert also engages
   on its own (the breach gate is `min(alert, kill)`), but the mixed config
   is harder to read back in an incident.
2. Flood: `bun workers/sync-hub/canary/canary.ts --flood --flood-requests 5000
   --hub https://sync-hub.<account>.workers.dev --user canary-user --token <t>`
3. Wait for the next cron run (≤ 1 hour, minute 7). Expect, in order:
   - **Discord alert** in the updates channel (amber or red embed listing
     the breached metrics — same channel as release notifications).
   - If a `*_KILL` threshold was lowered: **kill switch tripped** —
     `wrangler kv key get --binding AUTH_CACHE "control:kill-switch" --remote`
     shows `{"source":"watchdog",...}`.
   - **Clients in poll mode**: the canary's next cycles log
     `"sync_mode":"poll"` (and still `"converged":true` — the structural
     guarantee); worker logs show `SYNC_CLIENT` "Hub is in poll mode".
4. Recover: clear the flag (§3), restore the threshold vars, `wrangler
   deploy`. Expect canary `"sync_mode":"live"` and worker logs "Hub left
   poll mode — resuming the advisory socket" within the §3 propagation
   bound.

(The same chain is covered hermetically by `test/watchdog.test.ts` +
`test/kill-switch.test.ts` + `scripts/sync-kill-switch-e2e.ts`; this
procedure proves the PRODUCTION wiring — real GraphQL, real Discord, real
KV.)

---

## 6. Weekly invoice glance (maintainer action — do NOT automate away)

Schedule a weekly cloud agent (claude.ai routines / `/schedule`) — it is
deliberately a human-owned scheduled agent, not part of this Worker.
Suggested prompt to schedule, verbatim:

> Check the Cloudflare billing page for the account running the sync-hub
> Worker (Workers Paid). Compare month-to-date spend against the model:
> ~$5/mo at 100 users, ~$15/mo at 1k. Look specifically at Durable Objects
> duration GB-s (should be near zero — hibernation), requests, and SQLite
> rows read/written. If the delta vs last week is more than 20% or any
> line item is new, post a short summary to the Discord updates webhook
> (credentials in ~/Scripts/claude-mem/.env, DISCORD_UPDATES_WEBHOOK).
> Otherwise post nothing.

Cadence: weekly (e.g. Monday 09:00). Discord ping **only on delta** — a
silent week is the success case.

---

## 7. Control-plane uptime probe (launch Phase 5 task 4)

**Why it exists**: on Jul 20–22 Supabase paused the project silently — signups
failed for 52 hours with no page, while the static landing page answered 200
the whole time. The probe therefore runs OUTSIDE the Vercel/Supabase failure
domain (this Worker) and checks a DB-BACKED endpoint, never the landing page.

**What it checks**: every 5 minutes (cron `*/5 * * * *`, dispatched on
`event.cron` in `src/index.ts` — the hourly `7 * * * *` watchdog is
unaffected), `src/control-plane-probe.ts` GETs `TOKEN_VERIFY_URL` with a
deliberately bogus bearer token (`cmem-uptime-probe-invalid-token`) and the
all-zero user id. **Healthy = HTTP 401/403 with a JSON body** — that exact
answer requires the Pro app AND its Postgres lookup to be alive (the endpoint
queries `pro_users` to reject the token). Unhealthy: network error, 10 s
timeout, any 5xx, a non-JSON 401 (an edge page answering for a dead app), or
any other status. A **2xx for the bogus token pages a distinct SECURITY
alert** — that is an auth bypass, not an outage.

**No new configuration**: reuses `TOKEN_VERIFY_URL` (var) and
`DISCORD_WEBHOOK_URL` (§2.2 secret). Empty `TOKEN_VERIFY_URL` ⇒ logged skip.
No Durable Object involvement.

**Anti-flap policy** (state = KV key `control:uptime-probe` in `AUTH_CACHE`,
absent in the healthy steady state):

1. Healthy steady state → one `{"status":"healthy"}` log line, **no Discord
   post, no KV write**.
2. First failure alerts only after one immediate in-run retry confirms it
   (a single blip never pages); the alert writes the failing state.
3. While failing: re-page at most every 30 minutes; in between, log-only
   (`suppressed`), no KV writes.
4. Healthy again after a failure state → one green "recovered" embed, state
   key deleted.
5. A Discord post failure is swallowed with a log (the KV state is still
   written); a probe bug is contained by the scheduled handler's top-level
   try/catch and can never affect the sync routes.

**Silence during maintenance** (planned Pro/DB downtime):

```sh
cd workers/sync-hub
# Silence until the maintenance window ends (ISO-8601 UTC):
wrangler kv key put --binding AUTH_CACHE "control:uptime-probe" \
  '{"silenced_until":"2026-08-01T09:00:00Z"}' --remote
# Inspect / lift early:
wrangler kv key get --binding AUTH_CACHE "control:uptime-probe" --remote
wrangler kv key delete --binding AUTH_CACHE "control:uptime-probe" --remote
```

While `silenced_until` is in the future the probe does nothing at all (not
even the fetch). After it expires, the first healthy run deletes the marker
quietly; a confirmed failure alerts normally. Deleting the key always returns
the probe to its normal state machine immediately.

---

## 8. Deploy + verify checklist

```sh
cd workers/sync-hub
bun install --frozen-lockfile
bun run test && bun run test:ws && bun run lint && bunx tsc --noEmit
wrangler secret put CMEM_INTERNAL_PROJECTOR_SECRET  # first deploy / rotation only
wrangler deploy --dry-run     # config sanity (bindings listed; the cron is not printed by dry-run — verify in dash post-deploy, §2.5)
wrangler deploy
```

Post-deploy: §2.5 cron visible in dash; §5 rehearsal once; canary running
(§4) and logging `"converged":true,"sync_mode":"live"`.
