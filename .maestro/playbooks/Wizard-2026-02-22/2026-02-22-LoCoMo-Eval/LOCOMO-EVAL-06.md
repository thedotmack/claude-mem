# Phase 06: Results Analysis & Publication

This phase generates the final analysis comparing claude-mem against the modern memory system landscape, creates per-category and per-conversation breakdowns, and produces structured methodology and findings documents. All comparisons use dual metrics: F1 (for historical comparison) and LLM-as-a-Judge (for comparison with Mem0, Zep, OpenAI Memory, and the full-context ceiling). Latency and token efficiency metrics are included for production-readiness positioning.

## Tasks

- [ ] Build results analyzer and generate dual comparison reports:
  - Create `evals/locomo/scripts/analyze-results.ts`
  - Load the most recent eval results file from `evals/locomo/results/eval-results-*.json`
  - Load the reporter module from `evals/locomo/src/scoring/reporter.ts`
  - Generate the **J-score comparison table** (primary — this is what modern systems compare on):
    ```
    System                    | Overall J | Single-hop | Multi-hop | Temporal | Open-domain
    --------------------------+-----------+------------+-----------+----------+------------
    Full-context              |   72.90   |     —      |     —     |    —     |     —
    Claude-Mem (Opus 4.6)     |  {J±std}  |   {J±s}   |   {J±s}  |  {J±s}  |   {J±s}
    Mem0ᵍ                     |   68.44   |   65.71    |   47.19   |  58.13  |   75.71
    Mem0                      |   66.88   |   67.13    |   51.15   |  55.51  |   72.93
    Zep                       |   65.99   |   61.70    |   41.35   |  49.31  |   76.60
    RAG (best, k=2)           |   60.97   |     —      |     —     |    —     |     —
    LangMem                   |   58.10   |   62.23    |   47.92   |  23.43  |   71.12
    OpenAI Memory             |   52.90   |   63.79    |   42.92   |  21.71  |   62.29
    A-Mem                     |   48.38   |   39.79    |   18.85   |  49.91  |   54.05
    ```
    Note: Letta reports 74.0% using a different "accuracy" metric — not directly comparable to J-scores.
  - Generate the **F1 comparison table** (secondary — for historical context):
    ```
    System                    | Single-hop F1 | Multi-hop F1 | Temporal F1 | Open-domain F1
    --------------------------+---------------+--------------+-------------+---------------
    Claude-Mem (Opus 4.6)     |    {F1}       |    {F1}      |    {F1}     |    {F1}
    Mem0                      |    38.72      |    28.64     |    48.93    |    47.65
    Mem0ᵍ                     |    38.09      |    24.32     |    51.55    |    49.27
    Zep                       |    35.74      |    19.37     |    42.00    |    49.56
    Human                     |               |              |             |         (87.9 overall)
    ```
  - Generate the **latency & efficiency comparison table**:
    ```
    System          | Search p50 | Search p95 | Total p50 | Total p95 | Tokens/Query
    ----------------+------------+------------+-----------+-----------+-------------
    Claude-Mem      |   {ms}     |   {ms}     |   {ms}    |   {ms}    |   {N}
    Mem0            |   148ms    |   200ms    |   708ms   |  1,440ms  |   1,764
    Mem0ᵍ           |   476ms    |   657ms    |  1,091ms  |  2,590ms  |   3,616
    Zep             |   513ms    |   778ms    |  1,292ms  |  2,926ms  |   3,911
    Full-context    |     —      |     —      |  9,870ms  | 17,117ms  |  26,031
    ```
  - Compute deltas: `+{X.X}` or `-{X.X}` points vs each baseline for both J and F1
  - Identify: strongest category (highest J), weakest category (lowest J), biggest delta vs Mem0, delta vs full-context ceiling
  - Print all three tables and key findings to console
  - Run: `bun evals/locomo/scripts/analyze-results.ts`

