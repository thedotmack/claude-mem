# Cloud Architecture Plan — Claude-Mem Pro

> Reconstructed from memory · March 2, 2026 · Fleshed out March 3, 2026
> Status: **Execution-Ready Draft**

---

## How to Use This Document

Each phase is self-contained. A fresh Claude Code context can execute any phase by reading:
1. This document (for the task list and context)
2. The specific files referenced in that phase

Phases must be executed in order (1 → 2 → 3 → 4 → 5). Each phase has a verification checklist — do not proceed to the next phase until all checks pass.

---

## Current State Summary

### What's Built and Working
- **33 API routes** in `src/app/api/` — complete Pro backend
- **Supabase PostgreSQL** with 5 tables: `pro_users`, `pro_usage`, `pro_observations`, `pro_summaries`, `pro_prompts`
- **Pinecone** vector store with namespace-per-user isolation
- **Stripe** payment flow: checkout → webhook → provisioning → setup token
- **Dashboard UI**: landing page, auth (GitHub/Google/email via Supabase Auth), paywall, feed, sidebar
- **Two data paths**: "Store" endpoints (cloud-primary, `/api/pro/store/*`) and "Sync" endpoints (local-to-cloud, `/api/pro/sync/*`)
- **Deployment**: Cloudflare via OpenNext adapter, dev server on PM2

### What's Broken or Missing
1. **RLS not enabled** — commented out in migration `0002`, all queries use service role key with app-level `user_id` filtering
2. **SSE dead for Pro users** — `src/app/api/stream/route.ts` short-circuits to a dead stream for authenticated users instead of trying the local worker first. Fix: dual-path SSE (worker passthrough + Supabase Realtime fallback). See Phase 4
3. **Embedding dimension conflict** — setup script creates 384d index, but `pinecone.ts` uses `multilingual-e5-large` (1024d) via Pinecone inference API. Production index dimension needs verification
4. **`/pro-setup` skill not built** in claude-mem worker — users can't onboard (PR #854 implements this)
5. **PR #1 (migrate-ui-work)** unmerged in claude-mem-pro — contains dashboard enhancements (+2,351/-79 lines)
6. **PR #854 (pro-cloud-sync-v2)** unmerged in claude-mem — contains complete Pro sync implementation (+3,907/-579 lines) by bigph00t
7. **Documentation drift** — multiple docs reference Turso (replaced by Supabase) and better-auth (replaced by Supabase Auth)

### Architecture Decisions (Final)
| Decision | Choice | Rationale |
|----------|--------|-----------|
| Content storage | Supabase PostgreSQL (shared tables + user_id) | Replaced Turso on Jan 26. Simpler than per-user DBs |
| Vector storage | Pinecone Serverless (namespace per user) | ~$5/mo for 100 users vs $56/mo self-hosted |
| Authentication | Supabase Auth (GitHub, Google, email) | Replaced better-auth on Jan 26 |
| Embeddings | Server-side via Pinecone inference API | `multilingual-e5-large` model, generated on upsert |
| Data flow | Hybrid: cloud-primary store + local-to-cloud sync | Workers can store directly or sync from local SQLite |
| Tenant isolation | Shared DB + RLS + Pinecone namespaces | Rejected per-customer Supabase at $25/project/mo |
| Streaming | Real-time SSE for all users: worker passthrough (primary) + Supabase Realtime relay (fallback) | Pro users MUST have live streaming, same as or better than local |

---

## Phase 0: Discovery (✅ Done)

- [x] Audit existing API routes → 33 live Pro endpoints
- [x] Confirm Supabase/Pinecone/Stripe integrations working
- [x] Catalog PR #1 UI enhancements (+2,351/-79 lines)
- [x] Identify Pro UI source → claude-mem-ui-5-0 repo (React/Vite/WebGL)
- [x] Full codebase audit with function signatures, schemas, and data flows

---

## Phase 1: Tenant Isolation & Security

**Goal**: Enable row-level security on all Pro data tables and verify Pinecone namespace isolation.

### Task 1.1: Resolve Embedding Dimension Conflict

**Problem**: `scripts/setup-pinecone.ts:47` creates index with `dimension: 384`, but `src/lib/pro/pinecone.ts:11` uses `PINECONE_EMBEDDING_MODEL=multilingual-e5-large` which produces 1024d vectors.

**Steps**:
1. Check the production Pinecone index dimension:
   ```bash
   # Run from project root with PINECONE_API_KEY set
   npx tsx -e "
   const { Pinecone } = require('@pinecone-database/pinecone');
   const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
   pc.describeIndex('claude-mem-pro').then(d => console.log(JSON.stringify(d, null, 2)));
   "
   ```
2. **If index is 384d** (matches setup script):
   - The Pinecone inference API with `multilingual-e5-large` produces 1024d vectors
   - Upserts would fail silently or error
   - **Fix**: Either recreate index at 1024d, or switch embedding model to one producing 384d
   - Recommended: Recreate index at 1024d since `multilingual-e5-large` is the better model
   - Update `scripts/setup-pinecone.ts:47` to `dimension: 1024`
3. **If index is 1024d** (already fixed manually):
   - Just update `scripts/setup-pinecone.ts:47` to `dimension: 1024` for consistency
4. Update test vector in `scripts/setup-pinecone.ts:86` from `Array(384)` to `Array(1024)`

**Files to modify**:
- `scripts/setup-pinecone.ts` — lines 47 and 86

### Task 1.2: Create RLS Migration

**File to create**: `drizzle/0004_enable_rls.sql`

```sql
-- Enable Row Level Security on all Pro data tables
ALTER TABLE pro_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pro_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE pro_prompts ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only access their own observations
CREATE POLICY "Users can only access their own observations"
  ON pro_observations FOR ALL
  USING (auth.uid()::text = user_id);

-- Policy: Users can only access their own summaries
CREATE POLICY "Users can only access their own summaries"
  ON pro_summaries FOR ALL
  USING (auth.uid()::text = user_id);

-- Policy: Users can only access their own prompts
CREATE POLICY "Users can only access their own prompts"
  ON pro_prompts FOR ALL
  USING (auth.uid()::text = user_id);

-- Service role bypasses RLS, so existing admin client queries still work
-- But if a user somehow gets a direct connection, they can only see their own data

-- Enable REPLICA IDENTITY FULL for Supabase Realtime filtered subscriptions (Phase 4 SSE)
ALTER TABLE pro_observations REPLICA IDENTITY FULL;
ALTER TABLE pro_summaries REPLICA IDENTITY FULL;
ALTER TABLE pro_prompts REPLICA IDENTITY FULL;
```

**How to apply**: Run in Supabase Dashboard SQL Editor, or use:
```bash
npx tsx scripts/run-migrations.ts
```

**IMPORTANT**: The service role key (`SUPABASE_SERVICE_ROLE_KEY`) used by `getAdminClient()` in `src/lib/pro/supabase.ts` automatically bypasses RLS. All existing server-side queries will continue working unchanged. RLS adds defense-in-depth if someone obtains the anon key.

### Task 1.3: Verify Pinecone Namespace Isolation

**What to check**: Each Pro user gets a unique namespace `user_<first8chars_of_userId>`.

**Where this happens**:
- `src/app/api/webhooks/stripe/route.ts` — generates `pineconeNamespace` during `checkout.session.completed`:
  ```typescript
  pineconeNamespace: `user_${userId.substring(0, 8)}`
  ```
- `src/lib/pro/auth.ts` — `validateSyncRequest()` returns the namespace from `pro_users` table, with fallback:
  ```typescript
  pineconeNamespace: proUser.pineconeNamespace || `user_${proUser.userId.substring(0, 8)}`
  ```

