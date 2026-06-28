# Viewer Screenshot References

**Status:** inbox
**Created:** 2026-05-21
**Goal:** Surface screenshot images (PNG/JPG/GIF/WebP) referenced by tool calls as inline thumbnails in the observation feed at the worker viewer (`http://127.0.0.1:<worker-port>`), with a click-to-zoom lightbox. Worker serves the image bytes from disk through a path-safe endpoint.

---

## Problem

When a session uses screenshot tools (gstack/browse `screenshot`, MCP screenshot tools) or reads/writes image files, those paths flow through `pending_messages.tool_input` but are **dropped** before reaching the `observations` table. The viewer feed only sees text summaries — never the actual images that were captured. We want screenshots inline in the feed.

## Constraints

- **Local-only:** worker binds to `127.0.0.1`, so an image endpoint that reads arbitrary local paths is reachable only by the user — but path-traversal must still be guarded (defense in depth, and to avoid leaking unrelated files via a malicious request from a browser tab).
- **Open-source core:** no Pro-only gating. Endpoint and viewer component ship in the core.
- **No new dependencies:** reuse Express, esbuild, existing modal/CSS patterns.
- **Backwards-compatible storage:** new column on `observations` must be nullable, no migration of historical rows required.

---

## Phase 0: Documentation Discovery (consolidated)

### Storage layer
- **Schema:** `src/services/sqlite/schema.sql:57-92` — `observations` table. Columns include `files_read`, `files_modified` (both `TEXT`, JSON-stringified arrays), `metadata` (`TEXT`, JSON), `facts`, `narrative`, `concepts`. `UNIQUE(memory_session_id, content_hash)` with `ON CONFLICT DO NOTHING`.
- **Queue:** `src/services/sqlite/schema.sql:126-152` — `pending_messages` table holds raw `tool_input` / `tool_response` JSON during processing. **Discarded after the AI summarization step.**
- **Insert path:** `src/services/sqlite/observations/store.ts:19-80` — `storeObservation()` writes 17 columns from `ObservationInput`. Raw tool I/O is **not** persisted here today.
- **Read row type:** `ObservationRow` in `src/services/sqlite/types.ts` — what every observation API returns.

### Worker HTTP
- **App setup:** `src/services/server/Server.ts:98-105` — `setupCors()`, body-parser, route registration. CORS already on.
- **Observations endpoint:** `GET /api/observations` registered in `DataRoutes.ts` via `handleGetObservations` → `paginationHelper.getObservations(...)`.
- **Search:** `GET /api/search/observations` in `src/services/worker/http/routes/SearchRoutes.ts:109`.
- **Static assets:** `src/services/worker/http/routes/ViewerRoutes.ts:49` — `app.use(express.static(path.join(packageRoot, 'ui')))`. Serves built viewer assets only; no tool-artifact endpoint.
- **Port resolution:** `src/shared/worker-utils.ts:64-73` — `getWorkerPort()` reads `CLAUDE_MEM_WORKER_PORT` from settings.json; default `37700 + (uid % 100)`. User's local port happens to be `37777`.

### Viewer (React, esbuild)
- **Entry:** `src/ui/viewer/index.tsx` → `App.tsx`.
- **Feed component:** `src/ui/viewer/components/Feed.tsx` — merges `observations`, `summaries`, `prompts`, sorts by `created_at_epoch`, renders `<ObservationCard>` / `<SummaryCard>` / `<PromptCard>`.
- **API constants:** `src/ui/viewer/constants/api.ts` — central list of endpoint paths.
- **Realtime updates:** SSE `/stream` (plus paginated GET via `usePagination`).
- **Build:** `scripts/build-viewer.js` (esbuild) bundles to `plugin/ui/viewer-bundle.js`; `viewer-template.html` → `plugin/ui/viewer.html`. Invoked from `scripts/build-hooks.js`.
- **Reusable modal pattern:** `ContextSettingsModal.tsx` (backdrop + centered panel + close). No existing lightbox lib — build a small overlay component.

