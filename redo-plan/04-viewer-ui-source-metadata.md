# 04 — Viewer UI: Observation Source Metadata

**Branch commits:** `c2a39635` (feat), `077051e5` + `ea5c0e56` (SSE/pagination wiring fixes)
**Scope of this doc:** UI rendering only. Data-layer (`metadata` column, extraction, indexes, search filters) is `03-observation-source-metadata.md`.

---

## 1. What the feature is

Two display additions on every observation card in the React viewer at `http://localhost:37777`, both sourced from a single `metadata` JSON column on the observation:

- A small **`tool_name` pill** (e.g. `WebFetch`, `Bash`, `Read`) sitting in the card-meta footer next to `#id • date`.
- A **truncated, clickable `source_url` link** (e.g. `docs.anthropic.com/...`) when the originating tool produced one.

The branch additionally bundled three orthogonal UI changes into the same commit:
- TITANS emoji prefixes on the type badge (`💡 insight`, `🤝 commitment`, `⚠️ overconfidence`, etc.) — see `TITANS_EMOJI` map at `src/ui/viewer/components/ObservationCard.tsx:13`.
- Removal of the `platform_source` badge (`card-source`) from each card.
- Removal of the source-selector dropdowns in `Header.tsx` and `ContextSettingsModal.tsx`.

Server-side the feature also required threading `metadata` through `ObservationSSEPayload` (broadcast in `ResponseProcessor`) and the `o.metadata` SELECT in `PaginationHelper` so the value actually reaches the browser.

## 2. What we want it to do

- When an observation is rendered, parse `observation.metadata` (TEXT, JSON-encoded). If parse fails, render the card as if no metadata existed (silent fall-through).
- Show `tool_name` as a 10–11 px pill (`.meta-tool-name`) inline in the card-meta row.
- Show `source_url` only when it begins with `http://` or `https://` (protocol allowlist; came from CodeRabbit round 4 fix in `077051e5`). Display the URL truncated via `truncateUrl(url, 40)` — strips protocol, shows `host + path`, ellipses past the limit. Open in new tab with `rel="noopener noreferrer"`. Full URL goes in `title=` for hover.
- New observations arriving via SSE must already carry `metadata` — `useSSE.ts` doesn't need its own awareness; it just propagates `Observation` objects from the stream payload.
- Paginated `/api/observations` responses must also include `metadata` per row (already done in main once the column exists, since `*` SELECTs propagate it; explicit projection if not).

## 3. What we want it to accomplish

**Provenance at a glance.** Today an observation says "user looked up the Mintlify schema" — the card doesn't tell you *which* doc page that came from or which tool ran. Surfacing `tool_name + source_url` in the footer:

- Lets a developer one-click back to the originating webpage / file / command without scrubbing transcripts.
- Distinguishes WebFetch-derived knowledge from Bash command-derived knowledge from edit-derived knowledge — useful when re-evaluating the trustworthiness of an old observation.
- Sets up downstream filtering ("show only WebFetch observations from docs.anthropic.com") that the search layer already supports via the `source_url` and `tool_name` filters added in `c2a39635`.

## 4. Why we think it will work

- Pure additive UI: ~30 LOC inside an existing component, no state, no reducer, no global store.
- The data model already exists in main's downstream columns — the viewer just needs to read what's there.
- Observed in production on the branch (per memory observations 66506 and 66691) — the rendering itself is proven; the breakage was always in the merge story.
- Failure mode is graceful: missing/malformed `metadata` → no pill, no link, no error.

## 5. Simplest implementation if we ignored the existing codebase and edge cases

```tsx
// types.ts
metadata?: string;

// ObservationCard.tsx (inside .card-meta)
{observation.metadata && (() => {
  const m = JSON.parse(observation.metadata);
  return <>
    {m.tool_name && <span className="meta-tool-name">{m.tool_name}</span>}
    {m.source_url && <a href={m.source_url} target="_blank">{m.source_url}</a>}
  </>;
})()}
```

Plus two CSS rules. ~15 LOC total. Done.

## 6. Is the simple way better or worse than what we designed?

**Materially better.**

The branch's commit conflated four orthogonal design choices: (a) pill+URL display, (b) TITANS emoji prefixes, (c) deleting the platform_source badge, (d) removing source selectors. Conflation is exactly what made the merge unmergeable — main independently formed opinions on (c) (kept the badge as `card-source source-claude` etc.) and shipped a UX redesign in PR #2255 that touched the same lines for unrelated reasons.