**Verification steps**:
1. Query `pro_users` table to confirm all active users have unique `pinecone_namespace` values
2. Check Pinecone index stats to confirm namespaces match
3. Verify that `queryVectors()` in `src/lib/pro/pinecone.ts` always scopes to the user's namespace (it does — `getUserNamespace(namespace)` on line ~60)

**Risk**: Two users whose Supabase `user_id` starts with the same 8 characters would collide. This is astronomically unlikely with UUID v4 but should be documented.

### Task 1.4: Add RLS to pro_users Table

The `pro_users` table itself doesn't have RLS. Since it contains `setup_token`, `stripe_customer_id`, and `pinecone_namespace`, add protection:

```sql
ALTER TABLE pro_users ENABLE ROW LEVEL SECURITY;

-- Users can only read their own pro_users row
CREATE POLICY "Users can only access their own pro record"
  ON pro_users FOR SELECT
  USING (auth.uid()::text = user_id);

-- Only service role can insert/update/delete (handled by webhooks and admin APIs)
CREATE POLICY "Service role manages pro records"
  ON pro_users FOR ALL
  USING (auth.role() = 'service_role');
```

### Verification Checklist — Phase 1
- [ ] Pinecone index dimension confirmed (384 or 1024) and setup script updated
- [ ] RLS migration created and applied to Supabase
- [ ] All 4 tables have RLS enabled: `pro_observations`, `pro_summaries`, `pro_prompts`, `pro_users`
- [ ] Existing API routes still work (service role bypasses RLS)
- [ ] Namespace isolation verified in Pinecone stats
- [ ] Test: Create observation via `/api/pro/store/observation` — should succeed
- [ ] Test: Query observations via `/api/observations` as Pro user — should return only that user's data

### Anti-Pattern Guards — Phase 1
- **DO NOT** switch from admin client to anon client for server-side queries. The admin client (service role) is correct for API routes — RLS is a defense-in-depth layer, not the primary access control
- **DO NOT** create per-user Supabase policies with hardcoded user IDs. Use `auth.uid()::text = user_id` pattern
- **DO NOT** delete and recreate the Pinecone index if it has production data. Instead, check dimension first

---

## Phase 2: Sync Implementation (claude-mem Worker Side)

**Goal**: Enable the claude-mem worker to authenticate with the Pro API and sync data to the cloud.

**Context**: This phase involves changes to the **claude-mem** repository (the MCP plugin), not claude-mem-pro (the web app). The web app endpoints are already built.

### Task 2.1: Understand the Existing Sync API

The claude-mem-pro web app already has all the endpoints needed. Here's the complete sync flow:

#### Onboarding Flow (One-Time)
```
User subscribes → Stripe webhook → pro_users row created with setup_token
User runs /pro-setup → Worker calls POST /api/pro/validate-setup { setup_token }
                     → Returns { userId, pineconeNamespace, apiUrl, planTier }
                     → Worker saves to ~/.claude-mem/pro.json
```

#### Sync Flow (Ongoing)
```
Worker creates observation locally (SQLite)
  → Calls GET /api/pro/sync/status?project=X
    Headers: Authorization: Bearer <setup_token>, X-User-Id: <userId>
  → Returns { observations: [synced_local_ids], summaries: [...], prompts: [...] }
  → Worker diffs local IDs against synced IDs
  → Calls POST /api/pro/sync/observations/batch { observations: [...unsynced] }
  → Cloud upserts to Supabase + embeds to Pinecone
```

#### Cloud-Primary Flow (Alternative)
```
Worker creates observation
  → Instead of local SQLite, calls POST /api/pro/store/batch
  → Cloud stores directly + embeds to Pinecone
  → Returns { observationIds, summaryId, createdAtEpoch }
```

### Task 2.2: Wire Up `/pro-setup` Skill

**What it needs to do**:
1. Prompt user for setup token (format: `cm_pro_<32-hex-chars>`)
2. Call `POST /api/pro/validate-setup` with the token
3. Receive credentials: `{ userId, pineconeNamespace, apiUrl, planTier }`
4. Save to `~/.claude-mem/pro.json`
5. Optionally trigger background migration of existing local data

**API endpoint details** (`src/app/api/pro/validate-setup/route.ts`):
- Method: `POST`
- Body: `{ setup_token: string }`
- Auth: Token validation (24-hour expiry for unused tokens)
- Response: Full cloud config including Supabase and Pinecone credentials

**Alternative simpler endpoint** (`src/app/api/pro/initialize/route.ts`):
- Method: `POST`
- Body: `{ setupToken: string }` (note camelCase)
- Auth: Token format validation + DB lookup (30-day expiry)
- Response: `{ userId, pineconeNamespace, apiUrl }` + confirms Pinecone namespace exists

### Task 2.3: Implement Session-End Sync Hook

**Trigger**: After claude-mem worker finishes processing a session (creates observations + summary).

**Sync strategy**: "Pull status, push deltas"
1. `GET /api/pro/sync/status?project=<project>` → get list of already-synced `local_id` values
2. Diff against local SQLite IDs
3. Batch push unsyced items:
   - `POST /api/pro/sync/observations/batch` — body: `{ observations: [...] }`
   - `POST /api/pro/sync/summaries/batch` — body: `{ summaries: [...] }`
   - `POST /api/pro/sync/prompts/batch` — body: `{ prompts: [...] }`

**All sync endpoints require these headers**:
```
Authorization: Bearer <setup_token>
X-User-Id: <userId>
Content-Type: application/json
```

**Auth validation** (`src/lib/pro/auth.ts:validateSyncRequest`):
- Extracts token from `Authorization: Bearer <token>` header
- Extracts userId from `X-User-Id` header
- Looks up `pro_users` row where `setup_token = token` AND `user_id = userId`
- Checks `payment_status` is 'active' (or 'cancelled' if `allowCancelled` option set)
- Returns `{ valid: true, userId, pineconeNamespace, subscriptionActive }` or `{ valid: false, error }`

### Task 2.4: Rebase PR #854 (claude-mem main)

**PR #854** in the claude-mem repo (`feat/pro-cloud-sync-v2` branch) contains the complete Pro cloud sync implementation (+3,907/-579 lines, 35 files) by bigph00t. It needs to be rebased on the current claude-mem main branch.

**What the PR contains** (confirmed via diff review):
- `CloudSync.ts` (966 lines) — core sync service, all API communication with claude-mem-pro
- `SyncProvider.ts` (220 lines) — pluggable sync backend interface (ChromaSync vs CloudSync)
- `ProConfig.ts` (306 lines) — `~/.claude-mem/pro.json` management, token validation
- `ProRoutes.ts` (510 lines) — `/api/pro/setup`, `/api/pro/status`, `/api/pro/disconnect`, `/api/pro/import`
- `VectorSearchStrategy.ts` (239 lines) — Pinecone-backed semantic search
- `ResponseProcessor.ts` refactored — dual storage path (Pro→cloud, free→SQLite), **SSE broadcast for both paths**
- `ObservationBroadcaster.ts` — `cloud_storage_warning` SSE event on cloud failure
- `/pro-setup` and `/pro-import` skill definitions
- Version bump 9.0.6 → 9.0.10

### Task 2.5: Background Migration (Backfill)

When a user first sets up Pro, they may have thousands of existing local observations. The backfill process:

1. Read all local observations from SQLite
2. Call `GET /api/pro/sync/status?project=<project>` to get already-synced IDs
3. Filter out already-synced items
4. Batch sync remaining items (the batch endpoints handle Pinecone embedding server-side)
5. Call `POST /api/pro/complete-setup` with migration stats:
   ```json
   {
     "setup_token": "cm_pro_...",
     "observations_migrated": 847,
     "summaries_migrated": 42,
     "prompts_migrated": 1203,
     "vectors_migrated": 2500
   }
   ```

**Batch endpoint details**:
- `POST /api/pro/sync/observations/batch` — accepts `{ observations: ObservationInput[] }`
- Each observation must include: `localId`, `memorySessionId`, `project`, `type`, `title`, `narrative`, `facts`, `createdAtEpoch`
- Upserts on `(user_id, local_id)` unique constraint — safe to retry
- Server generates embeddings via Pinecone inference API — worker does NOT need to send vectors

### Verification Checklist — Phase 2
- [ ] `/pro-setup` skill works: token → validate → save credentials
- [ ] Sync status endpoint returns correct list of synced local IDs
- [ ] Batch sync of 100 observations succeeds (check Supabase row count + Pinecone vector count)
- [ ] Backfill migration completes for a user with 500+ local observations
- [ ] `POST /api/pro/complete-setup` records migration stats in `pro_users` table
- [ ] Auth validation rejects expired tokens (>30 days)
- [ ] Auth validation rejects cancelled subscriptions (except `/api/pro/export` with `allowCancelled`)

### Anti-Pattern Guards — Phase 2
- **DO NOT** send pre-computed embeddings from the worker. The cloud generates embeddings server-side using Pinecone inference API
- **DO NOT** use the anon key for sync requests. Use the setup token in `Authorization: Bearer` header
- **DO NOT** sync all data every time. Use the status endpoint to diff and only push deltas
- **DO NOT** skip the `X-User-Id` header — `validateSyncRequest` requires both token AND userId

---

## Phase 3: Vector Store Verification

**Goal**: Confirm that Pinecone semantic search works end-to-end for Pro users, with correct embedding dimensions and cross-device search capability.

### Task 3.1: Verify Embedding Pipeline

**Current implementation** (`src/lib/pro/pinecone.ts`):

```typescript
// generateEmbeddings() uses Pinecone's inference API
const response = await pc.inference.embed(
  EMBEDDING_MODEL,  // 'multilingual-e5-large' (produces 1024d vectors)
  batchTexts,       // Max 96 texts per request
  { inputType: 'passage' }
);
```

**Where embeddings are generated**:
1. `embedAndUpsert(namespace, texts, ids, baseMetadata)` — for single-item storage
   - Called from: `/api/pro/store/batch`, `/api/pro/store/observation`, `/api/pro/store/summary`, `/api/pro/store/prompt`
   - Called from: `/api/pro/sync/observation`, `/api/pro/sync/summary`, `/api/pro/sync/prompt`
2. `embedAndUpsertBatch(namespace, texts, ids, metadatas)` — for batch operations
   - Called from: `/api/pro/sync/observations/batch`, `/api/pro/sync/summaries/batch`, `/api/pro/sync/prompts/batch`
3. `queryVectors(namespace, queryText, topK, filter)` — for search
   - Embeds the query text, then searches Pinecone
   - Uses `{ inputType: 'passage' }` for query too (should be `'query'` — potential bug)

**What gets embedded per observation** (from `/api/pro/store/batch/route.ts`):
- `obs.narrative` → vector ID: `obs_<cloudId>_narrative`
- Each `obs.facts[i]` → vector ID: `obs_<cloudId>_fact_<i>`

**What gets embedded per summary**:
- Each field (request, investigated, learned, completed, nextSteps, notes) → vector ID: `summary_<cloudId>_<fieldName>`

**What gets embedded per prompt** (from `/api/pro/store/prompt/route.ts`):
- `prompt.promptText` → vector ID: `prompt_<cloudId>`

### Task 3.2: Fix Query Input Type

**Bug**: In `queryVectors()`, the embedding for search queries should use `inputType: 'query'` not `'passage'`. The `multilingual-e5-large` model distinguishes between passages (documents being indexed) and queries (search terms).

**File**: `src/lib/pro/pinecone.ts`
**Fix**: In the `queryVectors` function, when generating the query embedding, change:
```typescript
// Before
const response = await pc.inference.embed(EMBEDDING_MODEL, [queryText], { inputType: 'passage' });
// After
const response = await pc.inference.embed(EMBEDDING_MODEL, [queryText], { inputType: 'query' });
```

Note: Need to verify the exact location — `queryVectors` calls `generateEmbeddings()` which hardcodes `inputType: 'passage'`. May need to add an optional parameter to `generateEmbeddings()` or create a separate `generateQueryEmbedding()` function.

### Task 3.3: Test Semantic Search End-to-End

**Search endpoint**: `POST /api/pro/sync/query`
```json
{
  "query": "how does authentication work",
  "limit": 10,
  "project": "my-project",
  "filter": { "doc_type": "observation" }
}
```

**Response format**:
```json
{
  "ids": [42, 17, 85],
  "distances": [0.92, 0.87, 0.81],
  "metadatas": [
    { "doc_type": "observation", "project": "my-project", "title": "...", "local_id": 42 },
    ...
  ]
}
```

**Hydration**: After getting vector search results, fetch full records:
```
POST /api/pro/fetch/observations { "ids": [42, 17, 85] }
POST /api/pro/fetch/summaries { "ids": [...] }
POST /api/pro/fetch/prompts { "ids": [...] }
```

### Task 3.4: Embed Endpoint for Worker

**Endpoint**: `POST /api/pro/embed`
```json
{
  "setup_token": "cm_pro_...",
  "texts": ["text to embed 1", "text to embed 2"]
}
```
- Max 96 texts per request
- Returns 1024d vectors (multilingual-e5-large)
- Used by workers that need embeddings for local search but want better quality than local model

### Verification Checklist — Phase 3
- [ ] `POST /api/pro/store/observation` creates vectors in Pinecone (check namespace stats)
- [ ] `POST /api/pro/sync/query` returns relevant results for natural language queries
- [ ] Vector IDs follow the naming convention: `obs_<id>_narrative`, `obs_<id>_fact_<n>`, `summary_<id>_<field>`, `prompt_<id>`
- [ ] Search results can be hydrated via `/api/pro/fetch/*` endpoints
- [ ] Query input type uses 'query' not 'passage' for search
- [ ] Embedding dimension matches Pinecone index dimension (both 1024d)

### Anti-Pattern Guards — Phase 3
- **DO NOT** use local `all-MiniLM-L6-v2` embeddings (384d) with the cloud Pinecone index that uses `multilingual-e5-large` (1024d). Dimensions must match
- **DO NOT** send more than 96 texts per embed request — Pinecone's limit
- **DO NOT** use `inputType: 'passage'` for search queries — use `'query'`

---

## Phase 4: Pro UI & Live Streaming

**Goal**: Enable real-time SSE streaming for Pro users, merge UI enhancements, and integrate the cyberpunk memory stream viewer.

**CRITICAL REQUIREMENT FROM OWNER**: Pro users MUST have live real-time SSE streaming, same as or better than local users. Do NOT fall back to pagination-only. The worker sends events, the cloud relays them, the UI renders them in real-time.

### SSE Architecture for Pro Users

**Key insight from PR #854**: The claude-mem worker continues broadcasting SSE events on localhost:37777 even in Pro mode. When `ResponseProcessor` stores data via `CloudSync` (to Supabase + Pinecone), it also calls `broadcastObservationsToSSE()` and `broadcastSummaryToSSE()` on the local SSE broadcaster. This means the existing SSE passthrough should work for Pro users — the `/api/stream` route just needs to stop short-circuiting.