### Allowed APIs (verified)
- `express.static(dir)` — already imported.
- `res.sendFile(absPath, { headers, dotfiles: 'deny' })` — Express built-in, streams the file.
- `fs.promises.stat`, `fs.promises.open` (for magic-byte sniff), `path.resolve`, `path.extname`.
- React `useState` / `useEffect` / portals (already used elsewhere).

### Anti-patterns (do NOT do)
- Do **not** read raw `tool_input` JSON from the live `pending_messages` queue inside an HTTP handler. That table is a transient processing buffer.
- Do **not** decode base64 image blobs into the database. Reference by absolute filesystem path only.
- Do **not** wire CORS to allow `*` for the image endpoint — keep it scoped like the rest of the worker (same-origin for the viewer).
- Do **not** invent a `tool_use` table read path — observations are the surface area for the feed.

---

## Phase 1: Detect & persist image references on observation write

**Goal:** When an observation is created, record any image file paths that were touched by the underlying tool calls so the viewer can render them.

**What to implement:**

1. New nullable column on `observations`:
   - Column: `image_refs TEXT` (JSON-stringified array of absolute paths). Mirrors the pattern of `files_read` / `files_modified` already present at `src/services/sqlite/schema.sql:57-92`.
   - Add a migration entry alongside existing schema migrations (find the migration runner near `src/services/sqlite/schema.sql`; copy the additive pattern used for any prior column add — `ALTER TABLE observations ADD COLUMN image_refs TEXT`).
   - **Anti-pattern guard:** do not drop/recreate the table; additive ALTER only.

2. Extend `ObservationInput` in `src/services/sqlite/observations/store.ts` with `image_refs?: string[]` and include it in the INSERT statement (lines 35-41). Stringify on the way in.

3. Add `image_refs: string[] | null` to `ObservationRow` in `src/services/sqlite/types.ts` so it flows out of every read API.

4. Populate `image_refs` at observation generation time. Two sources, applied in order:
   - **Source A (primary):** while the AI summarization step is still holding raw `pending_messages.tool_input` / `tool_response`, scan for absolute file paths whose extension is in `IMAGE_EXTENSIONS = ['.png','.jpg','.jpeg','.gif','.webp']`. Find the file that builds `ObservationInput` from pending messages (search for the call site of `storeObservation` — likely `src/services/observations/` or `src/services/queue/`) and inject the extraction there.
   - **Source B (fallback):** post-filter the already-extracted `files_read` ∪ `files_modified` for image extensions. This catches images that survived only in the summary.
   - Dedupe + sort the final list before persisting.

5. Add a tiny pure helper `extractImagePaths(toolInput: unknown, toolResponse: unknown): string[]` in `src/utils/image-refs.ts`. Unit-testable, no I/O, no DB access. Handles:
   - `Read` tool: `tool_input.file_path`.
   - `Write` / `Edit`: `tool_input.file_path`.
   - Generic `image_path`, `screenshot_path`, `output_path` keys.
   - Arrays / nested objects (recurse one level).
   - String tool_response containing `file://...png` or absolute paths.
   - Returns only absolute paths (`path.isAbsolute`) with image extensions.

**Documentation references:**
- Copy the column-add pattern from any prior `ALTER TABLE observations ADD COLUMN ...` in `src/services/sqlite/schema.sql`.
- Mirror the `files_read` / `files_modified` lifecycle: written by the same function that builds `ObservationInput`, parsed by the viewer as `JSON.parse(row.files_read ?? '[]')`.

**Verification checklist:**
- [ ] `sqlite3 ~/.claude-mem/claude-mem.db ".schema observations"` shows `image_refs TEXT`.
- [ ] Unit test for `extractImagePaths` covering each tool shape (Read, Write, screenshot, nested arrays, non-image extensions excluded, relative paths excluded).
- [ ] Trigger a session that calls a screenshot tool; confirm `image_refs` is populated on the resulting row via `sqlite3` query.
- [ ] Existing rows still load — `image_refs` returns as `null` and is tolerated by readers.

---

## Phase 2: Safe image-serving endpoint on the worker

**Goal:** Add `GET /api/images?path=<absolute-encoded-path>` that streams an image file from disk if-and-only-if it passes path-safety checks.

