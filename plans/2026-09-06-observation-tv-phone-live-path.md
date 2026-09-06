# Observation TV — the phone-live path (off-LAN, outbound, titles only)

**Date:** 2026-09-06
**Worktree / branch:** `.claude/worktrees/observation-tv` / `worktree-observation-tv`
**Builds on:** `4d6d45e8` — *feat(worker): read-only Observation TV broadcast behind `CLAUDE_MEM_TV_TOKEN`* (the shipped LAN slice, PR #3889)
**Prior plan:** `plans/2026-09-05-observation-tv-readonly-broadcast.md`
**Live status docs:** `/workspace/obs-broadcast/STATUS.md`, `/workspace/obs-broadcast/DO-STATUS.md`
**Distinct from:** Pepper / Booth X Live. Nothing here touches those.

> **This plan spans two repositories.** Almost all of the implementation lands in
> **`claude-mem-pro`** (the cmem.ai Next.js app, checked out at
> `/workspace/what-demo/claude-mem-pro`, deployed to Vercel). The OSS `claude-mem` repo is
> touched only in Phase 4 (docs). Read Phase 0.1 before opening an editor.

---

## Primary goal

**Alex, not on his home LAN, opens a normal mobile browser, and watches observation titles
stream by — and the only thing that surface can ever show him is titles.** No inbound port, no
tunnel, no new secret in a URL.

Everything below is measured against that sentence. A task that does not move a byte from
"reachable only on the LAN" toward "reachable from anywhere, and carries titles and nothing
else" does not belong in this plan.

**Locks (2026-09-06), from `/workspace/obs-broadcast/phone-live-locks.txt` and the task brief:**

| Lock | Meaning here |
|---|---|
| **Content = obs titles** | The new surface exposes `title` (+ the minimum metadata to render and order a card). Never `narrative`, `facts`, `text`, `files_read`, `files_modified`, `snippet`, or prompt text. |
| **Access = outbound hosted** | The box never accepts an inbound connection. Data reaches the phone because the worker *dials out* to a hosted service the phone can also reach. |
| **Prefer normal browser** | The primary deliverable is a URL that works in mobile Safari / Chrome with an ordinary login. Not an app install. |
| **iOS only in WHAT App** | If — and only if — the browser cannot do the job on iOS, the fallback is a screen inside the **existing** WHAT app (`apps/what-mobile`). Never a new app, never a second backend. |

---

## The finding that shapes this plan

**The titles are already off the box, and a titles-only reader already exists.**

For any user with cloud sync enabled, the chain already runs end to end today:

```
worker  --POST /v1/sync/ops-->  SyncHub (Cloudflare Worker + per-user Durable Object)
        --POST /api/internal/sync/project-->  cmem.ai  -->  Turbopuffer  cmem-{userId}-v2
```

and in that Turbopuffer namespace **`title` is a first-class serving attribute** —
`CONTENT_V2_SERVING_ATTRIBUTES` (`claude-mem-pro/src/lib/cmem/content-v2-dal.ts:40-62`, `title`
at `:59`). Better still, a **titles-only read path is already written**: `timeline()` /
`timelineWithStore()` (`claude-mem-pro/src/lib/cloud/queries.ts:307`, `:314-379`) call only
`store.list(...)` with **no body hydration** and return exactly:

```ts
// claude-mem-pro/src/lib/cloud/queries.ts:271-280
export interface TimelineRow {
  kind: ContentV2Kind;
  id: string;
  local_id: string;
  project: string;
  title: string | null;
  snippet: string | null;
  created_at_epoch: string;
  cursor: string;
}
```

**It is not exposed over HTTP.** `find src/app/api -type d -name 'timeline*'` returns nothing;
`timeline()` is reachable only through the MCP tool surface. The single existing HTTP read,
`GET /api/observations`, returns **full bodies** — `contentServingRowFromDocument` spreads the
entire payload (`claude-mem-pro/src/lib/cloud/content-serving.ts:445-461`).

So the shortest correct path to the goal is **not** a new egress lane. It is: expose the
titles-only reader that already exists, and put a phone-shaped page in front of it.

That is the recommended route below. The "no cloud sync, titles-only egress" case is a real and
different problem; it is specified in **Appendix A** and deliberately not built here.

---

## Binding constraints

1. **Titles only, enforced by an allowlist projection, never by a denylist.** The route returns
   a field set constructed key-by-key. It must never spread a payload object. Same discipline as
   the prior plan's path allowlist, for the same reason: the payload gains fields every release.
2. **No new inbound surface on the box.** `CLAUDE_MEM_WORKER_HOST` default stays `127.0.0.1`.
   `REMOTE_READABLE_PATHS` (`src/services/worker/http/middleware.ts:121-126`) is **not widened**.
   Appendix A of the prior plan names widening it as *the* failure mode to guard against.
3. **No token in the phone's URL.** The LAN slice accepts `?token=` because `EventSource` cannot
   set headers; that tradeoff does not transfer to a hosted origin, where a query token lands in
   provider logs and `Referer`. The phone uses the ordinary cmem.ai session cookie.
4. **Polling, not streaming.** This is the documented house decision, not a preference — see 0.5
   trap 1. Do not build SSE.
5. **No new dependency**, either repo. `claude-mem` ships two runtime deps and declines helmet on
   record (`src/services/server/Server.ts:115-132`). `claude-mem-pro` forbids direct
   Anthropic/OpenAI SDKs (`claude-mem-pro/CLAUDE.md`).
6. **Migrations are hand-numbered and manually applied** in `claude-mem-pro` — see 0.5 trap 4.
   This plan needs **no migration**; if you think you need one, re-read 0.3.
7. Diffs the size of the defect. Do not refactor the timeline DAL, the viewer, or `Server.ts`.
8. Do not edit `CHANGELOG.md` (generated).

---

## Phase 0 — Consolidated discovery (READ THIS; DO NOT RE-DERIVE)

Verified 2026-09-06 by direct file reads: `claude-mem` at `worktree-observation-tv` @ `4d6d45e8`
(clean tree), `claude-mem-pro` at `what-mobile-phase3-eas` @ `f4738fa` (clean but for untracked
plan files). Every claim carries a `file:line`. If a later phase disagrees with something here,
stop and re-read the file — do not guess.

### 0.1 The two repositories, and which one you are in

| Repo | Path | What it is | Deploy |
|---|---|---|---|
| `claude-mem` (OSS) | `/workspace/claude-mem/.claude/worktrees/observation-tv` | The local worker, `tv.html`, and `workers/sync-hub/` | npm; the hub via manual `wrangler deploy` |
| `claude-mem-pro` | `/workspace/what-demo/claude-mem-pro` | **cmem.ai** — Next.js App Router, Supabase auth, Drizzle/Postgres, Turbopuffer | **Vercel, auto-deploys on merge to `main`** |

`claude-mem-pro` is a **separate git remote** (`thedotmack/claude-mem-pro`). Phases 1, 2, 3 and 5
are commits there. Phase 4 is a commit in `claude-mem`. **Two PRs, not one.**

`claude-mem-pro/CLAUDE.md` house rules that bind this work:
- Dev server `npm run dev` (Next.js, **port 3005**, foreground). Never pm2. Never a second server.
- Deployed on Vercel; env vars live in the Vercel dashboard.
- **"After pushing a completed change to a feature branch, ALWAYS open a PR to main immediately."**
- DB changes ship only as hand-numbered `drizzle/NNNN_*.sql`, applied manually with
  `npm run db:migrate`. **Vercel deploys do not apply migrations.**

### 0.2 The data path that already exists, end to end

| Step | Where | Note |
|---|---|---|
| 1. Observation parsed | `claude-mem/src/sdk/parser.ts:87-158` | `title`/`subtitle` are free-form LLM output, **both nullable** |
| 2. Stored + broadcast locally | `claude-mem/src/services/worker/agents/ResponseProcessor.ts:658-675` | payload built field-by-field; `text` is always literally `null` (`:666`) |
| 3. Internal-project gate | `claude-mem/src/services/worker/agents/ObservationBroadcaster.ts:14-20` | `shouldEmitProjectRow` — internal rows never reach the wire |
| 4. Local SSE fan-out | `claude-mem/src/services/worker/SSEBroadcaster.ts:25-39` | `data: {json}\n\n`, no `event:`/`id:` line |
| 5. **Outbound push** | `claude-mem/src/services/sync/CloudSync.ts:938-954` | `POST ${hubUrl}/v1/sync/ops`, `Authorization: Bearer`, `X-User-Id`, `X-Device-Id` |
| 6. Hub durable log + fan-out | `claude-mem/workers/sync-hub/src/do/SyncHub.ts:313-366` | `fanOutCommitted`, WS, per-device echo suppression |
| 7. Hub → Pro projection | `claude-mem-pro/src/app/api/internal/sync/project/route.ts` | shared secret, constant-time compare (`:114-129`), `maxDuration = 60` |
| 8. **Content at rest** | Turbopuffer namespace `cmem-{userId}-v2` | `title` is a serving attribute (`content-v2-dal.ts:59`) |
| 9. Titles-only reader | `claude-mem-pro/src/lib/cloud/queries.ts:314-379` | **exists, not exposed over HTTP** |
| 10. Full-body reader | `claude-mem-pro/src/app/api/observations/route.ts` | returns whole payloads — **not** what the TV may use |

**Consequence that decides the design:** steps 1–8 are already built, deployed and load-bearing
for paying users. This plan adds step 9-over-HTTP and a page. It writes **no new egress code**.

### 0.3 There is no Postgres table for observations — and you do not need one

`claude-mem-pro/drizzle/0020_retire_postgres_content.sql:20-23` drops `pro_observations`,
`pro_summaries`, `pro_prompts` and `pro_sync_state`. All product content serves from Turbopuffer.
**Do not write a migration for this feature.** If a task seems to need one, you have drifted into
Appendix A.

### 0.4 Auth lanes in `claude-mem-pro` — pick the right one

| Helper | file:line | Credential | Use for |
|---|---|---|---|
| `getUser()` | `src/lib/auth-server.ts:18-22` | Supabase **cookie session**, `cache()`-wrapped | **The phone browser page and its fetch route.** This one. |
| `authenticateWhatUser(authorization)` | `src/lib/what/auth.ts:44` | Supabase **access token** in a Bearer header | The WHAT app (Phase 5) |
| `authenticateHookBearer(authorization)` | `src/lib/hooks/auth.ts:33` | `mcp_token` or `setup_token` | Machine push (`/api/hooks/ingest`) — not used here |
| `validateSyncRequest(request)` | `src/lib/pro/auth.ts:51` | `Bearer <setup_token>` + `X-User-Id` | The hub's auth oracle — not used here |
| `configuredProjectorSecret` / `authorized` | `src/app/api/internal/sync/project/route.ts:114`, `:122` | 32+ char shared secret, `timingSafeEqual` | Hub → Pro — not used here |

**Pro gate — there is exactly one, and everything that gates on Pro must call it**
(`src/lib/pro/entitlement.ts:4-7` docblock):

```ts
// claude-mem-pro/src/lib/pro/entitlement.ts:17-21
export function isProActive(p: EntitlementFields | null | undefined): boolean {
  if (!p) return false;
  const subscribed = p.paymentStatus === 'active' || p.paymentStatus === 'trialing';
  return subscribed && p.planTier === 'pro';
}
```

Route protection for **pages** is edge middleware —
`claude-mem-pro/src/lib/supabase/middleware.ts:68`:
```ts
const protectedRoutes = ['/dashboard', '/connect', '/admin', '/pro/key', '/pro/sync', '/pro/start'];
```
A new authenticated page must be added to that array, or it is public.

### 0.5 Traps

1. **Do not build SSE. The house removed realtime on purpose.**
   `claude-mem-pro/src/app/api/stream/route.ts:56-63` answers **HTTP 410** with
   `{code:'polling_required', pollingFallback:'/api/observations'}`, and its docblock (`:14-21`)
   says *"The Supabase Realtime relay over the `pro_*` content tables is gone; correctness comes
   from refetching v2."* `drizzle/0020_retire_postgres_content.sql:27` drops the broadcast
   trigger function. The live dashboard polls: `useCloudData.ts:275-306`, interval
   `CLOUD_POLL_INTERVAL_MS: 20000` whose comment (`src/constants/timing.ts:6-9`) reads *"replaces
   the removed Supabase Realtime SSE relay."* Verified by grep: the only `text/event-stream` in
   `src/` is the retired proxy, there is no `TransformStream`, and no route uses
   `runtime = 'edge'`.
2. **`timeline()` pages BACKWARDS.** `TimelineOptions.before` is *"an opaque chronological key
   from the previous page"* (`queries.ts:282-287`). There is **no `after`/`since` direction.**
   Do not add one. The TV wants "what is new", and the correct thin answer is: re-fetch the
   newest page each poll and let the client drop ids it has already shown (Phase 2.3).
3. **`title` and `subtitle` are both nullable, and a null-title observation is still emitted.**
   `src/sdk/parser.ts:137-143` drops an observation only when title *and* narrative *and* facts
   *and* concepts are all empty. `tv.html:209-210` already resolves this with
   `(obs.title || obs.subtitle || obs.text || '').trim()` and drops the empty result.
4. **Migrations in `claude-mem-pro` are manual, and the numbering is already inconsistent** —
   there are **two `0048_` files** (`0048_auto_upgrade_consent.sql`, `0048_pro_alert_queue.sql`).
   This plan needs no migration. If a future slice does, the next free number is `0050`.
5. **Middleware excludes some API prefixes from the session round trip.**
   `claude-mem-pro/src/middleware.ts:37` excludes `api/mcp` and `api/pro/sync`. A new route under
   those prefixes would silently skip auth. **Put the new route at `/api/tv/...`**, which is not
   excluded.
6. **`vercel.json` sets no `maxDuration` and no function config** — it is crons only. All
   duration/region config is per-route segment exports (`export const runtime`, `maxDuration`).
7. **`SettingsDefaultsManager.get()` does not read `settings.json`** (`:257-259` is
   `process.env[key] ?? DEFAULTS[key]`). Only relevant if Appendix A is ever built; irrelevant to
   Phases 1–5, which add no worker setting.
8. **`plugin/ui/tv.html` and `src/ui/tv.html` are byte-identical today** (md5
   `981fc042e87476eb77ba2292225f8dfd`) because `4d6d45e8` hand-committed both.
   `scripts/build-viewer.js:43-47` copies verbatim. If you touch either, run
   `npm run build-and-sync` — a stale bundle has bitten this project before (issue #3857).

### 0.6 Allowed APIs (use only these; anything else, go read the file first)

**`claude-mem-pro` server:** `NextRequest`, `NextResponse`, `request.nextUrl.searchParams`,
`getUser()` (`@/lib/auth-server`), `timeline()` (`@/lib/cloud/queries`), `isProActive()`
(`@/lib/pro/entitlement`), `export const runtime = 'nodejs'`, `export const dynamic = 'force-dynamic'`,
`export const preferredRegion`, `export const maxDuration`.

**`claude-mem-pro` client page:** plain React + `fetch` + `setTimeout`. No new library.

**Browser page internals:** copied verbatim from `claude-mem/src/ui/tv.html` — see the
copy-map in Phase 2.1.

**WHAT app (Phase 5 only):** `expo-router` `Stack.Screen` + `useRouter()`, `fetch`, the existing
`authorization(accessToken)` helper (`apps/what-mobile/lib/api.ts:57-59`).

### 0.7 Anti-patterns — do not do these

- ❌ **Widening `REMOTE_READABLE_PATHS`** (`claude-mem/src/services/worker/http/middleware.ts:121-126`).
  The prior plan's Appendix A names this exact temptation: *"the temptation to widen this
  allowlist until it becomes the second thing is the failure mode to guard against."*
- ❌ **Any tunnel** (cloudflared / ngrok / tailscale-serve) in front of the worker. Rejected
  2026-09-05 and still rejected: it publishes `GET /api/settings` (provider API keys) and
  `POST /api/admin/restart`.
- ❌ **Changing `CLAUDE_MEM_WORKER_HOST`'s default.**
- ❌ **`?token=` on the hosted page.** Trap: it feels like it matches the LAN slice. It does not —
  see constraint 3.
- ❌ **Spreading a payload object into the response.** `{...doc}` or `{...payload}` in the new
  route is the single highest-risk line in this plan. Build the object key by key.
- ❌ **Calling `listContent()` / `contentServingRowFromDocument()`** from the TV route. Those
  hydrate full bodies (`content-serving.ts:445-461`). Only `timeline()` is permitted.
- ❌ **Building SSE, a WebSocket, or a Realtime subscription** on the hosted side (0.5 trap 1).
- ❌ **Adding an `after`/`since` cursor to the timeline DAL** (0.5 trap 2).
- ❌ **A Drizzle migration** (0.3).
- ❌ **Reusing the sync `setup_token` as the phone's credential.** It authenticates
  `/v1/sync/changes`, which returns the **entire corpus**. Handing it to a browser bookmark is
  strictly worse than the LAN token this plan is meant to improve on.
- ❌ **A second backend for the WHAT app** (Phase 5 must call the same route as the browser).

---

## The route decision, stated once

**Recommended (this plan, Phases 1–6): expose the existing titles-only reader.**
No worker change. No new egress. Ships to anyone whose cloud sync is already on.

**Not built here (Appendix A): a titles-only outbound lane** for users who want the phone TV
*without* full cloud sync. That needs new worker code, a new hub op kind or route, and a new
projection — a genuinely separate slice with its own threat model.

**The honest tradeoff to state in the PR:** under the recommended route, the phone TV is a
feature *of cloud sync*. Cloud sync uploads observation narratives and full prompt text
(`docs/public/cloud-sync.mdx`, and the skill's mandatory privacy note). So "watch titles on my
phone" is available only to someone who has already accepted that upload. This plan does **not**
widen what leaves the box by one byte — but it also does not shrink it, and a reader could
mistake "titles only" for "only titles ever leave." Phase 4 says so explicitly in the docs.

---

## Phase 1 — `GET /api/tv/titles` on cmem.ai

**How this serves the primary goal:** it is the only thing standing between the phone and titles
that are already hosted. Without it the page has nothing to fetch.

**Repo: `claude-mem-pro`.** Branch from `main`.

### 1.1 The file

Create `src/app/api/tv/titles/route.ts`. Copy the shape of
`src/app/api/observations/route.ts:1-33` — same import style, same session check, same
`NextResponse.json` envelope — but call `timeline()`, not `listContent()`.

Segment config, copied from `src/app/api/what/v1/bootstrap/route.ts:17-19`:
```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const preferredRegion = ['iad1'];
export const maxDuration = 60;
```

### 1.2 The contract

- **Method:** `GET` only. No `POST`, no `DELETE`.
- **Auth:** `const user = await getUser();` — no session ⇒ `401 {"error":"Session required"}`.
  Copy the wording from `observations/route.ts:39`.
- **Pro gate:** load the entitlement row and call `isProActive(...)`. Not Pro ⇒ `403`.
  (The dashboard's own gate at `src/app/(authenticated)/dashboard/page.tsx:83-109` is the
  precedent for what to check.)
- **Query params:** `project` (optional, passed through), `limit` (optional, clamped 1–100 —
  the DAL already clamps to 1–200 at `queries.ts:315`; clamp tighter here because a TV never
  needs more).
- **Never accept:** `before`, `cursor`, `offset`, `fields`, or anything that could page the
  corpus. The TV asks for "the newest N" and nothing else. This is deliberate: a paging
  parameter turns a title feed into a corpus reader.
- **The projection — build it key by key, never spread:**

```ts
// The allowlist IS the security boundary. Add a field here only with the same
// scrutiny you would give a new route. NEVER `...row` / `...payload`.
const items = page.rows
  .filter((row) => row.kind === 'observation')
  .map((row) => ({
    id: row.id,
    title: row.title,
    project: row.project,
    created_at_epoch: row.created_at_epoch,
  }));
```

  Four fields. **`snippet` is deliberately dropped** — it is a body excerpt, and the lock says
  titles. `local_id`, `cursor` and `kind` are internal and are not the phone's business.
- **Response:** `{ items }`. Nothing else — no `nextCursor` (there is no paging), no
  `responseBytes`.
- **Headers:** `Cache-Control: no-store`.
- **Errors:** wrap the `timeline()` call in try/catch and answer
  `500 {"error":"Failed to fetch titles"}`, logging server-side — copy
  `observations/route.ts:25-31` exactly.

### 1.3 What about `platform_source` and `type`?

The local TV card renders both. `TimelineRow` carries **neither** (`queries.ts:271-280`). Do
**not** add them by reaching for the full document — that would mean hydrating bodies, which is
the one thing this route must not do. The hosted card renders without them; `tv.html`'s
`normalize()` (`:207-219`) already defaults `type` to `'observation'` and `platform_source` to
`'claude'`, so the page degrades cleanly to a single accent colour.

Adding them properly means adding them to `CONTENT_V2_SERVING_ATTRIBUTES` and the timeline
projection — a real change to the serving contract, and **out of scope**. Note it in the PR as a
known cosmetic difference from the LAN TV.

### 1.4 Verification checklist — Phase 1

```bash
cd /workspace/what-demo/claude-mem-pro
npm run dev            # port 3005, foreground, never pm2
# logged out:
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3005/api/tv/titles      # 401
# logged in (browser session cookie), from devtools:
#   fetch('/api/tv/titles?limit=5').then(r=>r.json()).then(console.log)
```

- [ ] No session ⇒ `401`, body has no data.
- [ ] Session but not Pro ⇒ `403`.
- [ ] Pro session ⇒ `200 {items:[...]}`, and **every object has exactly four keys**. Assert it:
      `[...new Set(items.flatMap(Object.keys))].sort()` ⇒
      `["created_at_epoch","id","project","title"]`.
- [ ] **The response body contains none of** `narrative`, `facts`, `concepts`, `files_read`,
      `files_modified`, `text`, `subtitle`, `snippet`, `prompt_text`. Grep the raw JSON:
      `curl ... | grep -cE 'narrative|facts|files_read|files_modified|snippet'` ⇒ `0`.
- [ ] `?limit=9999` is clamped, not honoured.
- [ ] `?before=<anything>` is **ignored**, not paged.
- [ ] `POST /api/tv/titles` ⇒ 405.
- [ ] `grep -n '\.\.\.' src/app/api/tv/titles/route.ts` shows **no spread into the response**.
- [ ] `npm run lint` clean.

### 1.5 Anti-pattern guards — Phase 1

- ❌ `listContent`, `contentServingRowFromDocument`, or any `getMany` hydration.
- ❌ A spread operator anywhere in the response construction.
- ❌ A `before`/`cursor` parameter.
- ❌ A Drizzle migration.
- ❌ Putting the route under `/api/mcp/*` or `/api/pro/sync/*` (0.5 trap 5).

---

## Phase 2 — The phone page

**How this serves the primary goal:** this is the thing Alex actually opens.

**Repo: `claude-mem-pro`.** Same branch as Phase 1.

### 2.1 Copy the TV, do not rewrite it

`claude-mem/src/ui/tv.html` is 505 lines, **verifiably dependency-free** (one inline `<script>`
at `:135-503`, one inline `<style>` at `:8-117`, zero `<link>`, zero external URLs, system fonts
only). Port it as a client component at
`claude-mem-pro/src/app/(authenticated)/tv/page.tsx` + a colocated CSS module.

**Copy map — take these verbatim:**

| Piece | `claude-mem/src/ui/tv.html` |
|---|---|
| Stylesheet (vars, `#stage`, `#card`, `#title`, `#meta`, `#idle`, `#hud`, reduced-motion) | `:8-117` |
| DOM skeleton | `:120-133` |
| `clampInt` + URL knob parsing | `:139-151` (**drop the `token` line at `:154`**) |
| `leafProject` / `SOURCE_COLORS` / `platformSource` / `sourceColor` | `:178-205` |
| `normalize()` — its defaults are what make titles-only work | `:207-219` |
| `nextItem` / `sleep` | `:227-235` |
| `show` / `escapeHtml` / `relTime` / `render` | `:237-270` |
| `loop()` | `:272-290` |
| Document PiP route | `:340-371` |
| Canvas → `captureStream()` → `<video>` route (**the iOS path**) | `:373-444` |
| `toggleVideoPiP` / `togglePiP` | `:446-473` |
| Fullscreen, HUD auto-hide, listeners | `:475-499` |

**Rewrite these three:**

- `seed()` (`:292-308`) — point at `/api/tv/titles`, drop `token`, drop `platformSource`.
- `connect()` (`:310-338`) — **delete entirely.** Replaced by the poll in 2.3.
- `matchesFilter()` (`:221-225`) — see 2.4.

Keep the URL knobs `?project`, `?dwell`, `?fade`, `?seed`, `?replay`. **Drop `?source`** — the
route does not return `platform_source` (1.3), so the filter would silently match nothing.

### 2.2 Auth is the session, and the page is gated

- Add `'/tv'` to `protectedRoutes` in `src/lib/supabase/middleware.ts:68`. Without this the page
  is public.
- The page is under `(authenticated)`, so the layout's session handling applies.
- **No token, anywhere.** The fetch is same-origin and carries the cookie automatically.

### 2.3 The poll replaces the stream

House pattern: `src/components/timeline-viewer/useCloudData.ts:275-306` — a **serial,
tab-visible-gated** loop. Copy its shape, not its 20 s interval.

- Interval: **4000 ms** default, overridable with `?poll=` clamped 2000–60000. Rationale: the
  card dwell is 6 s, so a 4 s poll is never the bottleneck, and it is 5× gentler than the LAN
  SSE stream while still feeling live.
- **Serial, never overlapping**: schedule the next poll with `setTimeout` in a `finally`, never
  `setInterval`.
- **Pause when hidden**: `document.visibilityState !== 'visible'` ⇒ skip and reschedule. This is
  what makes the page survive an iOS backgrounding instead of burning battery.
- **Resume immediately on `visibilitychange` → visible**, so unlocking the phone catches up at
  once rather than after a full interval.
- **Dedupe by `id`** — keep a `Set` of seen ids. New ids (not in the set) are pushed to the
  `live` queue; the set is the *only* thing that decides novelty. This also fixes the LAN TV's
  bug where a live item is pushed into both queues (`tv.html:334-335`) and then replays forever.
- **Bound the set**: cap at ~2000 ids, evicting oldest, so an all-day session cannot grow it
  without limit.
- **Backoff on failure**: on a non-OK response or a throw, double the delay to a 60 s ceiling and
  reset on the next success. The LAN page's flat 3 s retry (`tv.html:317-321`) is a defect worth
  not copying — against a hosted origin it is a request every 3 s, forever, on a 401.
- **A `401` must stop the loop and show a "sign in again" state**, not retry. This is the single
  most important difference from `tv.html`, which would hammer forever.

### 2.4 Fix `matchesFilter` on the way through

`tv.html:221-225` has two known defects, both confirmed:
1. `:223` compares **raw** `obs.platform_source` against `?source=`, bypassing the file's own
   `platformSource()` normalizer (`:195-198`) — so `?source=Claude` matches nothing.
2. `:222` matches the **leaf** project for live items while the seed query matched the **full**
   project string server-side — the two paths disagree.

Since the hosted page drops `?source` (2.1), defect 1 disappears by construction. For `?project`,
apply `leafProject()` to **both** sides, consistently, on **every** item — there is now only one
intake path (the poll), so the live/seed asymmetry cannot recur.

### 2.5 Verification checklist — Phase 2

- [ ] Logged out, open `/tv` ⇒ redirected to login (proves `protectedRoutes` was edited).
- [ ] Logged in as Pro ⇒ cards render, one every ~6 s.
- [ ] **`grep -rn 'token' src/app/(authenticated)/tv/` returns nothing.**
- [ ] Network tab: exactly one `/api/tv/titles` request per poll interval, **never overlapping**.
- [ ] Switch to another tab for 60 s ⇒ **zero** requests fire. Switch back ⇒ one fires immediately.
- [ ] Kill the network ⇒ the interval backs off (observe 4s → 8s → 16s…), does not spin at 4 s.
- [ ] Restore the network ⇒ recovers without a reload.
- [ ] Sign out in another tab, then wait one interval ⇒ the page shows a sign-in state and
      **stops polling**. Confirm in the network tab that requests cease.
- [ ] The same observation never appears twice in one session (dedupe works).
- [ ] `?project=<leaf>` filters; `?dwell=2000` visibly speeds the rotation.
- [ ] No external network requests other than `/api/tv/titles` — confirm the page loads no CDN
      font, script or stylesheet.

### 2.6 Anti-pattern guards — Phase 2

- ❌ `new EventSource(...)` or `new WebSocket(...)` anywhere.
- ❌ `setInterval` for the poll (overlapping requests when one is slow).
- ❌ Polling while the tab is hidden.
- ❌ Retrying a `401` in a loop.
- ❌ Storing anything in `localStorage` — there is no secret to store, and a stored filter
  outlives the intent.
- ❌ Reaching for `/api/observations` "just for the extra fields."

---

## Phase 3 — Make the phone case actually hold up

**How this serves the primary goal:** "off the LAN, on a phone" means flaky networks, lock
screens and backgrounding. The LAN page never had to survive any of that.

**Repo: `claude-mem-pro`.** Same branch.

### 3.1 The visible connection state

`tv.html`'s only connection indicator is an 8 px dot (`:101-108`) inside a HUD that is
`opacity: 0` except for 2500 ms after a touch (`:85`, `pokeHud` `:483-488`). On a phone across a
cell network that is effectively invisible. Add a **persistent, low-key state line** in the
`#meta` row: `live` / `reconnecting…` / `signed out`. Reuse the existing `LiveState` vocabulary
from `src/components/timeline-viewer/types.ts:101-112` (`'connecting' | 'live' | 'offline'`) so
the two surfaces describe themselves the same way.

### 3.2 Empty and cold states

- Zero titles returned (a new account, or a project filter that matches nothing) ⇒ the existing
  `#idle` element (`tv.html:126`) with honest copy — distinguish **"waiting for observations"**
  from **"no observations match this filter."**
- Titles whose `title` is null ⇒ dropped by `normalize()` (`:209-210`). Because the route does not
  return `subtitle`, the LAN page's `title || subtitle` fallback cannot apply here; a null-title
  observation simply does not appear on the phone. **State this in the PR** — it is a real
  behavioural difference from the LAN TV, and it is the conservative reading of the content lock.

### 3.3 iOS PiP — prove it or drop it

The canvas → `captureStream()` → `webkitSetPresentationMode` path (`tv.html:446-461`) is
**unverified on a real device**. Nothing in the repo records it running on a physical iPhone, and
there is a confirmed dead branch: `document.pictureInPictureElement` is absent on iOS Safari, so
the exit branch at `:448` never fires — a second tap re-enters instead of exiting and the 15 fps
`setInterval` from `startCanvas()` (`:434-438`) leaks.

Tasks:
- Fix the exit branch to also test `video.webkitPresentationMode === 'picture-in-picture'`.
- Ensure `stopCanvas()` runs on every exit path, including `pagehide`.
- **Test on a real iPhone.** Record the result in the PR.
- If PiP does not work on iOS in a normal browser, **do not fight it** — that is precisely the
  trigger for Phase 5, and the fullscreen page (which does work) remains the browser deliverable.

### 3.4 Verification checklist — Phase 3

- [ ] On a real iPhone, on cellular (not the home WiFi — this is the whole point), `/tv` renders
      cards.
- [ ] Lock the phone for 2 minutes, unlock ⇒ the page catches up within one poll, no reload,
      no duplicate cards.
- [ ] Airplane mode for 60 s ⇒ state line reads `reconnecting…`; restore ⇒ `live`.
- [ ] PiP: tap to enter, tap to exit, tap to re-enter. If any step fails on iOS, record it and
      proceed to Phase 5.
- [ ] After exiting PiP, confirm the 15 fps canvas interval is cleared (no CPU burn) — check with
      Safari's Web Inspector timeline attached to the phone.
- [ ] Rotate the device; safe-area padding holds (the `viewport-fit=cover` + `env(safe-area-*)`
      CSS came across in the copy).

---

## Phase 4 — Docs, and telling the truth about what leaves the box

**How this serves the primary goal:** the LAN docs currently tell a user their phone options end
at the LAN, and name the full-bodies risk this route does not fix.

**Repo: `claude-mem` (OSS)** for 4.1; `claude-mem-pro` for 4.2.

### 4.1 `docs/public/configuration.mdx`

The existing section is *"Observation TV Remote Access"* (`:189-191`), which says the token lets
*"a second device on your LAN"* watch. Add a short subsection after it: **off-LAN viewing is a
cmem.ai Pro feature**, at `https://cmem.ai/tv`, requires cloud sync, needs no token and no port,
and the box never accepts an inbound connection.

Match the existing table row format (`:14-24`). Do not add a settings key — this phase adds none.

**Say plainly, in the same place:** the hosted TV shows only titles, **and** cloud sync itself
uploads narratives and full prompt text. Those are two different statements and a reader will
conflate them if you write only the first. The wording precedent is the cloud-sync skill's
mandatory closing note (`plugin/skills/cloud-sync/SKILL.md` §5) and `docs/public/cloud-sync.mdx`.

### 4.2 `claude-mem-pro`

Link `/tv` from the dashboard (`src/app/(authenticated)/dashboard/page.tsx`) so it is
discoverable. One link, next to the existing timeline viewer. No new nav system.

### 4.3 Accepted risks — put these in the PR description

1. **The hosted TV is gated on cloud sync**, which uploads far more than titles. This plan
   narrows the *new* surface to titles; it does not narrow cloud sync. Anyone reading "titles
   only" as "only titles ever leave this machine" is wrong, and the docs must prevent that
   reading.
2. **No rate limiting on `/api/tv/titles`.** A logged-in Pro user can poll it hard. The route is
   session-gated and returns ≤100 titles, so the blast radius is their own data and their own
   Turbopuffer read budget — but there is no limiter. `/api/hooks/ingest` has one (120/min) and
   is the precedent if this ever needs one.
3. **Turbopuffer read cost scales with viewers × poll rate.** A TV left open all day is ~21,600
   list calls. `timeline()` does not hydrate bodies so each is cheap, but it is not free. If this
   matters, raise the interval before adding a cache.
4. **Projection lag is invisible to the phone.** A title appears only after
   worker → hub → projector → Turbopuffer. `docs/RUNBOOK-backup-restore.md:38-41` documents a
   projection-lag alert on `head_seq - projected_seq`; the TV inherits that lag with no
   indicator. Under normal operation it is seconds.
5. **`platform_source` and `type` are missing** from the hosted card (1.3), so it is visually
   plainer than the LAN card and the per-source accent colour is uniform.

### 4.4 Verification checklist — Phase 4

- [ ] `docs/public/configuration.mdx` renders (Mintlify table syntax; pipe counts match
      neighbouring rows).
- [ ] The docs state both facts from 4.1 — titles-only surface **and** cloud sync's full upload.
- [ ] `grep -rn "cloudflared\|ngrok" docs/` finds them only as rejected options.
- [ ] All five accepted risks appear in the PR description.

---

## Phase 5 — The iOS lane, **only if Phase 3.3 failed**

**Gate:** do not start this phase unless Phase 3.4 recorded a concrete, reproducible failure of
the normal-browser path on a real iPhone. The lock is *"prefer normal browser; iOS only in WHAT
App **if needed**."* A working browser page means this phase is not needed and must be skipped.

**Repo: `claude-mem-pro`**, `apps/what-mobile`. Note this app is **mid-rebuild** on branch
`what-mobile-phase3-eas` (PR #160/#161, Expo SDK 57); coordinate before branching.

### 5.1 The change

- Add `app/live.tsx`. Register it: `<Stack.Screen name="live" />` in `app/_layout.tsx:21`
  (the existing Stack lists only `index` and `auth/callback` at `:20-21`). Typed routes are on
  (`app.json` `experiments.typedRoutes`), so the route type regenerates.
- Navigate with `useRouter().push('/live')` — the pattern already used at `app/auth/callback.tsx:13`.
- **Call the same `/api/tv/titles` route.** Auth is the existing helper —
  `apps/what-mobile/lib/api.ts:57-59`:
  ```ts
  function authorization(accessToken: string): Record<string, string> {
    return { Authorization: `Bearer ${accessToken}` };
  }
  ```
  which means the route must **also** accept `authenticateWhatUser` (`src/lib/what/auth.ts:44`),
  not only a cookie session. Add that as a second accepted credential in Phase 1's route —
  cookie **or** Supabase access token — rather than building a parallel route.
- Reuse the app's existing dark theme (`lib/theme`) and `FullScreenState` component. Do **not**
  port the canvas/PiP machinery — a native screen does not need it.

### 5.2 Verification checklist — Phase 5

- [ ] `npx expo-doctor` passes at the same count as before the change.
- [ ] The screen renders titles on a real device over cellular.
- [ ] `grep -rn 'cmem.ai/api' apps/what-mobile/` shows **no new base URL** — it reuses
      `config.apiUrl`'s origin.
- [ ] Signed-out state routes to the existing auth screen, not a crash.
- [ ] Phase 1's checklist still passes for the **cookie** path (the added bearer path must not
      regress it).

### 5.3 Anti-pattern guards — Phase 5

- ❌ A second backend, a second route, or a duplicated projection.
- ❌ Downgrading the Expo SDK, adding `expo-updates`, or hand-editing dependency versions
  (the app's own plan forbids all three).
- ❌ Starting this phase without the Phase 3.4 failure evidence.

---

## Phase 6 — Final verification

### 6.1 Prove the boundary, not the code

The one test that matters. From a Pro session, against production or a preview deploy:

```bash
# MUST succeed and contain ONLY the four allowlisted keys
curl -s -b "$COOKIE" 'https://cmem.ai/api/tv/titles?limit=100' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); \
      ks=sorted({k for i in d["items"] for k in i}); print(ks); \
      assert ks==["created_at_epoch","id","project","title"], ks'

# MUST return zero hits — no body content of any kind
curl -s -b "$COOKIE" 'https://cmem.ai/api/tv/titles?limit=100' \
  | grep -cE 'narrative|facts|concepts|files_read|files_modified|snippet|prompt_text|subtitle'
# expected: 0

# MUST fail
curl -s -o /dev/null -w '%{http_code}\n' 'https://cmem.ai/api/tv/titles'          # 401 (no cookie)
curl -s -o /dev/null -w '%{http_code}\n' -X POST -b "$COOKIE" '.../api/tv/titles' # 405
```

### 6.2 Prove nothing regressed on the box

The whole point of the recommended route is that the worker is untouched.

```bash
cd /workspace/claude-mem/.claude/worktrees/observation-tv
git diff --stat main -- src/ plugin/    # expected: docs only, no src/ or plugin/ changes
npm run typecheck
bun test tests/server/
```

- [ ] **No change to `src/` or `plugin/` in the OSS repo.** If this is non-empty, you have drifted
      into Appendix A — stop and re-scope.
- [ ] `tests/server/` still at its `4d6d45e8` baseline (203 pass / 13 skip / 0 fail).
- [ ] The LAN TV still works at `http://127.0.0.1:<port>/tv.html` with no token.

### 6.3 Anti-pattern grep

```bash
cd /workspace/what-demo/claude-mem-pro
grep -rn 'EventSource\|new WebSocket\|text/event-stream' 'src/app/(authenticated)/tv/' src/app/api/tv/  # 0
grep -rn '\.\.\.' src/app/api/tv/titles/route.ts                                     # no spread into the response
grep -rn 'listContent\|contentServingRowFromDocument\|getMany' src/app/api/tv/        # 0
grep -rn 'token' 'src/app/(authenticated)/tv/'                                       # 0
grep -rn 'setInterval' 'src/app/(authenticated)/tv/'                                 # 0 (poll must be setTimeout)
ls drizzle/ | wc -l   # unchanged from before this branch

cd /workspace/claude-mem/.claude/worktrees/observation-tv
grep -n 'REMOTE_READABLE_PATHS' -A6 src/services/worker/http/middleware.ts  # still exactly 4 paths
```

### 6.4 Sign-off

- [ ] Every phase's checklist is green, or its failure is recorded in the PR.
- [ ] The five accepted risks (4.3) are in the PR description.
- [ ] Two PRs opened: one on `claude-mem-pro` (Phases 1–3, 4.2, and 5 if triggered), one on
      `claude-mem` (4.1). `claude-mem-pro/CLAUDE.md` requires the PR be opened immediately on push.
- [ ] A real iPhone, on cellular, off the home LAN, has shown titles. Nothing else counts as done.

---

## Appendix A — The titles-only egress lane (specified, NOT built here)

This is the answer to *"I want the phone TV but I do not want to upload my narratives and prompt
text."* It is a separate slice with its own threat model, and nothing in Phases 1–6 blocks it.

**Why it is not this plan:** it requires new code in three places (worker, hub, Pro), a new
projection at rest, and a new credential — against a route that, for the maintainer who already
runs cloud sync, delivers nothing Phase 1 does not. Build it when a user who is *not* a cloud-sync
user asks for the phone TV.

**Shape, if it is ever built:**

1. **Worker side.** Tap `broadcastObservation` at
   `src/services/worker/agents/ObservationBroadcaster.ts:22` — **after** the `shouldEmitProjectRow`
   gate at `:14-20`, so internal projects are excluded for free. Do **not** tap
   `SSEBroadcaster.broadcast()`: it early-returns when there are zero clients
   (`SSEBroadcaster.ts:26-29`), so the push would silently stop whenever no browser is open.
2. **Projection.** Copy the field-selection discipline of `TelegramNotifier.formatMessage`
   (`src/services/integrations/TelegramNotifier.ts:34-47`) — the only *narrow* egress path in the
   codebase. **Do not** copy `CloudSync.toBody` (`CloudSync.ts:196-218`), which ships all 22
   observation fields.
3. **Transport.** Copy the *transport shape* of `CloudSync.pushOps`
   (`CloudSync.ts:938-975`) — URL normalization (`:408`), `Authorization: Bearer` + `X-User-Id` +
   `X-Device-Id`, `AbortSignal.timeout`, injectable `fetchImpl` (`:358`, `:411`), exponential
   backoff (`scheduleRetry` `:1394-1413`), token redaction in error strings (`:635`).
   **Do NOT copy the canonical-op envelope** (`CanonicalContent.ts` — entity revisions, ack
   multiset proofs, tombstones, `sync_content_outbox`). It is heavyweight replication machinery
   and this is a fire-and-forget broadcast. Without this warning an implementer will drag it in.
4. **Do not await in the emit loop.** `broadcastObservation` is called inside a synchronous `for`
   over deduped ids (`ResponseProcessor.ts:617-676`); awaiting per observation serialises a whole
   response. Enqueue and return, like `getCloudSync()?.notify()` at `:656`.
5. **Setting.** One key, `''` = off, declared in the interface **and** DEFAULTS with the same
   comment block in both (house convention) — copy `CLAUDE_MEM_TV_TOKEN` at
   `SettingsDefaultsManager.ts:93-98` and `:212-217`. Read it with
   `loadFromFile(USER_SETTINGS_PATH)` **once at construction** (`worker-service.ts:283-285`),
   never `.get()` (0.5 trap 7), and never read it per-observation. **Never add it to `settingKeys`**
   in `SettingsRoutes.ts:81-112` — `POST /api/settings` is unauthenticated (see the comment at
   `:77-80`).
6. **Do not grow `WorkerRef`** (`agents/types.ts:2-7`) — it is a minimal structural interface and
   a new field ripples into every mock in `tests/worker/agents/response-processor.test.ts`. Use a
   module-level singleton or an injected parameter.
7. **Hosted side.** A new op kind or sibling route on `workers/sync-hub/`, reusing
   `authenticateRequest` (`index.ts:210-300`), the KV verdict cache, the kill switch and the
   watchdog. The per-user Durable Object is the natural home for a bounded, TTL'd ring buffer of
   recent titles. `fanOutCommitted` (`do/SyncHub.ts:313-366`) is the existing fan-out primitive.
8. **Tests.** `bun:test`. Pure-policy-function style from
   `tests/server/tv-remote-guard.test.ts:370-426`, harness from `:28-116`, fetch injection from
   `tests/worker/sync/cloud-sync.test.ts:142-155`, broadcast assertions from
   `tests/worker/agents/response-processor.test.ts:840-861`.
9. **The projection needs its own test** asserting the exact key set of the outbound body — the
   same assertion as Phase 1's checklist, one layer earlier.

---

## Appendix B — Rejected, with reasons (do not re-propose)

| Option | Why not |
|---|---|
| A tunnel (cloudflared / ngrok / tailscale-serve) to the worker | Publishes `GET /api/settings` (Gemini + OpenRouter keys in plaintext), `POST /api/admin/restart`, `DELETE /api/observation/:id`, `POST /api/import` and better-auth to the internet. Rejected 2026-09-05; still rejected. |
| Widen `REMOTE_READABLE_PATHS` and expose the worker | Same problem, and it is the exact failure mode the prior plan's Appendix A warns against. The LAN allowlist is for the LAN. |
| Point the phone at SyncHub directly (`GET /v1/sync/changes`) | The hub's only credential is the Pro `setup_token`, which authorizes reading the **entire corpus**. Putting it in a phone bookmark is strictly worse than the LAN token. The hub also has no browser session, no Pro gate and serves no pages. |
| SSE from cmem.ai | The house removed realtime deliberately (0.5 trap 1): `/api/stream` answers 410 `polling_required`, the Realtime broadcast trigger was dropped in `drizzle/0020`, and the live dashboard polls. Building SSE fights the codebase. |
| Reuse `GET /api/observations` for the phone | Returns full bodies (`content-serving.ts:445-461`). Directly violates the content lock. |
| Add an `after`/`since` cursor to `timeline()` | Changes a DAL used by the MCP surface for a need the client can meet with an id `Set` (0.5 trap 2). |
| Store titles in Postgres for the TV | `drizzle/0020` retired Postgres content on purpose; all content serves from Turbopuffer. A new table re-opens a closed decision. |
| A new hosted service (Vercel/Cloudflare/Supabase) for the relay | Two hosted services already exist and both already authenticate this user. A third is unjustified. |
| Build the iOS lane first | The lock says *prefer normal browser*; the app lane is conditional on a recorded browser failure (Phase 5 gate). |
| A native/PWA install for the phone | Not asked for. The lock says normal browser. |
| `?token=` on the hosted page | Query tokens land in provider logs and `Referer` on a hosted origin, and the session already exists. Constraint 3. |

---

## Appendix C — Assumptions and open questions

**Assumptions made (stated, not silently taken):**

1. **"Content = obs titles" means the `title` field, not `title || subtitle`.** The LAN TV falls
   back to `subtitle` when `title` is null (`tv.html:209`). `TimelineRow` carries `subtitle`
   nowhere, so the hosted path cannot fall back even if we wanted to — and the conservative
   reading of the lock says it should not. **Consequence:** a null-title observation appears on
   the LAN TV and not on the phone. Reversing this is not a one-line change here (it would need
   `subtitle` added to the Turbopuffer serving attributes), which is why it is called out rather
   than buried.
2. **`snippet` is body content and is excluded.** It is available on `TimelineRow` at zero extra
   cost, which makes it the most likely thing to get added by accident. It is a body excerpt;
   the lock says titles.
3. **Alex has cloud sync enabled.** The recommended route delivers nothing to a user who does
   not. If that assumption is wrong, this plan is the wrong plan and Appendix A is the right one —
   check before starting Phase 1.

**Open questions for the Prioritizer — none of these block Phase 1:**

1. Should `/tv` be Pro-gated, or available to any signed-in user with synced content? The plan
   assumes Pro-gated (`isProActive`), matching every other authenticated surface. Ungating is a
   one-line change.
2. Is a plainer card (no `platform_source` accent, no `type`) acceptable, or is adding those two
   fields to `CONTENT_V2_SERVING_ATTRIBUTES` in scope for a follow-up? The plan assumes plainer
   is fine for v1.
3. Should the hosted TV show summaries as well as observations? `timeline()` returns both kinds
   (`TimelineRow.kind`); Phase 1 filters to `observation`. Trivial to widen later.