- [ ] Generate findings document:
  - Create `evals/locomo/results/findings.md` with YAML front matter:
    ```yaml
    ---
    type: report
    title: "LoCoMo Eval Results: Claude-Mem Persistent Memory"
    created: 2026-02-22
    tags:
      - locomo
      - eval
      - benchmark
      - memory
      - claude-mem
    related:
      - "[[Methodology]]"
    ---
    ```
  - Sections:
    - **Executive Summary** — one paragraph with the headline J-score, comparison to Mem0 (66.88%) and full-context ceiling (72.90%), and key takeaway. Also mention F1 results and where claude-mem ranks in the landscape.
    - **J-Score Results** (primary) — the full J-score comparison table from the analyzer, with analysis of where claude-mem sits relative to Mem0, Zep, full-context
    - **F1 Results** (secondary) — the F1 comparison table, noting this metric is included for completeness but has known length biases per LoCoMo-Plus (arXiv 2602.10715v1)
    - **Latency & Efficiency** — the latency comparison table, with analysis of claude-mem's production readiness vs Mem0's published numbers
    - **Per-Category Analysis** — for each of the 4 scored categories: J-score and F1 score, interpretation, comparison to strongest competitor in that category, what worked/what didn't
    - **Key Architectural Insights** — how claude-mem's approach compares:
      - Claude-mem uses Sonnet 4.6 for observation compression (vs Mem0's GPT-4o-mini extraction)
      - Hybrid search (FTS5 + Chroma vectors) vs Mem0's pure vector retrieval
      - Tool-use pattern (matching Letta's thesis that agent tool use > retrieval mechanisms)
      - One observation per session vs Mem0's per-message fact extraction
    - **Limitations** — single-run QA results (10-run J-scores provide confidence intervals), specific model versions, adversarial exclusion, potential confounders, no cognitive memory testing (LoCoMo-Plus)
    - **Future Work** — LoCoMo-Plus cognitive memory evaluation, adversarial category with proper ground truth, multi-model comparison (different answerer models), memory construction cost analysis
    - **Raw Numbers** — full per-category table with count, mean, min, max, std for both F1 and J

- [ ] Generate methodology document:
  - Create `evals/locomo/results/methodology.md` with YAML front matter:
    ```yaml
    ---
    type: report
    title: "LoCoMo Eval Methodology: Claude-Mem"
    created: 2026-02-22
    tags:
      - locomo
      - methodology
      - eval
      - claude-mem
    related:
      - "[[LoCoMo-Eval-Results]]"
    ---
    ```
  - Sections:
    - **Benchmark** — LoCoMo overview: 10 conversations (~600 dialogues each, ~26K tokens/conversation), 4 QA categories scored (single-hop, multi-hop, temporal, open-domain), adversarial excluded per Mem0 methodology (no ground truth). Cite: Maharana et al., ACL 2024
    - **Scoring Methodology** — dual metrics:
      - Token-level F1: normalization → Porter stemming → multiset token intersection → precision/recall/F1. Used for comparison with original paper baselines.
      - LLM-as-a-Judge: Claude Sonnet 4.6 evaluates predicted vs ground truth on factual accuracy, completeness, relevance, and contextual appropriateness (0-100 scale). 10 independent runs per question, reports mean ± stddev. Used for comparison with Mem0/Zep/OpenAI Memory baselines.
      - Rationale: F1 has known length biases (LoCoMo-Plus, arXiv 2602.10715v1). J-scores are the modern standard for memory system comparison. Dual metrics provide both backward compatibility and modern comparability.
    - **Memory System Under Test** — claude-mem architecture: Claude Code hooks → worker API → Sonnet 4.6 observation compression → SQLite FTS5 full-text search + Chroma vector embeddings. Key difference from Mem0: claude-mem compresses entire sessions into observations (one per session) rather than extracting per-message facts.
    - **Ingestion Pipeline** — how LoCoMo conversation sessions were transformed into tool executions (Read tool with dialog transcript), processed by Sonnet 4.6, and stored as structured observations with facts, narratives, and concepts
    - **QA Pipeline** — for each question: hybrid search (FTS5 + Chroma) retrieves top-10 observations scoped to conversation project → context window formatted from observation titles/facts/narratives (12K char budget) → Opus 4.6 generates extractive answer with category-specific prompting → F1 scored immediately, J-scored in separate pass
    - **Baseline Sources** — J-score baselines from Mem0 paper (arXiv 2504.19413, ECAI accepted, Table 2). F1 baselines from both Mem0 paper (Table 1) and original LoCoMo paper. Latency baselines from Mem0 paper (Table 3). All Mem0 baselines use GPT-4o-mini; our system uses Claude Sonnet 4.6 (compression) + Opus 4.6 (answering).
    - **Models** — Sonnet 4.6 (claude-sonnet-4-6) for memory compression and judging, Opus 4.6 (claude-opus-4-6) for QA answering
    - **Reproducibility** — list all parameters: search limit (10), context window (12K chars), QA temperature (0), QA max_tokens (256), judge temperature (0.5), judge max_tokens (256), judge runs (10), delay between calls. Note: EasyLocomo (github.com/playeriv65/EasyLocomo) provides a reference framework for reproducing LoCoMo evals.

- [ ] Generate per-conversation analysis:
  - Create `evals/locomo/scripts/per-conversation-analysis.ts`
  - Load eval results and group by conversation (sample_id)
  - For each of the 10 conversations, compute:
    - Overall J-score and F1 for that conversation
    - Per-category J and F1 (for categories that have questions in this conversation)
    - Question count
    - Number of observations stored (query claude-mem)
    - Average search results relevance: mean number of observations used per question
    - Mean search latency and answer latency for this conversation
  - Rank conversations from easiest (highest J) to hardest (lowest J)
  - Identify outlier patterns: are certain conversation topics harder? Do longer conversations perform better or worse? Does observation count correlate with score?
  - Print ranked table to console
  - Append the per-conversation breakdown as a new section in `evals/locomo/results/findings.md`
  - Run: `bun evals/locomo/scripts/per-conversation-analysis.ts`