**Dual-Path SSE Architecture**:

```
PATH 1 — Pro user WITH local worker running (primary):
  Worker stores → Supabase + Pinecone (via CloudSync)
  Worker broadcasts → SSE on localhost:37777
  Browser → /api/stream → Next.js proxies localhost:37777 → real-time events

PATH 2 — Pro user WITHOUT local worker (fallback, e.g. different device):
  Data already in Supabase (synced from another device)
  Browser → /api/stream → Next.js creates Supabase Realtime subscription
  Supabase Realtime → listens for INSERT on pro_observations/pro_summaries/pro_prompts
  → Converts to SSE events → streams to browser

CONNECTION PRIORITY (in /api/stream route):
  1. Try localhost:37777/stream with 2-second timeout
  2. If worker available → passthrough SSE (same as free users)
  3. If worker unavailable + user authenticated → Supabase Realtime SSE relay
  4. If worker unavailable + no auth → 503 error
```

### Task 4.1: Merge PR #1 — Dashboard Enhancements (FIRST)

**PR #1** in claude-mem-pro: "Migrate UI work from Claude-mem to Pro"
- **Branch**: `claude/migrate-ui-work-01TSWb2R3ueZYy35jYPVqxch`
- **Author**: thedotmack
- **Stats**: +2,351/-79 lines, 23 files
- **Status**: OPEN, base branch: main

**What it adds** (no SSE changes — purely UI migration):

| File | Lines | Description |
|------|-------|-------------|
| `src/components/dashboard/ContextSettingsModal.tsx` | 552 | Two-column modal: live terminal preview + collapsible settings (observation count, type/concept chip filters, token economics toggles, model selection, MCP toggle) |
| `src/app/(authenticated)/dashboard.css` | 1,168 | Complete CSS for all dashboard components (cards, feed, modal, toggles, chips, sidebar, header, responsive) |
| `src/components/dashboard/TerminalPreview.tsx` | 131 | Context preview display component |
| `src/hooks/useContextPreview.ts` | 78 | Fetches `/api/projects` and `/api/context/preview?project=<name>` with 300ms debounce |
| `src/hooks/useGitHubStars.ts` | 48 | GitHub public API star count |
| `src/components/dashboard/GitHubStarsButton.tsx` | 53 | Star count button |
| `src/app/login/page.tsx` | 34 | Login page component |
| `src/app/login/login.css` | 84 | Login page styles |
| `src/components/dashboard/Header.tsx` | +25/-40 | Queue depth indicator, GitHub stars button, Discord link |
| `src/components/dashboard/SummaryCard.tsx` | +49/-34 | Section-based layout with icons, semantic HTML |
| `src/hooks/useSettings.ts` | +20/-1 | Maps 13 new settings fields with DEFAULT_SETTINGS fallbacks |
| `src/types/index.ts` | +19 | 13 new optional Settings fields (token economics, observation filtering, display config) |
| `src/constants/settings.ts` | +19 | DEFAULT_SETTINGS entries for all new fields |
| `src/middleware.ts` | +5/-4 | `/login` added to public routes, unauthenticated redirect → `/login` |
| `src/utils/formatters.ts` | +24 | `formatStarCount()` (compact k/M notation) |
| `public/icon-thick-*.svg` | 4 files | Summary section icons (completed, investigated, learned, next-steps) |
| `public/claude-mem-logomark.webp` | 1 file | Logomark asset |

**Merge steps**:
```bash
cd /home/userclaw/projects/claude-mem-pro
git fetch origin
git checkout claude/migrate-ui-work-01TSWb2R3ueZYy35jYPVqxch
git rebase main  # resolve conflicts if any
git checkout main
git merge claude/migrate-ui-work-01TSWb2R3ueZYy35jYPVqxch
pm2 restart claude-mem-pro-dev  # verify dev server works
```

**Potential conflicts**: Dashboard components may have been modified on main after PR was created. Pay attention to `Header.tsx`, `SummaryCard.tsx`, `useSettings.ts`, `types/index.ts`.

**Verification after merge**:
- [ ] Dev server starts without errors
- [ ] Dashboard renders with new ContextSettingsModal
- [ ] Login page renders at `/login`
- [ ] SummaryCards show section-based layout with icons
- [ ] No TypeScript or build errors

### Task 4.2: Fix SSE for Pro Users — Dual-Path Streaming

**Files to modify**:
- `src/app/api/stream/route.ts` — complete rewrite of the routing logic
- `src/hooks/useSSE.ts` — add `'connected'` event handling
- `src/types/index.ts` — add `'connected'` to `StreamEvent.type` union

#### Step 1: Rewrite `/api/stream` route

**Current broken logic** (`src/app/api/stream/route.ts`):
```typescript
// BROKEN: Checks for Supabase session first, short-circuits to dead stream
if (user?.id) {
  // Sends one event then goes silent forever
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'connected', mode: 'cloud' })}\n\n`));
}
```

**New logic** — try worker first, Supabase Realtime fallback:
```typescript
import { createClient } from '@/lib/supabase/server';
import { createClient as createAdminClient } from '@supabase/supabase-js';
import { getStats } from '@/lib/pro/supabase';

const CLAUDE_MEM_API = process.env.CLAUDE_MEM_API || 'http://localhost:37777';
const encoder = new TextEncoder();
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
};

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // PATH 1: Try local worker SSE passthrough (works for BOTH Pro and Free users)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const workerResponse = await fetch(`${CLAUDE_MEM_API}/stream`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (workerResponse.ok && workerResponse.body) {
      return new NextResponse(workerResponse.body, { headers: SSE_HEADERS });
    }
  } catch {
    // Worker not available — fall through to next path
  }

  // PATH 2: Pro user without local worker → Supabase Realtime SSE relay
  if (user?.id) {
    return createSupabaseRealtimeSSE(user.id);
  }

  // PATH 3: No worker, no auth → error
  return new NextResponse(
    `data: ${JSON.stringify({ type: 'error', message: 'No data source available' })}\n\n`,
    { status: 503, headers: SSE_HEADERS }
  );
}

function createSupabaseRealtimeSSE(userId: string): NextResponse {
  const encoder = new TextEncoder();
  let realtimeChannel: ReturnType<ReturnType<typeof createAdminClient>['channel']> | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      // Send initial_load with project list from Supabase
      try {
        const stats = await getStats(userId);
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({
            type: 'initial_load',
            projects: stats.projects || [],
          })}\n\n`
        ));
      } catch (e) {
        console.error('Failed to load initial stats:', e);
        controller.enqueue(encoder.encode(
          `data: ${JSON.stringify({ type: 'initial_load', projects: [] })}\n\n`
        ));
      }

      // Send connected event
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ type: 'connected', mode: 'cloud-realtime' })}\n\n`
      ));

      // Subscribe to Supabase Realtime for this user's data
      const adminSupabase = createAdminClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      );

      realtimeChannel = adminSupabase
        .channel(`pro-stream-${userId}`)
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'pro_observations',
          filter: `user_id=eq.${userId}`,
        }, (payload) => {
          try {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'new_observation', observation: payload.new })}\n\n`
            ));
          } catch { /* stream closed */ }
        })
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'pro_summaries',
          filter: `user_id=eq.${userId}`,
        }, (payload) => {
          try {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'new_summary', summary: payload.new })}\n\n`
            ));
          } catch { /* stream closed */ }
        })
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'pro_prompts',
          filter: `user_id=eq.${userId}`,
        }, (payload) => {
          try {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'new_prompt', prompt: payload.new })}\n\n`
            ));
          } catch { /* stream closed */ }
        })
        .subscribe();

      // Keepalive every 30 seconds to prevent Cloudflare/Vercel from dropping the connection
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 30000);

      // Cleanup handler (called when client disconnects)
      request.signal?.addEventListener('abort', () => {
        clearInterval(keepalive);
        if (realtimeChannel) {
          adminSupabase.removeChannel(realtimeChannel);
        }
      });
    },
    cancel() {
      // Additional cleanup if stream is cancelled
      if (realtimeChannel) {
        const adminSupabase = createAdminClient(
          process.env.SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        );
        adminSupabase.removeChannel(realtimeChannel);
      }
    },
  });

  return new NextResponse(stream, { headers: SSE_HEADERS });
}
```