**What to implement:**

1. New route module: `src/services/worker/http/routes/ImageRoutes.ts`. Copy the handler-wrap pattern from `DataRoutes.ts` (`this.wrapHandler((req, res) => { ... })`).

2. Register the route in the same place existing `DataRoutes` / `SearchRoutes` are registered (find the `setupCoreRoutes`/`setupRoutes` call chain off `Server.ts:98-105`). Register **before** `express.static` in `ViewerRoutes.ts:49` so it takes precedence on `/api/*`.

3. Handler contract:
   - Input: `req.query.path` (URL-encoded absolute path).
   - Reject (`400`) if missing, not a string, or `path.isAbsolute(decoded) === false`.
   - `path.resolve(decoded)` — if the resolved string differs from the decoded input, reject (catches `..` traversal).
   - Reject (`415`) if `path.extname(resolved).toLowerCase()` not in `['.png','.jpg','.jpeg','.gif','.webp']`.
   - Allowlist root: must live under **one of** `process.env.HOME`, the `CLAUDE_MEM_DATA_DIR`, the OS temp dir, **or** any absolute path currently present in *any* observation's `image_refs` column. The DB-membership check is the strongest guard — only paths the system has already chosen to surface can be fetched.
     - Implementation: `SELECT 1 FROM observations WHERE image_refs LIKE '%' || ? || '%' LIMIT 1` against the resolved path (parameterized; the `LIKE` is safe because the path is already absolute and we further `JSON.parse` and `.includes()` to confirm exact match).
   - Magic-byte sniff: open the file, read first 12 bytes, confirm PNG / JPEG / GIF / WebP signature. Reject (`415`) on mismatch.
   - Set `Content-Type` from extension. Set `Cache-Control: private, max-age=60`. Stream with `res.sendFile(resolved, { dotfiles: 'deny' })`.
   - On any error: `404` with no body (don't leak existence).

4. Add `IMAGES: '/api/images'` to `src/ui/viewer/constants/api.ts`.

**Documentation references:**
- `DataRoutes.ts` for the `wrapHandler` + `req.query` parsing convention.
- `ViewerRoutes.ts:49` for static-mount ordering reference.

**Verification checklist:**
- [ ] `curl 'http://127.0.0.1:<port>/api/images?path=<encoded>'` returns 200 + correct `Content-Type` for a known image referenced in an observation.
- [ ] `curl '.../api/images?path=../../etc/passwd'` → 400.
- [ ] `curl '.../api/images?path=/etc/passwd'` → 404 (absolute, but not in DB and wrong magic bytes).
- [ ] Renaming an extension `.png` → `.txt` after the path lands in DB still rejects on magic bytes.
- [ ] Unit test the path-safety predicate in isolation.

**Anti-pattern guards:**
- Do not accept `path` as a request body — query string only, keeps it GET-cacheable.
- Do not bypass the DB-membership check, even for "obviously safe" paths.
- Do not `fs.readFile` the whole image into memory — `res.sendFile` streams.

---

## Phase 3: Viewer types + data plumbing

**Goal:** Get `image_refs` from the API into the React `Observation` shape and parsed into `string[]`.

**What to implement:**

1. Find the viewer-side `Observation` TypeScript type (likely `src/ui/viewer/types.ts` — confirm via grep `interface Observation`). Add `image_refs: string[]` (parsed) plus update the raw `ObservationRowFromApi` (or equivalent) with `image_refs: string | null` for the JSON-string form.
2. Find the place where API rows are normalized for the feed (search for `JSON.parse(row.files_read` or similar). Add a sibling `image_refs: row.image_refs ? JSON.parse(row.image_refs) : []` line.
3. SSE consumer: confirm the `/stream` payload reflects the new column (same row shape — no separate change needed if it reuses the same serializer).

**Verification checklist:**
- [ ] React DevTools / a temporary `console.log` shows `image_refs: [...]` on observation objects that have images.
- [ ] `tsc --noEmit` passes (no type drift).

---

## Phase 4: Render thumbnails + lightbox in `ObservationCard`

**Goal:** Show a horizontal strip of small thumbnails inside each observation card; clicking opens a lightbox overlay.

**What to implement:**

1. New component `src/ui/viewer/components/ImageStrip.tsx`:
   - Props: `paths: string[]`, `onOpen: (path: string) => void`.
   - Renders nothing if `paths.length === 0`.
   - Each thumbnail: `<img src={`/api/images?path=${encodeURIComponent(p)}`} loading="lazy" />`, sized ~80px height, rounded corners, `cursor: pointer`.
   - On `<img onError>`, swap to a placeholder div (`title="missing image"`) — handles deleted files gracefully.

2. New component `src/ui/viewer/components/Lightbox.tsx`:
   - Copy the backdrop/portal pattern from `ContextSettingsModal.tsx`.
   - Props: `path: string | null`, `onClose: () => void`.
   - Renders nothing when `path === null`.
   - Centered `<img>` with `max-width: 90vw; max-height: 90vh`.
   - Close on backdrop click, on `Escape` key, and on close button.
   - **Do not** add zoom/pan in this phase — keep it simple. Future enhancement.

3. Wire into `ObservationCard.tsx`:
   - Add `const [lightboxPath, setLightboxPath] = useState<string | null>(null);`.
   - Render `<ImageStrip paths={observation.image_refs} onOpen={setLightboxPath} />` after the existing card body content.
   - Render `<Lightbox path={lightboxPath} onClose={() => setLightboxPath(null)} />`.

4. Add minimal CSS in the viewer's existing stylesheet (find it via grep `.observation-card`):
   ```css
   .image-strip { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
   .image-strip img { height: 80px; width: auto; border-radius: 6px; object-fit: cover; cursor: zoom-in; }
   .lightbox-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.85); display: flex; align-items: center; justify-content: center; z-index: 1000; }
   .lightbox-backdrop img { max-width: 90vw; max-height: 90vh; }
   ```

5. Rebuild: `npm run build-and-sync` regenerates `plugin/ui/viewer-bundle.js` and `plugin/ui/viewer.html`.

**Documentation references:**
- `src/ui/viewer/components/ContextSettingsModal.tsx` for backdrop + close pattern.
- `src/ui/viewer/components/Feed.tsx` for how `ObservationCard` is invoked.

**Verification checklist:**
- [ ] Open `http://127.0.0.1:<port>/`. Observations with `image_refs` show a thumbnail strip.
- [ ] Clicking a thumbnail opens the lightbox; Escape and backdrop click both close it.
- [ ] Observations without images render unchanged (no empty container, no layout shift).
- [ ] Deleted-on-disk image shows the placeholder, doesn't crash.

**Anti-pattern guards:**
- Do not fetch image bytes via JS and convert to blob URLs — let the `<img src>` do it.
- Do not block the feed render on image load — `loading="lazy"`.
- Do not store image data in component state.

---

## Phase 5: End-to-end verification

1. **Fresh session with screenshot tool**
   - Start a clean session, trigger a tool that produces a PNG (e.g., `gstack` screenshot).
   - Wait for observation to be generated.
   - Hit `GET /api/observations?limit=1` — confirm `image_refs` is a JSON array containing the screenshot's absolute path.
2. **Endpoint security**
   - Run the four `curl` cases listed in Phase 2.
3. **Viewer**
   - Confirm thumbnails appear, lightbox works, missing files fall back to placeholder.
4. **Regression sweep**
   - Run any existing viewer tests (search for `viewer` in test directories — Vitest or Playwright).
   - Confirm older observations (no `image_refs`) still render and pass type checks.
5. **Build & sync**
   - `npm run build-and-sync` succeeds without warnings.
   - Worker restarts cleanly with the new route registered (check startup log for `/api/images`).

---

## Out of scope (future inbox items)

- Video / GIF playback controls beyond `<img>` autoplay-on-GIF.
- Zoom-and-pan in the lightbox.
- Side-by-side image diffs.
- Thumbnail caching layer (the worker re-streams each request; cheap enough at single-user scale).
- Pro Memory Stream UI integration — that UI hits the same `/api/images` endpoint, no extra core work.
- Backfilling `image_refs` on historical observations.
