# Long-Term Memory for LLM Agents: What the Evidence Supports

## Scope and method

This review asks what the current literature actually establishes about how long-term memory for
LLM agents should be designed. It surveys 81 verified sources: 33 engineering papers describing
agent-memory systems, 14 evaluation papers and benchmarks, and 34 cognitive-science works.
Every non-obvious claim below carries a verbatim quote anchor checked programmatically as an exact
substring of the fetched source; 614 such anchors were verified across the corpus.

A fact-gate governs the language. A finding is called **consensus** only where it is supported by
at least two independent origin groups (distinct institutions), at least one primary source, and at
least one disinterested source — that is, a survey, benchmark, or evaluation not produced by the authors of the system being credited. Twenty-one candidate points were tested; thirteen passed and eight were
demoted, and the demotions are reported as prominently as the passes. Author-run benchmark numbers
are treated as interested claims throughout, which turns out to matter a great deal: of the
fourteen systems in the architecture track, **every single one reports only author-run results**,
and no third party has independently evaluated any of them.

The most important consequence of applying that gate is worth stating up front. The engineering
literature's convergences are real but almost entirely about *mechanism* — how systems are built.
The independent evaluation literature, which is small and recent, largely fails to show that those
mechanisms deliver the accuracy gains their papers claim. What it does show is that memory buys
cost reduction, that management policy matters more than architecture, and that the benchmarks
themselves are measuring something narrower than long-term memory.

## Consensus findings

### C1. Consolidation is LLM-prompted text abstraction, not weight update