**Important Supabase Realtime prerequisite**: Supabase Realtime requires that the tables have `REPLICA IDENTITY FULL` set for filtered subscriptions. Add to the RLS migration (Phase 1, Task 1.2):
```sql
ALTER TABLE pro_observations REPLICA IDENTITY FULL;
ALTER TABLE pro_summaries REPLICA IDENTITY FULL;
ALTER TABLE pro_prompts REPLICA IDENTITY FULL;
```

#### Step 2: Update `useSSE` hook

In `src/hooks/useSSE.ts`, add handling for the `'connected'` event type (currently falls through silently):

```typescript
// In the switch statement that handles incoming events:
case 'connected':
  // Cloud mode connected — Supabase Realtime active, events will follow
  console.log(`SSE connected: mode=${data.mode}`);
  break;
```

#### Step 3: Update `StreamEvent` type

In `src/types/index.ts`, add `'connected'` to the type union and add `mode` field:
```typescript
export interface StreamEvent {
  type: 'initial_load' | 'new_observation' | 'new_summary' | 'new_prompt' | 'processing_status' | 'connected';
  // ... existing fields ...
  mode?: 'cloud' | 'cloud-realtime' | 'local';
}
```

### Task 4.3: Integrate claude-mem-ui-5-0 Components (Cyberpunk Memory Stream)

**Source repo**: `claude-mem-ui-5-0` — React/Vite app with WebGL orb, cyberpunk aesthetic, real-time SSE streaming
**Repo location**: `git@github.com:thedotmack/claude-mem-ui-5-0.git`

**Key components to migrate**:

| Source File | Description | Lines | Migration Approach |
|-------------|-------------|-------|--------------------|
| `Stream.jsx` | Root component: project view manager, session grouping, split-view (overview + live) | ~800 | Adapt to Next.js — extract state management, replace Vite imports |
| `src/components/LiveMemoryView.jsx` | Real-time observation animation state machine (cards fly in with spring physics) | ~450 | Pure React + CSS — convert to TSX, wire to `useSSE` |
| `src/components/OverviewCard.jsx` | Session overview cards with expand/collapse, stats, metadata | ~400 | Mostly presentational — straightforward port |
| `server.js` | Express SSE server on port 37777 | N/A | Already replaced by Next.js `/api/stream` |
| WebGL orb (`ThreeOrb.jsx` or similar) | 3D animated orb with shader effects | ~300 | Evaluate — may use Three.js (heavy) or could port to Canvas/Framer Motion |

**Migration steps**:
1. Clone repo locally: `git clone git@github.com:thedotmack/claude-mem-ui-5-0.git /tmp/claude-mem-ui-5-0`
2. Read each component's CLAUDE.md for architecture context
3. Create target directory: `src/components/stream/`
4. Port presentational components first (OverviewCard → `OverviewCard.tsx`)
5. Port LiveMemoryView → `LiveMemoryView.tsx` (convert animations to Framer Motion if Three.js-dependent)
6. Port Stream layout logic → integrate into dashboard page or new `/stream` route
7. Add `'use client'` directive to all ported components
8. Wire to existing `useSSE` hook for real-time data
9. Test with both local worker SSE and Supabase Realtime SSE paths

