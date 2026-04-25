# Flowchart: knowledge-corpus-builder

## Sources Consulted
- `src/services/worker/knowledge/CorpusBuilder.ts:1-174`
- `src/services/worker/knowledge/KnowledgeAgent.ts:1-284`
- `src/services/worker/knowledge/CorpusRenderer.ts:1-133`
- `src/services/worker/knowledge/CorpusStore.ts:1-127`
- `src/services/worker/http/routes/CorpusRoutes.ts:1-284`
- `src/services/worker/search/SearchOrchestrator.ts:1-80`
- `src/services/worker/search/ResultFormatter.ts:1-100`
- `src/services/context/formatters/AgentFormatter.ts:1-100`

## Happy Path Description

`POST /api/corpus` → `handleBuildCorpus` → `CorpusBuilder.build()` maps filters to `SearchOrchestrator.search()` → extract IDs → `SessionStore.getObservationsByIds()` hydrates full records → map to `CorpusObservation` → compute stats (type breakdown, date range) → `CorpusRenderer.generateSystemPrompt()` → `CorpusRenderer.renderCorpus()` produces full-detail markdown → persist to `~/.claude-mem/corpora/{name}.corpus.json` via `CorpusStore.write`.

`POST /api/corpus/:name/prime` → `KnowledgeAgent.prime()` → render full corpus text + system prompt → pass to Claude Agent SDK `query()` → capture `session_id` → persist in corpus.json.

`POST /api/corpus/:name/query` → `KnowledgeAgent.query()` resumes SDK session by id, agent answers from corpus context, auto-reprimes on expiration.

## Mermaid Flowchart

```mermaid
flowchart TD
    A["POST /api/corpus<br/>CorpusRoutes.ts:43"] --> B["handleBuildCorpus"]
    B --> C["CorpusBuilder.build<br/>CorpusBuilder.ts:50"]
    C --> D["SearchOrchestrator.search<br/>CorpusBuilder.ts:64"]
    D --> E["SessionStore.getObservationsByIds<br/>CorpusBuilder.ts:82"]
    E --> F["mapObservationToCorpus<br/>CorpusBuilder.ts:126"]
    F --> G["calculateStats<br/>CorpusBuilder.ts:146"]
    G --> H["CorpusRenderer.generateSystemPrompt<br/>CorpusBuilder.ts:109"]
    H --> I["CorpusRenderer.renderCorpus (estimate tokens)<br/>CorpusBuilder.ts:112"]
    I --> J["CorpusStore.write<br/>CorpusBuilder.ts:116"]
    J --> K[(~/.claude-mem/corpora/{name}.corpus.json<br/>CorpusStore.ts:14)]

    L1["GET /api/corpus/:name"] --> L3["CorpusStore.read<br/>CorpusStore.ts:39"]
    L3 --> K

    M["POST /api/corpus/:name/prime<br/>CorpusRoutes.ts:213"] --> N["KnowledgeAgent.prime<br/>KnowledgeAgent.ts:58"]
    N --> P["CorpusRenderer.renderCorpus<br/>CorpusRenderer.ts:14"]
    P --> Q["Claude Agent SDK query<br/>KnowledgeAgent.ts:75"]
    Q --> R["session_id captured<br/>KnowledgeAgent.ts:89"]
    R --> S["CorpusStore.write update session_id<br/>KnowledgeAgent.ts:114"]

    T["POST /api/corpus/:name/query<br/>CorpusRoutes.ts:235"] --> V["KnowledgeAgent.query<br/>KnowledgeAgent.ts:125"]
    V --> W["Agent SDK resume session_id<br/>KnowledgeAgent.ts:190-200"]
    W --> X{Session expired?}
    X -->|Yes| Y["auto-reprime<br/>KnowledgeAgent.ts:148"]
    X -->|No| Z["Return answer"]

    AA["POST /api/corpus/:name/rebuild"] --> C
    AB["POST /api/corpus/:name/reprime"] --> N
    AC["DELETE /api/corpus/:name"] --> AD["CorpusStore.delete<br/>CorpusStore.ts:94"]
```

## Side Effects

- Writes `{name}.corpus.json` in `~/.claude-mem/corpora/`.
- Spawns Claude Agent SDK subprocess for prime/query.
- Creates `OBSERVER_SESSIONS_DIR` if absent.
- Environment isolation via `buildIsolatedEnv`.

## External Feature Dependencies

**Calls into:** SearchOrchestrator (strategy routing), SessionStore (hydration), Anthropic Claude Agent SDK, SettingsDefaultsManager, ChromaSync (indirect through hybrid).

**Called by:** CorpusRoutes HTTP endpoints; knowledge-agent skill (external).

## Potential Duplication Noted

**CorpusRenderer vs ResultFormatter vs AgentFormatter** — all three produce markdown from observations:

| Renderer | Audience | Density | Grouping |
|---|---|---|---|
| ResultFormatter | CLI search results | Compact table rows | Date/file |
| AgentFormatter | Session context injection | Compact per-line | Day timeline |
| CorpusRenderer | Agent priming corpus | FULL DETAIL narrative-first | List or chronological |

**No direct code reuse** but all three independently iterate observations and format markdown. Consolidating on a shared rendering interface (base class or strategy) could reduce surface area if output configurations overlap.

**Search logic NOT duplicated** — CorpusBuilder correctly delegates to SearchOrchestrator.

## Confidence + Gaps

**High:** Build → prime → query flow; 8 HTTP endpoints; session reprime on expiration.

**Gaps:** Exact "session expired" detection (regex match at KnowledgeAgent.ts:179); token heuristic (chars/4 at CorpusRenderer.ts:91); no quota enforcement for corpus count/size.