Across seven systems from six institutions, "consolidation" means prompting a language model to
compress raw interaction records into higher-level text artifacts (summaries, extracted facts,
reflections), which are then stored alongside or instead of the originals. In Generative Agents, "Records are recursively synthesized" into reflections generated "when the
sum of the importance scores for the latest events perceived by the agents exceeds a threshold (150
in our implementation)" ([Park et al. 2023](https://doi.org/10.1145/3586183.3606763), UIST 2023);
MemoryBank produces daily event summaries aggregated into a global profile ([Zhong et al. 2024](https://doi.org/10.1609/AAAI.V38I17.29946), AAAI 2024);
Recursive Summarization generates a new summary only at session end ([Wang et al. 2025](https://doi.org/10.1016/j.neucom.2025.130193), *Neurocomputing*);
MemoryOS, MemGPT, Hindsight and EverMemOS follow the same pattern with different triggers. The
disinterested corroboration comes from the largest survey in the corpus, which states that
"Token-level memory is also the most common memory form and the one with the largest body of
existing work" ([Hu et al. 2025](https://doi.org/10.48550/arxiv.2512.13564)).

This is a convergence on *substrate*, and it has a consequence the field rarely states: because the
stored artifact is model-generated prose rather than the original record, every such system
inherits the distortion risks catalogued in the human memory literature: misattribution,
suggestibility, and present-state bias ([Schacter 1999](https://doi.org/10.1037/0003-066x.54.3.182)). Nothing licenses the inference that lossy
rewriting is *optimal* for a system that could cheaply store the original.

### C2. Consolidation fires on accumulated thresholds, not clocks

Eight systems from seven institutions trigger consolidation when an accumulated quantity crosses a
bound rather than on a wall-clock schedule: Generative Agents when the sum of importance scores
over recent events exceeds a threshold, MemGPT on token-count warnings, EM-LLM on per-token
surprise ([Fountas et al. 2024](https://doi.org/10.48550/arxiv.2407.09450), ICLR 2025), MemoryOS on segment heat, MIRIX every ~20 screenshots,
SleepGate on a token fallback bound, EverMemOS on detected semantic boundaries.

The convergence is on the trigger *type* only. Cadence values diverge across five orders of
magnitude with no shared unit — per-token, per-turn, per-topic-shift, per-session, per-day — which
means "when to consolidate" is not a settled question but a settled *style* of question. Any claim
that a particular interval is correct rests on one paper's own evaluation.

### C3. Decay modulates ranking, not storage

Where time-decay appears, it almost always multiplies a retrieval score rather than deleting
content, so the item persists and merely becomes harder to surface. Generative Agents applies "an
exponential decay function over the number of sandbox game hours" to recency in its retrieval score;
MemoryOS, Hindsight, EM-LLM, EverMemOS and LiCoMemory do the equivalent at retrieval time, six
institutions in total, with both surveys independently describing retrieval-side pruning as the
standard locus.

This convergence happens to be the one place where the engineering literature and the cognitive
literature agree on a principle rather than a vocabulary. ACT-R's base-level activation governs
retrieval probability and latency, not erasure ([Anderson et al. 2004](https://doi.org/10.1037/0033-295x.111.4.1036), *Psychological Review*), so
scoring by decayed recency-and-frequency is exactly what the cognitive model licenses. Deletion is
exactly what it does not.

### C4. Provenance is a timestamp, and audit is unsupported

This is the corpus's clearest and most consequential absence. A per-item timestamp is the
near-universal provenance field and in most systems the only one. Of seven architecture-track systems that store any provenance, only three go beyond a bare
timestamp to an explicit source pointer (MIRIX, EverMemOS, Hindsight), and Generative Agents stores
pointers to cited memory objects for reflections specifically. Six of eleven retrieval-track systems
specify no provenance mechanism at all, including Mem0, A-MEM, HippoRAG, HippoRAG 2, Memory-R1 and
SimpleMem. **No system in the corpus describes using provenance for later audit**, including those
that store the pointers. Ten institutions are represented in that absence.

The disinterested sources establish that this is a gap rather than a non-requirement. The security
survey maps source monitoring to provenance tracking as a design requirement while reporting no
peer-reviewed evaluation of end-to-end rollback and forensic traceback ([Lin et al. 2026](https://arxiv.org/abs/2604.16548)). Two
HCI studies, evaluating no system of their own, establish that users want memory they can inspect,
categorize and control ([Jones et al. 2025](https://doi.org/10.1145/3706599.3720158), CHI 2025; [Kim et al. 2026](https://doi.org/10.1145/3800645.3812979), DIS 2026).

### C5. A four-operation write vocabulary has become the de facto standard

ADD / UPDATE / DELETE / NOOP, or direct equivalents, is the closest thing to a standard maintenance
interface. Mem0 states the set explicitly ([Chhikara et al. 2025](https://doi.org/10.3233/FAIA251160), ECAI 2025); Memory-R1 and
Agentic Memory adopt the same four from three distinct institutions. The corroboration is
disinterested and unusually direct: the NUS survey credits Mem0 with having "established
standardized operations for memory maintenance, laying the foundation for intelligent control."

### C6. Prompted LLM judgment is the default write-side decider

In six systems from five or more institutions (Mem0, A-MEM, Zep, RMM, HippoRAG 2's filter,
SimpleMem), what enters or changes memory is decided by a prompted language model, not by a learned
policy and not by fixed rules. The graph survey independently describes LLM extraction followed by
a reasoned integration phase involving "conflict detection" and schema evolution as the standard
write path ([Yang et al. 2026](https://arxiv.org/abs/2602.05665)).

The disinterested evidence adds a sharp qualification that the system papers do not: the judge's
*reliability* determines whether this design helps or harms. A controlled study across three
independent agent frameworks found selective addition beneficial only when the filter is strict,
and actively harmful when it is coarse ([Xiong et al. 2026](https://doi.org/10.18653/v1/2026.acl-long.27), ACL 2026).

### C7. Dense similarity alone is insufficient

Four groups independently add a lexical or sparse channel alongside embedding similarity, and give
the same reason for it: semantic similarity misses specific entities. Zep and SimpleMem add BM25,
GAM adds lexical retrieval, HippoRAG uses node specificity as an IDF analogue. The graph survey
states the underlying problem without having built any of them: "Similarity does not guarantee
relevance. Lexically or semantically similar text may not match the specific memory needed for a
task."

### C8. Memory's measured benefit is cost, not accuracy

This is the finding that most sharply contradicts how the system literature presents itself, and it
is the best-supported positive claim in the corpus. A disinterested Edinburgh evaluation found that
"memory-augmented approaches reduce token usage by over 90% while maintaining competitive accuracy"
([Terranova et al. 2025](https://arxiv.org/abs/2510.23730)) — 23,132 tokens per query for full context against 649 for RAG on
GPT-4o mini. A separate UIUC study found plain full-context prompting scoring 0.723 on LoCoMo against
Mem0's 0.613, LangMem's 0.513 and Zep's 0.585, beating four of the five memory systems it was
compared against on accuracy ([Zhou et al. 2025](https://doi.org/10.48550/arxiv.2511.17208)). A third group independently reports that
memory systems' costs are large and mostly unreported elsewhere ([Jiang et al. 2026](https://doi.org/10.48550/arxiv.2602.19320)).

An agent memory layer is a compression mechanism whose accuracy is competitive with keeping
everything in context, not a mechanism that makes the agent smarter.

### C9. Dedicated memory systems do not reliably beat plain retrieval outside conversational QA

Four independent evaluator groups, none of which built the systems tested, converge here. A Tsinghua
benchmark spanning eleven datasets found that "none of the advanced memory-based LLMsys (i.e.,
A-Mem, Mem0, or MemoryOS) can consistently outperform RAG baselines that simply use all task context
and feedback logs as retrieval corpus," stating outright that this "is contradicting to the good
results reported by former studies" and diagnosing the cause precisely: "previous studies only
tested their system on reading comprehension tasks that involve long input context and require
short answers (e.g., Locomo)" ([Ai et al. 2025](https://doi.org/10.48550/arxiv.2510.17281)). A Google DeepMind and UIUC streaming
benchmark found several published systems falling *below* a no-memory baseline, with LangMem at 0.49
and AWM at 0.48 against a baseline of 0.54 ([Wei et al. 2025](https://doi.org/10.48550/arxiv.2511.20857)). An ACL 2026 Findings
evaluation of six memory agents concluded they "offer marginal improvements," winning decisively
only on recall while plain language models matched or exceeded them on recommendation
([Uddin et al. 2026](https://doi.org/10.18653/v1/2026.findings-acl.1337)). Edinburgh found plain RAG beating A-MEM across all foundation models tested.

### C10. Management policy dominates architecture

Three groups establish that *what is admitted and what is deleted* matters more than how memory is
structured. The Harvard-led controlled study across three agent frameworks found that "combining
selective addition and deletion strategies can help mitigate these negative effects, yielding an
average absolute performance gain of 10% compared to naive memory growth," and that periodical
deletion "achieves substantial memory reduction with minimal performance degradation" at accuracy
costs under 2%. Its diagnostic contribution is the *mechanism* of failure: agents display an
"experience-following property" where high input similarity to a retrieved record produces highly
similar output, which propagates errors and replays misaligned experience. The DeepMind/UIUC
benchmark independently found unfiltered accumulation introducing retrieval noise.

Since the default configuration of most published systems is add-all with no deletion, this is a
disinterested finding that the field's standard design is the losing condition.

### C11. Procedural memory is absent

None of the eleven retrieval-track systems, spanning nine institutions, stores reusable skills or
routines as opposed to facts. The graph survey defines the category — procedural memory "Encodes
skills, routines, and immutable rules" — and the corpus contains exactly one attempt to evaluate it,
via prompt optimization on QA, where it underperformed. The cognitive literature independently
warns that "procedural" is not one thing: in Squire's taxonomy it is an explicitly residual
umbrella covering skills, habits and priming as unrelated systems ([Squire 2004](https://doi.org/10.1016/j.nlm.2004.06.005)), so the
absence may partly reflect that the target was never well specified.

### C12. The benchmarks measure something narrower than long-term memory

Five groups establish this from different directions. All conversational benchmarks in the corpus,
including LoCoMo ([Maharana et al. 2024](https://doi.org/10.18653/v1/2024.acl-long.747), ACL 2024), LongMemEval ([Wu et al. 2024](https://doi.org/10.48550/arxiv.2410.10813), ICLR 2025) and Memora, are
LLM-generated or simulation-driven; none uses genuine logged multi-month human interaction. At
LoCoMo's ~20k-token scale, full-context baselines are competitive, which is why one group proposes a
context-saturation gap as the validity test a benchmark must pass. System *rankings* are not stable
across protocols: lexical F1 and an LLM semantic judge produce different winners, with A-Mem
ranking 4th semantically but 5th by F1 at 0.116. And the scoring target is usually left implicit. Holding the ranked output completely fixed and changing only which stored form receives credit
"changes nDCG on 83.4%–94.0% of shared queries, flips target orderings on Mem0 and MemoryOS transfer
runs" ([Panthi et al. 2026](https://arxiv.org/abs/2605.24060)). Two papers reporting retrieval metrics on the same benchmark may
therefore not be measuring the same thing.

### C13. The appeals to cognitive science are motivational, not derivational

Eight of fourteen architecture-track systems invoke named cognitive or neuroscience sources as
justification. Auditing those invocations against the cognitive primaries themselves — which are
disinterested with respect to any agent system — shows that the load-bearing ones do not transfer.
Ten specific over-extrapolations were identified; three matter most.

The Ebbinghaus forgetting curve is the most-cited anchor in the corpus and the least able to
support what is built on it. Ebbinghaus measured *savings* on relearning nonsense syllables by a
single subject; the dependent variable is reduction in relearning effort, not the probability that a
stored fact is useful. The modern replication states plainly that "This suggests that the general
applicability of Ebbinghaus equations may be lacking" ([Murre & Dros 2015](https://doi.org/10.1371/journal.pone.0120644)), and a survey of 105
candidate retention functions across 210 datasets could not distinguish the best four
([Rubin & Wenzel 1996](https://doi.org/10.1037/0033-295x.103.4.734)). There is no verified Ebbinghaus constant to import, and the curve
describes retrieval failure, never deletion.

"Reconsolidation" is invoked to license rewriting a stored entry on retrieval. The finding is real
but narrow. Reactivation followed immediately by anisomycin in the rat amygdala impairs later
memory, while a six-hour delay abolishes the effect ([Nader et al. 2000](https://doi.org/10.1038/35021052)). Nader himself states
that "The fact that memory reconsolidation has been found across levels of analysis does not imply
that reconsolidation is universal." Every load-bearing element (protein synthesis, the amnesic
agent, the lability window, the reactivation requirement) is absent in a text store, and the
demonstrated effect is memory *disruption*, so nothing in this literature says a post-retrieval
update improves accuracy.

The hippocampus/cortex division is invoked to license two-tier caches. But the complementary
learning systems argument is computational, not anatomical. Two systems are needed because
gradient-trained distributed networks suffer catastrophic interference when taught new items
directly, and the transfer mechanism is interleaved *replay that retrains a weight-based learner*
([McClelland et al. 1995](https://doi.org/10.1037/0033-295x.102.3.419); [Kumaran et al. 2016](https://doi.org/10.1016/j.tics.2016.05.004)). A non-parametric text store does not suffer
catastrophic interference, so the problem CLS solves does not arise, and moving a record from a
recent table to an archive table shares no mechanism with replay-and-retrain. Whether the
hippocampal trace is relinquished at all remains disputed within the cognitive literature itself.

One cognitive result does transfer cleanly, and it is the one the engineering literature cites
least. ACT-R's base-level activation, Bi = ln(Σj tj^−d) with d defaulting to 0.5, is justified
*environmentally*: Anderson and Schooler analysed child-directed speech, New York Times headlines
and email senders and found that the probability an item will be needed again is a power function of
time since last use ([Anderson & Schooler 1991](https://doi.org/10.1111/j.1467-9280.1991.tb00174.x)). That is a direct licence for a
recency-and-frequency ranking score over access timestamps, with the caveat that d = 0.5 is a
fitted default within one architecture, not a constant of nature, and the right exponent for an
agent's environment is an empirical question about that environment.

## Disagreements and single-source claims

Eight candidate findings failed the fact-gate. They are recorded here because several are widely
repeated as though settled, and the evidence ledger records the decision for each.

**Graph-structured memory versus flat vectors** is the field's most visible architectural dispute
and has no disinterested resolution. Four groups build graph memory and traverse it at retrieval
(Zep's temporal knowledge graph, HippoRAG's personalized PageRank over an open KG, LiCoMemory's
three-layer CogniGraph, Mem0's graph variant), while base Mem0, A-MEM, Memory-R1, AgeMem and
SimpleMem stay flat, and GAM keeps verbatim pages and defers all structuring to read time. The only
positive evidence isolating graph structure is a within-system ablation by authors ablating their
own variant; the independent evidence that exists reports graph systems' cost and robustness
penalties. **Disputed, interested evidence only.**

**Outcome-reward reinforcement learning for memory management** is the corpus's most striking
convergence *and* its cleanest example of why convergence is not corroboration. Four independent
groups (LMU Munich's Memory-R1, BAAI's GAM, Alibaba's Agentic Memory, and Arizona State's RMM
reranker) arrived at the same reward architecture: train the memory manager on the answer accuracy
of a frozen consumer model. Memory-R1's motivating failure is precisely an LLM judge misfiring,
issuing DELETE-then-ADD on a non-contradiction, and it reports 48% relative F1 improvement over
Mem0. But every performance claim is author-run and no third party has evaluated any of the four.
**Convergent but uncorroborated.**

**Contradiction resolution** divides irreconcilably with no head-to-head evidence. Base Mem0 deletes
contradicted memories, A-MEM replaces originals, RMM merges and SimpleMem consolidates, all
destructive. Zep sets an invalidation timestamp on the superseded edge and keeps it queryable
specifically to preserve history, and Mem0's own graph variant contradicts base Mem0 by marking
relationships invalid rather than removing them. The graph survey describes temporal invalidation
with validity intervals as the non-destructive alternative. Nothing compares the two policies on any
benchmark. **A described divergence with no comparative evidence.** This matters, because the
choice determines whether an agent can ever answer "what did I believe last month."

**Ebbinghaus-style decay functions improve performance** fails twice over. MemoryBank and FSFM both
implement explicit exponential retention curves from two institutions, but both report only
author-run results, and the cognitive primaries actively deny that any specific functional form is
established. **Disputed, and contradicted by the cognitive sources it invokes.**

Three claims rest on a single source each. An **LLM relevance filter over retrieved candidates** is
reported as the largest single ablation effect in the corpus, by authors ablating their own
component. **Larger injection budgets** were measured once, by an interested party, and the curve is
*flat* above a moderate top-k, a null result worth knowing precisely because larger budgets are
often assumed to help. **Sleep-like offline replay** rests on one single-author preprint with no
corroborating system and no independent evaluation.

**Parametric and latent memory**, meaning experience written into weights (Echo) or a memory matrix
(Larimar) rather than an external store, is attested as a real design class by the NUS survey's
three-way taxonomy of token-level, parametric and latent memory. But no disinterested evaluation
compares parametric against token-level memory on any shared benchmark. **The design class is
established; its performance is unevaluated.**

Finally, a hazard that is not a disagreement but corrupts cross-paper comparison: **author-run
numbers for the same baseline systems disagree across papers.** Mem0 reports Zep at 3,911 memory
tokens and 65.99 on LoCoMo; LiCoMemory reports Zep at 44.76% and Mem0 at 54.68%; SimpleMem reports
Mem0 at roughly 980 tokens against Mem0's own 1,764. Each is a competitor's rerun. One evaluation
group notes a methodological reason these cannot be reconciled: earlier LoCoMo papers tailored
prompts per reasoning category while they held one prompt fixed. Reported numbers from system papers
should not be compared across papers at all.

## Open problems

**Streaming versus periodic consolidation** is unresolved and, on current evidence, cannot be
resolved by appeal to cognitive science. Systems span per-token to per-day cadence with no shared
unit, and the closest thing to a principled position is SimpleMem's argument for synchronous write-time
consolidation, set against GAM's opposite argument for minimal write-time work and heavy read-time
research with reflection depth as a test-time scaling knob. Both sides support their position with their own benchmarks. The related
disagreement about *where compute should sit* is equally live: HippoRAG argues single-step multi-hop
retrieval is 10-30x cheaper than iterative methods, while GAM argues iteration monotonically
improves results.

**Per-type decay rates** have no empirical basis anywhere in the corpus. No source measures whether
episodic, semantic and procedural entries should decay at different rates, and the cognitive
literature does not supply the constants — the functional form of forgetting is itself actively
disputed, with power-versus-exponential unresolved and the power form possibly an artifact of
averaging across subjects ([Wixted & Ebbesen 1991](https://doi.org/10.1111/j.1467-9280.1991.tb00175.x); [Rubin & Wenzel 1996](https://doi.org/10.1037/0033-295x.103.4.734)). What the
cognitive literature *does* offer is a two-factor structure: Bjork and Bjork's distinction between
storage strength (entrenchment, which retards loss and speeds relearning) and retrieval strength
(current accessibility, which alone determines present performance), where the conditions that
fastest raise retrieval strength are not those that maximize storage strength. That maps onto
keeping two scores per item rather than one, but the theory as verifiable is qualitative and
specifies no functional form for either.

**Global cross-user and cross-project facts** are essentially unaddressed. The security survey's
coverage table shows the sharing lifecycle phase uncovered by nearly every benchmark, and no corpus
system implements principal-scoped access or addresses shared-memory contagion.

**Associative links and spreading activation** are the one place where a cognitive mechanism and an
engineering mechanism genuinely align. HippoRAG's personalized PageRank over an entity graph is a
recognizable computational analogue of spreading activation, and ACT-R's own activation equation
includes associative terms Σj Wj·Sji alongside base-level activation. Four groups build and traverse
link structure. What is missing is evidence that traversal beats flat retrieval when cost is held
constant.

**Procedural skill memory** is the largest structural gap. It is absent from every system in the
retrieval track, evaluated once and unsuccessfully, and arguably not yet well specified as a target.

**Right to erasure versus audit trails** is a direct conflict that the corpus does not resolve and
mostly does not notice. Consensus C4 establishes that provenance is a timestamp and audit is
unsupported; the security survey reports no peer-reviewed evaluation of end-to-end rollback and
forensic traceback; the HCI studies establish that users want inspection and deletion. Meanwhile the
non-destructive contradiction handling that would support audit (Zep's invalidation) is in direct
tension with the destructive deletion that erasure requires, and no system in the corpus implements
both.

**A cognitive result the field has not used**: the testing effect. Retrieving material is a stronger
learning event than restudying it, but the benefit is delay-dependent and *reverses* at short delays.
Repeated study beat repeated testing at a 5-minute final test while testing won substantially at 2
days and 1 week ([Roediger & Karpicke 2006](https://doi.org/10.1111/j.1467-9280.2006.01693.x); [Karpicke & Roediger 2008](https://doi.org/10.1126/science.1152408)). Both papers report
that learners' confidence tracks the wrong variable. The engineering analogue is *not* "make the
agent re-query its store": for a text database a read changes nothing, so the mechanism is absent
unless retrieval actually rewrites or reweights the item. The transferable part is the metacognitive
warning: measured confidence is a poor proxy for retention, and a system optimizing immediate
performance may be optimizing against long-term retrievability.

Similarly, the **spacing effect** requires care. The spacing effect proper (any gap versus none) is
robust and not modulated by retention interval, but the *lag* effect is non-monotonic and the optimal
gap grows with the retention interval you are optimizing for. At sub-minute retention intervals
sub-minute gaps are best; at six months or more, gaps of at least a month are best
([Cepeda et al. 2006](https://doi.org/10.1037/0033-2909.132.3.354), 839 assessments across 317 experiments). A single fixed refresh period
is precisely what the meta-analysis rules out, and a scheduler that re-embeds memories on a spaced
timetable without ever measuring subsequent retrieval has borrowed the vocabulary without the effect.

## A reference architecture for 2026

What follows is what the assembled evidence supports, with each choice tied to a numbered finding.
Where a choice rests on weak evidence it is marked. The most important design consequence of this
review is a framing one: on current independent evidence, an agent memory subsystem should be
justified as **a cost-and-controllability mechanism with competitive accuracy** (C8), not as an
accuracy improvement over keeping everything in context (C9). Designs that cannot beat full-context
on accuracy are not thereby failures — but claiming otherwise is not supported.

### Components

**A verbatim episodic log, append-only, with source pointers.** Every turn, tool call and document
lands here unmodified, keyed by session, turn, timestamp and principal. This is the substrate C4
shows to be missing: without it, provenance, audit and erasure are all unimplementable, and the
distortion risks of storing only model-generated prose (C1, COG-10) have no fallback. It also
supports the strong full-context baseline that C8 and C9 identify as the thing to beat on cost.

**A derived semantic store of extracted facts and profile attributes**, each carrying a required
pointer back to the episodic spans that produced it (C1 for the mechanism, C4 for the pointer that
current systems omit). Entries are typed, deduplicated, and never written without provenance.

**A working context assembler** that constructs the prompt payload under an explicit token budget.
Keep the budget modest: the one available measurement of top-k sensitivity found a flat curve above a
moderate threshold (single-source, null result), and realized footprints across six systems cluster
in the 0.5k-4k range.

**A procedural store, declared rather than designed.** C11 establishes that nothing in the corpus
implements or successfully evaluates this, and the cognitive literature warns the category is a
residual umbrella rather than a natural kind (COG-01). Recommendation: keep learned procedures in a
separate, explicitly versioned store with human review, and treat any claim about its benefit as
unevidenced.

### Data flow

Write path: every interaction appends to the episodic log unconditionally; a *gated* extraction step
proposes semantic entries. The gate is the highest-leverage component in the system (C10): admit
selectively rather than adding everything, because the field's default add-all configuration is the
measured losing condition, and an unfiltered store degrades performance through
experience-following. Make the gate strict — a coarse filter is worse than none (C6).

Read path: hybrid retrieval combining dense embeddings with a lexical/sparse channel (C7), a decayed
recency-and-frequency score, and an LLM relevance filter over the candidate set before injection.
The filter is single-source evidence but the largest reported ablation effect; it is also cheap to
ablate, so treat it as a hypothesis to test in your own harness rather than a settled component.

### Update operations

Adopt ADD / UPDATE / DELETE / NOOP (C5) as the interface, with prompted LLM judgment as the default
decider (C6) — while noting that four independent groups have converged on outcome-reward RL as the
alternative, an interesting convergence with no third-party corroboration.

For contradictions, prefer **non-destructive invalidation**: mark the superseded entry with a
validity interval and keep it queryable rather than deleting it. Two cautions. First, this is a
described divergence with no comparative performance evidence, so the justification is not accuracy
but capability, since it is the only way to answer questions about prior belief state, and the only way
provenance survives a correction. Second, it collides with erasure: a genuine deletion request must
remove the invalidated entry too, which means invalidation and hard deletion are different
operations and both are required.

### Decay and forgetting policy

Score, don't erase (C3). Rank items by a recency-and-frequency function over access timestamps of the
form log(Σ t^−d) plus a context-similarity term. This is the one design element with a real
cognitive licence, from ACT-R's environmentally-justified base-level activation (COG-04). Fit d to
your own access logs; do not import 0.5 as a constant, and do not use the activation score as a
deletion rule, which is exactly what the cognitive source does not license.

Delete on a separate, explicit policy — not on decay. The evidence for deletion is real but it is
evidence about *policy*. Periodical (frequency-threshold) deletion achieved substantial size
reduction at accuracy costs under 2%, and selective addition combined with deletion gave a 10%
absolute gain over naive growth (C10). Do not label any of this with Ebbinghaus: no verified curve
constant exists to import, and two groups implementing such curves have only author-run support
(D5, C13).

Consider two scores per item rather than one: a durable entrenchment score and a volatile
accessibility score, updated by different events and used for different decisions (retain versus
surface). This follows Bjork and Bjork's two-factor account, which is the cleanest conceptual import
available, with the explicit caveat that the theory is qualitative and any specific formula is the
engineer's invention (COG-08).

### Provenance and governance

Require a source pointer on every derived entry; surface it at retrieval; log every write, update,
invalidation and deletion with actor and timestamp. Three corpus systems store source pointers but
none describes using them for audit (C4), so the audit surface itself is untrodden ground and is justified by the security survey's requirement analysis and two HCI studies of user
expectations rather than by any performance benchmark. Scope memory by principal: shared-memory
contagion and principal-scoped access are uncovered by nearly every benchmark.

### Evaluation harness

Build the harness before the system, because C12 establishes that the published benchmarks will
mislead you. Concretely:

1. Always report a full-context baseline and a plain-RAG baseline; if the memory layer does not beat
   them on *cost* at competitive accuracy, it has no demonstrated benefit (C8, C9).
2. Report cost and latency as first-class axes alongside accuracy — most system papers do not, and
   independent evaluators identify this as a systematic omission.
3. Declare the scoring target explicitly (raw / source / canonical). Changing only which stored form
   receives credit alters nDCG on 83-94% of queries and flips system orderings (C12).
4. Use both a lexical and a semantic-judge metric and report disagreement between them; rankings are
   protocol-dependent, and semantic-judge rankings are the more robust of the two across rubrics.
5. Check saturation: if a full-context baseline at your context scale answers most items, the
   benchmark cannot discriminate memory designs.
6. Test on non-conversational task streams as well. Every positive published result concentrates on
   LoCoMo-style reading comprehension, and generalization beyond it has repeatedly failed (C9).
7. Test mutation and obsolescence directly — contradicted facts, superseded preferences — rather than
   inferring update quality from answer correctness. One evaluation group explicitly lists forgetting,
   updating, consolidating and contradiction handling as untested mechanisms.
8. Test erasure and provenance as capabilities: can the system delete a fact and demonstrate it is
   gone, and can it say where a belief came from? Nothing in the corpus measures either.
9. Prefer real logged interaction where obtainable; every conversational benchmark in the corpus is
   synthetic or LLM-generated.

## Gaps: what could not be verified

**Independent evaluation of any architecture-track system.** All fourteen report only author-run
results. This is the single largest evidential hole in the review, and it is why so many mechanism
convergences could not be promoted past "described."

**Most cognitive-science full texts.** Publisher copies are closed-access and NCBI (PubMed, PMC,
E-utilities) was unreachable from this environment throughout. Of 97 cognitive anchors, 30 are
full-text, 34 are verbatim restatements in later open-access papers by the same authors, 23 are
abstract-level and 10 came via the Wayback Machine; 34 corpus sources could not be reached at all.
No pooled effect size could be verified from Rowland's testing-effect
meta-analysis (abstract only, reports no numeric g), and no pooled d or g from Cepeda's spacing
meta-analysis, so no effect-size figures are quoted for either. Bjork and Bjork 1992, the primary
statement of the new theory of disuse, is a book chapter with no DOI whose text was unreachable;
the two-factor account is anchored to the authors' own 2011 restatement instead. No consolidation
half-life or hippocampus-to-cortex transfer rate could be verified from any primary source, so the
engineering habit of quoting a fixed transfer time is unsupported rather than merely unverified.

**Nemori has no paper.** Searched across OpenAlex, arXiv, DBLP and Crossref; the only arXiv hit for
the string is an unrelated paper. It appears in three independent evaluations as a system under test,
but there is no primary source, so no mechanism claim about it enters this review. Letta likewise has
no standalone paper — MemGPT is the citable primary. HippoRAG 2 is published as "From RAG to Memory."

**Venue status of 22 engineering records** could not be established as peer-reviewed; they are
labelled preprint, and two records' ICLR 2025 attribution rests on arXiv comment metadata alone
because DBLP lookups failed after retries. Seventeen engineering and evaluation records carry arXiv DataCite DOIs
(10.48550/*) which Crossref does not index; such a DOI is never itself venue evidence.

**One corpus record is misattributed and was not used.** The OpenAlex hit for Bartlett 1932 is a 1933
review *of* the book, not the book; no Bartlett claim is made.

**Semantic Scholar citation-context data** was unobtainable (persistent HTTP 429), so citation-context
analysis was replaced by bibliography mining from full texts.

**Two absences are findings rather than gaps**, and worth separating from the above. No benchmark in
the corpus evaluates erasure or provenance, and no source measures per-type decay rates. These are
not things this review failed to find — they are things the literature has not yet produced.


## Appendix: corpus and verification

**Corpus**: 81 sources — 33 engineering system papers and surveys, 14 evaluation papers and
benchmarks, 34 cognitive-science works. Of the 47 engineering and evaluation records, 25 are
peer-reviewed at a named venue and 22 are preprint-only; every venue claim carries its evidence
source in the corpus table. All 32 cognitive-science DOIs resolved on Crossref with matching titles.
Seventeen engineering and evaluation records carry arXiv DataCite DOIs (10.48550/*), which Crossref
does not index; such a DOI is never itself venue evidence, though five of those records are
peer-reviewed on independent evidence (A-MEM at NeurIPS 2025, HippoRAG 2 and Larimar at ICML,
LongMemEval and EM-LLM at ICLR 2025) established from arXiv comment metadata or DBLP.

**Verification**: 614 verbatim anchors were checked programmatically as exact substrings of fetched
source text — 197 for systems architecture, 180 for evaluation, 140 for retrieval and update
mechanisms, and 97 for cognitive science. Cognitive anchors break down as 30 full-text, 34 verbatim
restatements in later open-access papers by the same authors, 23 abstract-level and 10 recovered via
the Wayback Machine; that distribution is itself a finding about access to the cognitive literature.

**Fact-gate outcomes**: 21 candidate points tested. 13 passed as consensus (C1-C13). 8 were demoted:
2 disputed, 3 single-source, 1 convergent-but-uncorroborated, and 2 attested-as-a-design-class with
performance unevaluated. Per-candidate decisions, origin groups and reasons are in the evidence
ledger.

Companion files: `corpus_table.csv` (all 81 sources), `mechanism_matrix.csv` (25 systems × 20
mechanism dimensions, distinguishing stated absences from out-of-scope cells), `evidence_ledger.csv`
(the fact-gate decision for every candidate).