**Key architecture from claude-mem-ui-5-0 CLAUDE.md**:
- React 18 + Vite (we're on React 19 + Next.js 16 — minor API differences)
- SSE via native `EventSource` (same pattern as our `useSSE` hook)
- Cyberpunk aesthetic with glow effects, dark theme, neon accents
- The WebGL orb uses Three.js — evaluate if we can use a lighter Canvas approach instead, or keep Three.js as an optional dependency

**Target directory structure**:
```
src/components/stream/
├── LiveMemoryView.tsx    # Real-time observation animation
├── OverviewCard.tsx      # Session overview cards
├── StreamLayout.tsx      # Split-view layout manager
├── MemoryCard.tsx        # Individual observation cards
└── index.ts              # Barrel exports
```

### Task 4.4: Merge bigph00t Contributions from claude-mem

**PR #854** in claude-mem: "feat: Pro cloud sync integration with Supabase + Pinecone"
- **Branch**: `feat/pro-cloud-sync-v2`
- **Author**: Alexander Knigge (@bigph00t), co-authored by Claude Opus 4.5
- **Stats**: +3,907/-579 lines, 35 files, version bump 9.0.6 → 9.0.10
- **Status**: OPEN, not merged

**What PR #854 implements** (in the **claude-mem** repo, not claude-mem-pro):

| File | Lines | Description |
|------|-------|-------------|
| `src/services/sync/CloudSync.ts` | 966 | Core cloud sync service — all communication with claude-mem-pro API. Handles sync mode (backfill from SQLite) and cloud-primary mode (direct store) |
| `src/services/sync/SyncProvider.ts` | 220 | Abstract interface for pluggable sync backends (ChromaSync for free, CloudSync for Pro) |
| `src/services/pro/ProConfig.ts` | 306 | Pro user config manager — reads/writes `~/.claude-mem/pro.json`, token validation, 0600 file permissions |
| `src/services/worker/http/routes/ProRoutes.ts` | 510 | HTTP endpoints: `GET /api/pro/status`, `POST /api/pro/setup`, `POST /api/pro/disconnect`, `POST /api/pro/import` |
| `src/services/worker/search/strategies/VectorSearchStrategy.ts` | 239 | Pinecone-backed semantic search strategy — queries vectors, hydrates from Supabase |
| `src/services/worker/ProcessRegistry.ts` | 252 | Process tracking and zombie cleanup (Issue #737) |
| `plugin/skills/pro-setup/SKILL.md` | 63 | `/pro-setup` skill definition for Claude |
| `plugin/skills/pro-import/SKILL.md` | 90 | `/pro-import` skill definition for Claude |
| `src/services/worker/agents/ResponseProcessor.ts` | +251/-125 | **Major refactor**: dual storage path — Pro stores via CloudSync, free stores via SQLite+Chroma. **SSE broadcast happens for BOTH paths** |
| `src/services/worker/agents/ObservationBroadcaster.ts` | +32 | New `broadcastCloudStorageWarning()` SSE event when Pro cloud storage fails |
| `src/services/worker/DatabaseManager.ts` | +85/-5 | Detects Pro user, creates CloudSync or ChromaSync accordingly |
| `src/services/worker/search/strategies/HybridSearchStrategy.ts` | +64/-36 | Returns `canHandle()=false` for cloud-primary mode, routing Pro to VectorSearchStrategy |
| `src/services/worker/SearchManager.ts` | +32/-32 | Renamed chroma references to vector throughout |

**Why this matters for SSE**: `ResponseProcessor.ts` in PR #854 calls `broadcastObservationsToSSE()` and `broadcastSummaryToSSE()` after storing data via CloudSync. This means **the local worker still broadcasts SSE events for Pro users** — the events flow through localhost:37777 → Next.js `/api/stream` passthrough → browser. No changes needed to the SSE infrastructure for this path.

**bigph00t's already-merged PRs** (already in claude-mem main — no action needed):
- **#426**: Gemini API provider (GeminiAgent.ts, ContextSettingsModal UI additions)
- **#751**: Windows console popup elimination
- **#792**: Persistent Chroma HTTP server (ChromaServerManager.ts) — replaced per-operation MCP subprocess
- **#806**: Zombie process fix (ProcessRegistry.ts) — PID-capturing spawn, SIGKILL escalation, orphan reaper
- **#813**: Path format mismatch fix (path-utils.ts shared module)
- **#839**: Stale memory_session_id resume crash fix

**Merge steps for PR #854**:
```bash
cd /path/to/claude-mem  # the MCP plugin repo
git fetch origin
git checkout feat/pro-cloud-sync-v2
git rebase main  # may need conflict resolution — PR is from Jan 30
# Test: run worker, verify Pro sync endpoints respond
git checkout main
git merge feat/pro-cloud-sync-v2
```

**After merge, verify**:
- [ ] Worker starts without errors
- [ ] `/api/pro/status` returns Pro configuration
- [ ] `/pro-setup` skill is available
- [ ] SSE events still broadcast for observations (both free and Pro paths)
- [ ] `CloudSync` successfully communicates with claude-mem-pro API endpoints

### Task 4.5: Make It All Fit Together

After merging PR #1 (dashboard UI), implementing Supabase Realtime SSE, integrating claude-mem-ui-5-0 components, and merging PR #854 (worker-side Pro sync):

**Integration checklist**:

1. **SSE event format consistency**: Ensure the worker's SSE events (from PR #854's ResponseProcessor) match the `StreamEvent` type expected by `useSSE`. The worker sends events like `{ type: 'observation', data: {...} }` — verify the event type names match the hook's switch cases (`new_observation`, `new_summary`, `new_prompt`).

2. **Supabase Realtime event format**: The Realtime `payload.new` is a raw database row (snake_case columns). Transform to match the camelCase `Observation`/`Summary`/`UserPrompt` types before sending via SSE. Add a transformation layer in `createSupabaseRealtimeSSE()`.

3. **Dashboard merge logic**: The dashboard's `mergeAndDeduplicateByProject()` in `src/utils/data.ts` merges SSE live items with paginated items. This works for both paths since both produce the same `StreamEvent` types. Verify deduplication works correctly when the same observation arrives via both SSE and pagination.

4. **Stream viewer integration**: The claude-mem-ui-5-0 components (LiveMemoryView, OverviewCard) need to consume from the same `useSSE` hook. Ensure they receive the observation/summary objects in the expected shape. May need adapter components or prop transformation.

5. **Cyberpunk aesthetic + dashboard**: The claude-mem-ui-5-0 uses a cyberpunk dark theme with neon accents. The dashboard CSS from PR #1 is 1,168 lines of its own styling. Decide on:
   - **Option A**: Stream view as a separate route (`/stream`) with its own theme
   - **Option B**: Stream view as a tab/mode within the dashboard
   - **Option C**: Stream components embedded in the dashboard feed

6. **Pro gating**: The dashboard already has Pro gating via the `Paywall` component. Stream components should be available to all authenticated users (Pro gets cloud data, free gets local worker data). The `isConnected` indicator in the Sidebar should accurately reflect the active connection type.

### Verification Checklist — Phase 4
- [ ] **PR #1 merged**: Dashboard renders with ContextSettingsModal, new SummaryCards, login page
- [ ] **Worker SSE passthrough works for Pro**: Pro user with local worker sees real-time events in dashboard
- [ ] **Supabase Realtime fallback works**: Pro user WITHOUT local worker sees events when data is inserted into Supabase
- [ ] **`useSSE` handles all modes**: `connected` event type recognized, no infinite reconnect loops
- [ ] **`StreamEvent` type updated**: includes `'connected'` type and `mode` field
- [ ] **claude-mem-ui-5-0 components integrated**: LiveMemoryView and OverviewCard render correctly
- [ ] **PR #854 merged in claude-mem**: Worker Pro sync operational, SSE broadcasts for both paths
- [ ] **End-to-end streaming test**: Create observation via worker → appears in dashboard within seconds (both paths)
- [ ] **Pro gating works**: Free users see paywall, Pro users see dashboard with live stream
- [ ] **No console errors** in browser for either Pro or Free user paths
- [ ] **Keepalive prevents disconnection**: Supabase Realtime SSE stays alive for >5 minutes on Cloudflare

### Anti-Pattern Guards — Phase 4
- **DO NOT** fall back to pagination-only for Pro users. Pro MUST have real-time SSE streaming
- **DO NOT** remove or bypass the local worker SSE passthrough. It's the primary path for Pro users who run a worker
- **DO NOT** skip the Supabase Realtime fallback. Pro users on other devices (phone, different computer) need streaming even without a local worker
- **DO NOT** import Three.js/WebGL from claude-mem-ui-5-0 without evaluating bundle size impact. Prefer Framer Motion or Canvas alternatives if possible
- **DO NOT** send raw Supabase Realtime payloads to the browser — transform snake_case DB rows to camelCase types first
- **DO NOT** create Supabase Realtime subscriptions with the anon key — use the service role key server-side in the `/api/stream` route
- **DO NOT** forget `REPLICA IDENTITY FULL` on the Pro data tables — Supabase Realtime filtered subscriptions require it

---

## Phase 5: Ship & Verify

**Goal**: End-to-end testing, security review, documentation cleanup, and production deployment.

### Task 5.1: End-to-End Test Flow

Follow the complete user journey:

1. **Signup**: Visit dashboard → Sign in with GitHub → Verify Supabase Auth session created
2. **Upgrade**: Click "Upgrade to Pro" → Complete Stripe test checkout (card: `4242 4242 4242 4242`)
3. **Webhook**: Verify `checkout.session.completed` webhook:
   - `pro_users` row created with `payment_status: 'active'`
   - `setup_token` generated (`cm_pro_<32hex>`)
   - `pinecone_namespace` set (`user_<8chars>`)
4. **Setup**: Run `/pro-setup <token>` in claude-mem worker:
   - Token validated via `POST /api/pro/initialize`
   - Credentials saved to `~/.claude-mem/pro.json`
5. **Sync**: Use Claude Code normally, then verify:
   - Observations appear in Supabase `pro_observations` table
   - Vectors appear in Pinecone namespace
   - Dashboard shows data via pagination
6. **Real-time streaming**: Verify SSE works for Pro users:
   - With local worker: Dashboard receives real-time `new_observation` events via worker SSE passthrough
   - Without local worker: Dashboard receives events via Supabase Realtime relay
   - Both paths: observations appear in the dashboard feed within seconds of creation
7. **Search**: Test semantic search via dashboard or API:
   - `POST /api/pro/sync/query { "query": "...", "limit": 10 }`
   - Results contain relevant observations
8. **Export**: Test data export:
   - `GET /api/pro/export` with valid token → returns all user data

**Stripe testing commands**:
```bash
# Start Stripe webhook listener for local development
stripe listen --forward-to localhost:3005/api/webhooks/stripe

# Trigger a test event
stripe trigger checkout.session.completed
```

### Task 5.2: Subscription Lifecycle Testing

Test the full subscription lifecycle:

1. **Active subscription**: Normal Pro access
2. **Payment failed** (`invoice.payment_failed`):
   - `payment_status` → `'past_due'`
   - User should still have access (grace period)
3. **Subscription cancelled** (`customer.subscription.deleted`):
   - `payment_status` → `'cancelled'`
   - `plan_tier` → `'free'`
   - Sync requests rejected (401)
   - Export endpoint still works (`allowCancelled: true`)
   - Grace period for data export already implemented (`src/app/api/pro/export/route.ts`)

### Task 5.3: Security Review

#### Authentication checks:
- [ ] All `/api/pro/sync/*` routes call `validateSyncRequest()` first
- [ ] All `/api/pro/store/*` routes call `validateSyncRequest()` first
- [ ] All `/api/pro/fetch/*` routes call `validateSyncRequest()` first
- [ ] Webhook route verifies Stripe signature (via `stripe.webhooks.constructEvent`)
- [ ] Token generation uses `crypto.randomBytes(32).toString('hex')`
- [ ] Setup tokens expire (30 days from creation)

#### Data isolation checks:
- [ ] RLS policies active on all Pro data tables (Phase 1)
- [ ] All Supabase queries include `user_id` filter
- [ ] Pinecone queries always scoped to user's namespace
- [ ] No endpoint returns data for a different user
- [ ] Export endpoint only returns requesting user's data

#### Credential exposure checks:
- [ ] `SUPABASE_SERVICE_ROLE_KEY` never exposed to client (only in server-side code)
- [ ] `PINECONE_API_KEY` never exposed to client
- [ ] `STRIPE_SECRET_KEY` never exposed to client
- [ ] `.env.example` doesn't contain real values (check `docs/HANDOFF_GUIDE.md` — **it currently contains real keys** that should be rotated)
- [ ] Setup tokens transmitted over HTTPS only

### Task 5.4: Documentation Cleanup

**Files with outdated information**:

| File | Issue | Fix |
|------|-------|-----|
| `docs/pro-implementation-plan.md` | References Turso throughout | Update to reference Supabase PostgreSQL |
| `docs/PRO-PROGRESS.md` | References Turso, better-auth, PR #792 | Update with current architecture |
| `docs/pro-architecture-proposal.md` | Original proposal — still accurate for Pinecone decision | Add note that Turso was replaced |
| `docs/HANDOFF_GUIDE.md` | Contains real API keys and secrets | Rotate all exposed keys, replace with placeholders |
| `docs/E2E_TESTING_GUIDE.md` | References "better-auth", 1024 dimensions | Update auth references, verify dimension |
| `.env.example` | References `BETTER_AUTH_*` variables | Remove better-auth vars, ensure Supabase vars present |
| `scripts/init-db.ts` | Creates better-auth tables | Remove or update for Supabase Auth |
| `scripts/test-auth.ts` | Tests better-auth | Remove or update |
| `package.json` | `@libsql/client` still listed (unused Turso dependency) | Remove |

**CRITICAL**: `docs/HANDOFF_GUIDE.md` contains real Supabase service role keys, Stripe secret keys, and Pinecone API keys. These **must be rotated immediately** regardless of whether the document is updated.

### Task 5.5: Production Deployment

**Current deployment target**: Cloudflare via OpenNext adapter

**Deploy commands** (from `package.json`):
```bash
npm run deploy  # opennextjs-cloudflare build && opennextjs-cloudflare deploy
```

**Environment variables needed in Cloudflare**:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_DATABASE_URL`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_PRO_PRICE_ID`
- `PINECONE_API_KEY`
- `PINECONE_INDEX`
- `PINECONE_EMBEDDING_MODEL`
- `NEXT_PUBLIC_APP_URL`

**Pre-deploy checklist**:
- [ ] All environment variables set in Cloudflare dashboard
- [ ] Supabase migrations applied (0001, 0002, 0003, 0004) — including REPLICA IDENTITY FULL for Realtime
- [ ] Supabase Realtime enabled for `pro_observations`, `pro_summaries`, `pro_prompts` tables (check Supabase Dashboard → Database → Replication)
- [ ] Stripe webhook endpoint updated to production URL
- [ ] Stripe product and price created in live mode
- [ ] Pinecone index exists with correct dimensions
- [ ] CORS configured for production domain
- [ ] Exposed credentials in HANDOFF_GUIDE.md rotated

### Verification Checklist — Phase 5
- [ ] Complete E2E flow works: signup → upgrade → setup → sync → **stream** → search → export
- [ ] Real-time SSE streaming works for Pro users (both worker passthrough and Supabase Realtime paths)
- [ ] Subscription cancellation properly restricts access but allows export
- [ ] No security vulnerabilities in auth, data isolation, or credential exposure
- [ ] All documentation updated to reflect current architecture
- [ ] Exposed credentials rotated
- [ ] Production deployment successful
- [ ] Smoke test on production: can sign in, can see dashboard, can upgrade

### Anti-Pattern Guards — Phase 5
- **DO NOT** deploy without rotating the credentials exposed in `docs/HANDOFF_GUIDE.md`
- **DO NOT** skip the RLS verification — test that a user cannot access another user's data
- **DO NOT** leave Turso references in documentation — it confuses future contributors
- **DO NOT** remove the `@libsql/client` dependency if any import still references it (grep first)

---

## Appendix A: Complete API Reference

### Authentication Patterns

**Pattern 1: Supabase Auth (Session-Based)**
Used by: `/api/observations`, `/api/summaries`, `/api/prompts`, `/api/stats`, `/api/stream`, `/api/settings`
```typescript
import { createClient } from '@/lib/supabase/server';
const supabase = await createClient();
const { data: { user } } = await supabase.auth.getUser();
if (user?.id) { /* Pro user */ } else { /* Fall back to local worker */ }
```

**Pattern 2: Setup Token (Bearer)**
Used by: All `/api/pro/sync/*`, `/api/pro/store/*`, `/api/pro/fetch/*`, `/api/pro/export`
```typescript
import { validateSyncRequest } from '@/lib/pro/auth';
const authResult = await validateSyncRequest(request);
if (!authResult.valid) return NextResponse.json({ error: authResult.error }, { status: 401 });
const { userId, pineconeNamespace } = authResult;
```

**Pattern 3: Supabase Auth (User-Required)**
Used by: `/api/pro/checkout`, `/api/pro/status`, `/api/pro/regenerate-token`, `/api/pro/provision`
```typescript
import { getUser } from '@/lib/auth-server';
const user = await getUser();
if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
```

**Pattern 4: Stripe Webhook Signature**
Used by: `/api/webhooks/stripe`
```typescript
const event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
```

### Complete Route Map

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/observations` | Session | List observations (Pro→Supabase, Free→local) |
| GET | `/api/summaries` | Session | List summaries |
| GET | `/api/prompts` | Session | List prompts |
| GET | `/api/stats` | Session | Get counts and project list |
| GET | `/api/stream` | Session | SSE stream: worker passthrough (primary) or Supabase Realtime relay (fallback for Pro without worker) |
| GET/POST | `/api/settings` | Session | Read/write settings |
| POST | `/api/webhooks/stripe` | Stripe sig | Handle payment events |
| POST | `/api/pro/checkout` | User auth | Create Stripe checkout session |
| POST | `/api/pro/provision` | User auth | Fallback provisioning |
| POST | `/api/pro/regenerate-token` | User auth | New setup token |
| GET | `/api/pro/status` | User auth | Pro subscription status |
| POST | `/api/pro/initialize` | Token | Validate token, return credentials |
| POST | `/api/pro/validate-setup` | Token | Validate token, return full config |
| POST | `/api/pro/validate-token` | Token | Simple token validation |
| POST | `/api/pro/complete-setup` | Token | Record migration stats |
| POST | `/api/pro/store/batch` | Token | Store observations + summary (cloud-primary) |
| POST | `/api/pro/store/observation` | Token | Store single observation |
| POST | `/api/pro/store/summary` | Token | Store single summary |
| POST | `/api/pro/store/prompt` | Token | Store single prompt |
| POST | `/api/pro/embed` | Token | Generate embeddings server-side |
| POST | `/api/pro/sync/query` | Token | Semantic search via Pinecone |
| POST | `/api/pro/sync/observation` | Token | Sync single observation (local→cloud) |
| POST | `/api/pro/sync/observations/batch` | Token | Batch sync observations |
| POST | `/api/pro/sync/summary` | Token | Sync single summary |
| POST | `/api/pro/sync/summaries/batch` | Token | Batch sync summaries |
| POST | `/api/pro/sync/prompt` | Token | Sync single prompt |
| POST | `/api/pro/sync/prompts/batch` | Token | Batch sync prompts |
| GET | `/api/pro/sync/status` | Token | Get synced local IDs per project |
| GET | `/api/pro/sync/stats` | Token | Get sync statistics |
| POST | `/api/pro/fetch/observations` | Token | Fetch observations by IDs |
| POST | `/api/pro/fetch/summaries` | Token | Fetch summaries by IDs |
| POST | `/api/pro/fetch/prompts` | Token | Fetch prompts by IDs |
| GET | `/api/pro/export` | Token (allows cancelled) | Export all user data |

---

## Appendix B: Database Schema (Current)

### pro_users
```sql
CREATE TABLE pro_users (
  user_id TEXT PRIMARY KEY,                          -- Supabase Auth user.id
  stripe_customer_id TEXT,                           -- Stripe customer reference
  stripe_subscription_id TEXT,                       -- Stripe subscription reference
  payment_status TEXT DEFAULT 'none',                -- none|pending|active|cancelled|past_due
  plan_tier TEXT DEFAULT 'free',                     -- free|pro
  setup_token TEXT,                                  -- cm_pro_<32hex> format
  setup_token_created_at TIMESTAMP WITH TIME ZONE,
  setup_completed_at TIMESTAMP WITH TIME ZONE,
  pinecone_namespace TEXT,                           -- user_<8chars> format
  observations_migrated INTEGER DEFAULT 0,
  summaries_migrated INTEGER DEFAULT 0,
  prompts_migrated INTEGER DEFAULT 0,
  vectors_migrated INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- Indexes: stripe_customer_id, setup_token (unique)
```

### pro_observations
```sql
CREATE TABLE pro_observations (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  local_id INTEGER,                                  -- Added in migration 0003
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  type TEXT,
  title TEXT,
  subtitle TEXT,
  facts TEXT,                                        -- JSON array string
  narrative TEXT,
  concepts TEXT,                                     -- JSON array string
  files_read TEXT,                                   -- JSON array string
  files_modified TEXT,                               -- JSON array string
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT DEFAULT NOW(),                     -- Made nullable in migration 0003
  created_at_epoch BIGINT NOT NULL
);
-- Indexes: user_id, (user_id, project), (user_id, created_at_epoch DESC),
--          (user_id, memory_session_id), (user_id, local_id) UNIQUE
```

### pro_summaries
```sql
CREATE TABLE pro_summaries (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  local_id INTEGER,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  notes TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT DEFAULT NOW(),
  created_at_epoch BIGINT NOT NULL
);
-- Indexes: user_id, (user_id, project), (user_id, memory_session_id),
--          (user_id, local_id) UNIQUE
```

### pro_prompts
```sql
CREATE TABLE pro_prompts (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  local_id INTEGER,
  content_session_id TEXT NOT NULL,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  prompt_number INTEGER,
  prompt_text TEXT NOT NULL,
  created_at TEXT DEFAULT NOW(),
  created_at_epoch BIGINT NOT NULL
);
-- Indexes: user_id, (user_id, memory_session_id), (user_id, local_id) UNIQUE
```

### pro_usage
```sql
CREATE TABLE pro_usage (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES pro_users(user_id),
  observations_created INTEGER DEFAULT 0,
  summaries_created INTEGER DEFAULT 0,
  prompts_stored INTEGER DEFAULT 0,
  vector_queries INTEGER DEFAULT 0,
  sqlite_queries INTEGER DEFAULT 0,
  period_start TIMESTAMP WITH TIME ZONE NOT NULL,
  period_end TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
-- Indexes: user_id, (period_start, period_end)
```

---

## Appendix C: Key File Paths

### Core Library
| File | Purpose |
|------|---------|
| `src/lib/pro/auth.ts` | `validateSyncRequest()`, `getUserIdFromRequest()` |
| `src/lib/pro/supabase.ts` | `getAdminClient()`, CRUD for observations/summaries/prompts |
| `src/lib/pro/pinecone.ts` | `embedAndUpsert()`, `queryVectors()`, `getNamespaceStats()` |
| `src/lib/auth-server.ts` | `getSession()`, `getUser()` |
| `src/lib/auth-client.ts` | `signInWithOAuth()`, `signOut()`, `useSession()` |
| `src/lib/supabase/server.ts` | `createClient()` — server-side Supabase with cookies |
| `src/lib/supabase/client.ts` | `createClient()` — browser-side Supabase |
| `src/lib/supabase/middleware.ts` | `updateSession()` — route protection |

### Database
| File | Purpose |
|------|---------|
| `src/db/schema.ts` | Drizzle ORM schema (proUsers, proUsage tables) |
| `src/db/index.ts` | Database connection pool |
| `drizzle.config.ts` | Drizzle configuration |
| `drizzle/0001_add_pro_users.sql` | pro_users + pro_usage tables |
| `drizzle/0002_add_pro_data_tables.sql` | pro_observations + pro_summaries + pro_prompts |
| `drizzle/0003_add_local_id_columns.sql` | local_id sync tracking |

### Hooks
| File | Purpose |
|------|---------|
| `src/hooks/useSSE.ts` | SSE connection for real-time data |
| `src/hooks/usePro.ts` | Pro subscription state management |
| `src/hooks/usePagination.ts` | Paginated data fetching |
| `src/hooks/useStats.ts` | Statistics polling |
| `src/hooks/useSettings.ts` | Settings read/write |
| `src/hooks/useTheme.ts` | Theme management |

### Types
| File | Purpose |
|------|---------|
| `src/types/index.ts` | Observation, Summary, UserPrompt, FeedItem, StreamEvent |
| `src/types/pro.ts` | ProStatus, CheckoutResponse |

### Configuration
| File | Purpose |
|------|---------|
| `next.config.ts` | Next.js config (React Compiler enabled) |
| `tsconfig.json` | TypeScript config (path alias `@/*` → `./src/*`) |
| `middleware.ts` | Route protection (redirects unauthenticated from `/dashboard`) |
| `package.json` | Scripts: dev (PM2), build, deploy (Cloudflare) |

---

**Total estimate**: 7-10 days across all phases
**Critical path**: Phase 1 (security) → Phase 4 (UI + streaming — largest phase) → Phase 5 (ship)
**Parallel work**: Phase 2 (worker sync via PR #854) and Phase 3 (vector verification) can run alongside Phase 1. Phase 4 depends on Phase 1 (for Supabase Realtime REPLICA IDENTITY).
**Execution order within Phase 4**: Merge PR #1 first → Fix SSE architecture → Integrate claude-mem-ui-5-0 → Merge bigph00t PR #854 in claude-mem → Integration testing