The simple way's deficits are real but small:
- No `truncateUrl()` prettiness. **Worth keeping** from the original — meaningful work, ~10 LOC.
- No HTTP/HTTPS protocol allowlist. **Worth keeping** — security-relevant, blocks `javascript:` URIs.
- No typed `Metadata` interface. **Skip for now** — `JSON.parse` returns `any` and that's fine for two optional fields read once.
- Try/catch around `JSON.parse`. **Keep** — branch already does this (`/* missing metadata is normal for old observations */`).

So the redo target is closer to ~30 LOC than 15, but still ~10× cleaner than the branch's commit.

## 7. Suggestions for how to continue

1. **Branch off `origin/main`** as `thedotmack/observation-source-metadata-v2` (do not include the data-layer side — that's doc 03).
2. **Add `metadata?: string`** to `Observation` in `src/ui/viewer/types.ts:1`. Additive — no conflict.
3. **In `ObservationCard.tsx`,** keep main's `card-source` badge as-is. After the `<span className="meta-date">#{id} • {date}</span>` line, add the parsed metadata block: tool_name pill → source_url anchor. Use `truncateUrl(url, 40)` and the http(s) allowlist from `077051e5`.
4. **Drop everything else from `c2a39635` UI-side:**
   - `TITANS_EMOJI` map (belongs in the TITANS observer doc).
   - `card-source` removal (main shipped it deliberately — disagree somewhere else if you must).
   - `Header.tsx` source-selector removal (main already cleaned this).
   - `ContextSettingsModal.tsx` source-selector removal (main converged independently — verify, then no action needed).
5. **Pagination:** confirm `o.metadata` is in the SELECT projection of `src/services/worker/PaginationHelper.ts` (already in main if the column exists; explicit add otherwise — single line).
6. **SSE:** confirm `metadata` is included in the `Observation` payload broadcast by `ResponseProcessor.broadcastObservation()`. Single line if missing.
7. **CSS:** add `.meta-tool-name` and `.meta-source-url` to the viewer stylesheet. Match the `.meta-date` size/weight; URL link uses `var(--color-link)`.
8. **Test:** mock an observation with `metadata: JSON.stringify({tool_name: "WebFetch", source_url: "https://example.com/very/long/path/to/somewhere"})`. Assert pill renders, link href is the full URL, link text uses `truncateUrl(40)`, `javascript:foo` URLs are dropped, malformed JSON renders no error.
9. **Defer:** the TITANS emoji prefixes — wire them in the TITANS PR alongside the new observation types. Keeping the pill/URL PR separate is what makes this redo worth doing.

## 8. Overlap / conflict notes vs `origin/main`

| File | Main shipped | Branch shipped | Redo strategy |
|---|---|---|---|
| `App.tsx` | WelcomeCard import + state, `onShowHelp`, `refreshStats` on observations.length, `setStoredWelcomeDismissed` | (no metadata-related changes) | **Take main entirely.** No metadata work needed here. |
| `Header.tsx` | `onShowHelp?` prop + help button SVG | (unchanged for metadata) | **Take main entirely.** |
| `ObservationCard.tsx` | `card-source source-{platform_source}` badge added + minor refactor | metadata pill + URL link, TITANS emojis, badge removal | **Take main as base, layer pill+link only (~10 LOC).** Skip emoji, keep badge. |
| `usePagination.ts` | switched `fetch` → `authFetch` (post-PR #2081 bearer cleanup) | still raw `fetch` | **Take main entirely.** Auth wrapper required. |
| `useSSE.ts` | simple `projects: string[]` shape | wrapped in `ProjectCatalog { projects }` | **Take main entirely.** Branch's wrapper was scaffolding for a feature that got cut. |
| `ContextSettingsModal.tsx` | source selector already gone | source selector removed | **Take main entirely.** Convergent design. |
| `types.ts` | `ProjectCatalog` has `projects + sources + projectsBySource` (last two appear vestigial in main); no `metadata` on Observation | dropped sources/projectsBySource; added `metadata?` on Observation | **Take main shape, add `metadata?: string` to Observation only.** Vestigial fields → separate cleanup. |
| `useContextPreview.ts` | (unchanged) | (unchanged) | No action. |

**Net new code in the redo PR:** ~30 LOC across `types.ts`, `ObservationCard.tsx`, viewer CSS, plus 1–2 LOC SSE/pagination confirmations server-side. Zero conflicts with v12.5.0.
