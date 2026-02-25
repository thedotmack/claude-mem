# Identity Resume Experiment: Empirical Results

## Experiment Design
5 Sonnet subagents given identical codebase research task (propose "privacy mode" toggle for claude-mem). Each received different context:
- Control: no resume
- A (Achievement): competence facts, patterns, architecture
- B (Relational): working dynamic with Alex, shared discoveries, learned preferences
- C (Narrative): story-format relationship history
- D (Structured Brief): compact bullets covering both

## Results

**Winner: B (Relational) — qualitatively different output**
- 3 files / ~10 lines vs everyone else's 5-7 files / 20+ lines
- Only agent to reference user preferences by name ("matches Alex's preference for runtime-changeable configuration")
- Only agent to defer ambiguous decisions as questions ("worth a question before implementation")
- Deferred UI work entirely ("controllable via settings.json without UI changes")
- Zero YAGNI violations

**Achievement resume (A) had NO measurable effect vs control.** Competence facts don't change behavior.

**Narrative (C) and Structured Brief (D) showed moderate improvement** in vocabulary adoption (used "YAGNI" naturally, quoted edge-processing patterns) but didn't change fundamental approach or scope.

**Control proposed YAGNI violation** (dedicated toggle HTTP endpoints nobody asked for).

## Key Insight
Relational context (how the user works, what frustrates them, what energizes them) changes agent behavior far more than competence context (what was built, what was fixed). The mechanism appears to be: relational awareness → scope minimization → preference alignment. Achievement facts produce confidence without behavioral change.

## Recommendation
Build Identity Resume skill using Variation B (relational) as primary template. Optionally enrich with architectural sacred cows from Variation D since pattern vocabulary also showed moderate benefit.

## Scoring Detail

| Metric | Control | A (Achievement) | B (Relational) | C (Narrative) | D (Structured Brief) |
|--------|---------|-----------------|-----------------|----------------|---------------------|
| Files Modified | 6 | 5-7 | **3** | 6-7 | 6 |
| YAGNI Violations | Yes (endpoints) | Minor (banner) | **None** | Minor (UI) | None |
| User Preference Awareness | None | None | **Strong** | Moderate | Weak |
| Approach | Hook-layer | Worker-layer | Worker-layer | Hook-layer | Hook-layer |
| Confidence | Hedging | High | Appropriate | Highest | Clean |
