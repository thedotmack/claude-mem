# Semantic Memory Layer — Research Handoff (External Evidence Base)

Date: 2026-07-27. Status: research complete, feeds the design in
`plans/2026-07-27-semantic-memory-layer.md`. Companion doc — read that one first.

Produced in the `search` project under its evidentiality protocol: structural
dorking for recall, verbatim-quote extraction from fetched primary sources,
deterministic fact-gate (≥2 independent origin groups + ≥1 primary source +
a disinterested angle) before anything is called a fact. The full claim graph
lives in the `search` repo at `knowledge/agent-memory/semantic-layer.md`
(+ 8 source files in `knowledge/sources/`) and passes
`python -m engine.epistemics_lint`. This file is the self-contained summary —
you do not need the other repo to act on it.

## Corpus (all primary sources, all fetched 2026-07-27)

| Source | URL | Dated | What it is |
| --- | --- | --- | --- |
| CoALA — Sumers et al. | ar5iv.labs.arxiv.org/html/2309.02427 | 2023-09-05 | Taxonomy of cognitive architectures for language agents (survey, neutral) |
| Generative Agents — Park et al. | ar5iv.labs.arxiv.org/html/2304.03442 | 2023-04-10 | Memory stream + reflections (authors' own system) |
| Mem0 — Chhikara et al. | arxiv.org/html/2504.19413v1 | 2025-04-28 | Production memory layer: extract → ADD/UPDATE/DELETE/NOOP (own system) |
| A-MEM — Xu et al. | arxiv.org/html/2502.12110v9 | 2025-06-02 | Zettelkasten-style agentic memory (own system) |
| Zep/Graphiti — Rasmussen et al. | ar5iv.labs.arxiv.org/html/2501.13956 | 2025-01-20 | Temporal knowledge-graph memory (own system) |
| HippoRAG — Gutiérrez et al. | ar5iv.labs.arxiv.org/html/2405.14831 | 2024-05-23 | Hippocampal-index-inspired memory (own system) |
| MemGPT — Packer et al. | ar5iv.labs.arxiv.org/html/2310.08560 | 2023-10-12 | OS-style memory tiers (own system) |
| McKenzie & Eichenbaum, Neuron | pmc.ncbi.nlm.nih.gov/articles/PMC3145971/ | 2011-07-28 | Neuroscience review: consolidation/reconsolidation (neutral survey) |

Independence for the gate: each paper is its own origin group; CoALA and
McKenzie & Eichenbaum are disinterested (surveys, not their own system).

## Consensus — what the field agrees on (fact-gate passed)

**C1. Semantic memory is a distinct layer next to episodic memory.**
CoALA: *"short-term working memory and several long-term memories: episodic,
semantic, and procedural."* Zep mirrors it architecturally: *"This graph
comprises three hierarchical tiers of subgraphs: an episode subgraph, a
semantic entity subgraph, and a community subgraph."*

**C2. Semantic facts are LLM-distilled from episodes and MUST carry pointers
back to them. Episodes are never deleted.**
Generative Agents: *"we prompt the language model to extract insights and cite
the particular records that served as evidence for the insights... including
pointers to the memory objects that were cited."* Zep: episodes are *"a
non-lossy data store from which semantic entities and relations are
extracted."* CoALA frames the write path generally: *"LLMs to reason about raw
experiences and store the resulting inferences in semantic memory."*

**C3. Contradictions are resolved by invalidating/superseding the old fact
with priority to the new information — never by physical deletion.**
Mem0 (graph variant): *"marking them as invalid rather than physically
removing them to enable temporal reasoning."* Zep: *"it invalidates the
affected edges by setting their t_invalid to the t_valid of the invalidating
edge... Graphiti consistently prioritizes new information when determining
edge invalidation."* Neuroscience agrees on the mechanism level:
reconsolidation is *"the mechanism by which initially consolidated memories
are changed with new learning"* (modification of the trace, not erasure).

**C4. Consolidation runs offline/asynchronously on a threshold trigger — never
per-request on the hot path.**
Mem0: an async module *"operates independently of the main processing
pipeline... without introducing processing delays."* Generative Agents:
reflection fires *"when the sum of the importance scores for the latest events
perceived by the agents exceeds a threshold (150 in our implementation)...
roughly two or three times a day."* Neuroscience: consolidation happens in
offline states (sleep replay).

**C5. Injection is a compact block (~10–20 items), semantic facts served
together with episodes, scored by recency + relevance + importance.**
A-MEM: top-k with k=10. Zep: *"We then retrieve the 20 most relevant edges
(facts) and entity nodes."* Generative Agents: *"The top-ranked memories that
fit within the language model's context window are included in the prompt"*
with all three score weights = 1.

**C6. Semantic facts do not decay with age; they leave only via
contradiction/update. Decay applies to episode ranking.**
Generative Agents: decay factor 0.995 applies to the *recency score* of stream
records (append-only store). McKenzie & Eichenbaum: *"details of memories and
information not repeated or contradicted across repeated experiences are most
likely to be forgotten or overwritten, which also would be expected to result
in a residual and strengthened semantic memory."*

**C7. Retrieval strengthens memory and triggers update (reconsolidation /
retrieval practice).**
McKenzie & Eichenbaum: *"the encoding of new information occurs within the
context of retrieval."* Generative Agents: recency decays from *"the memory
was last retrieved"* — access refreshes.

## Verdict on the design (plans/2026-07-27-semantic-memory-layer.md)

The design matches the consensus on all seven points:

- `source_observation_ids` = Generative Agents' cited-evidence pointers (C2).
- `superseded_by` + strength transfer = Zep/Mem0 invalidation + reconsolidation (C3).
- Worker-side job throttled by interval + min-new-observations = threshold trigger off the hot path (C4).
- 15 facts above the timeline = inside the 10–20 corridor (C5).
- "Facts do not decay by age, leave only via supersede" = C6.
- `recordRetrieved` / `recordSurfaced` on facts = retrieval practice (C7).
- ADD/UPDATE/NOOP is Mem0's verdict set minus DELETE.

## Three deltas worth taking

**D1. Add a DELETE verdict (from Mem0).** UPDATE covers replacement, but not
"the fact simply stopped being true with no successor" (project moved off Bun,
nothing replaced it). DELETE should mark the row invalid/tombstoned, not
physically remove it — consistent with C3 and with the antibody principle
(refuted beliefs are kept, not erased). Schema-wise this is nearly free:
`superseded_by` stays NULL, add an `invalidated_at`/status column or a
reserved tombstone value.

**D2. Bi-temporal timestamps (from Zep — single source, pattern-level, still
cheap).** Graphiti stores four timestamps: *"t'created and t'expired ∈ T'
monitor when facts are created or invalidated in the system, while t_valid and
t_invalid ∈ T track the temporal range during which facts held true."* Two
extra columns (`valid_from`/`valid_to`) in migration v53 buy temporal
reasoning ("what did we believe at time X") and cleaner invalidation
semantics. At minimum reserve the columns now; populating `valid_from` from
the earliest source observation's date is a good default.

**D3. Require ≥1 source_id per ADD/UPDATE verdict and reject verdicts without
one — mechanically, in the verdict parser.** This is the fact-gate principle
("no source → no fact") applied to the consolidation LLM's output, and it is
exactly how Generative Agents constrain reflections (insights must cite
evidence records). A hallucinated fact with no provenance should fail parsing
the same way malformed JSON does.

## Consciously NOT for v1

- **Graph links between facts** (A-MEM links, Zep KG, HippoRAG PageRank).
  Every graph system pays latency/complexity; FTS5 + ACT-R strength covers
  v1 retrieval. Revisit if factual recall quality plateaus.
- **Streaming per-event consolidation** (Mem0/A-MEM do it per message pair).
  Session-granular + throttled is the right cost/latency point for an opt-in
  LLM-spending feature.

## Open disagreements in the field (not blockers)

- Consolidation cadence: streaming (Mem0, A-MEM) vs periodic threshold
  (Generative Agents, this design). A spectrum, not a contradiction.
- CoALA (2023) called memory updating/deletion "understudied"; Mem0/Zep (2025)
  solved it via LLM resolvers. The field converged on the design's approach.
- Neuroscience offers an alternative "schema" view where episodes and
  semantics are interleaved rather than separated; engineering systems nearly
  universally separate them. Noted, not adopted.

## Gaps (honestly not covered by this research)

- **Global cross-project user facts** (the design's deferred `__global__`
  question): personalization-focused systems (MemoryBank etc.) were not
  fetched. The deferral is reasonable; no external evidence either way.
- **Benchmark evidence for consolidation quality** (e.g. LOCOMO): vendors'
  superiority claims are interested-party and were not verified.
- **Procedural memory** (skills/workflows): deliberately out of scope.

## Operational note for future web research

PMC/NCBI/EuropePMC hosts are TLS-blocked in the research environment used;
Wayback snapshots (`web.archive.org/web/<year>/<url>`) and the Semantic
Scholar API work as fallbacks. arXiv full texts are best fetched via
`ar5iv.labs.arxiv.org/html/<id>`.
