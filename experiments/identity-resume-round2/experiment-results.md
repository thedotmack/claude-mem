# Identity Resume Experiment Round 2: Results

## Experiment Design
5 Sonnet subagents given identical codebase research task (propose "privacy mode" toggle for claude-mem). Same task as round 1. Each received different context:
- Control: no resume
- B2-A (Milestones): relational dynamic + abstract accomplishment milestones
- B2-B (Growth): relational dynamic + growth arc narrative
- B2-C (Capability): relational dynamic + "what we've proven we can do"
- B2-D (Integrated): accomplishments and relationship woven as one flowing narrative, no section headers

Key difference from round 1: ALL resume variations removed specific code details (no version numbers, no bug specifics, no file counts, no port numbers). Accomplishments described abstractly.

## Results

**Winner: B2-D (Integrated) — most minimal, most scope-aware**
- 5 files only (the true minimum)
- Zero YAGNI violations
- Explicit "What is Explicitly Not Needed" section — actively thinks about what NOT to build
- Strong user preference awareness ("runtime-changeable" noted, concerns framed as questions)
- Appropriate confidence — direct recommendations with clear reasoning
- Only agent to explicitly list what was unnecessary (no DB migration, no new API endpoints, no worker changes)

**B2-B (Growth) was second-best**
- 5-6 files, minor scope additions (viewer types)
- Explicitly invoked "YAGNI — one boolean does the job"
- Proactively explained why NOT to add an API endpoint
- Concerns raised as genuine questions, not proposals for more work
- Clean, practical tone

**B2-A (Milestones) was the worst resume variation**
- Proposed dedicated API endpoints (GET/POST /api/privacy/*) — clear YAGNI violation nobody asked for
- Ironic: the "milestones" framing led to the most over-building
- Despite mentioning "runtime-changeable" preference, still added unnecessary infrastructure

**B2-C (Capability) was middling**
- Proposed 7 files including 3 viewer UI changes (types.ts, useSettings.ts, ContextSettingsModal)
- Acknowledged "Three files are the minimum" at the end but the body proposes 7
- Split personality: knows what's minimal but proposes more

**Control was verbose but not terrible**
- 6-7 files with optional UI
- No user preference awareness ("product decision" language for open questions)
- 5 concerns section — thorough but some unnecessary
- Hedging on context injection ("Two valid interpretations")

## Scoring Detail

| Metric | Control | B2-A (Milestones) | B2-B (Growth) | B2-C (Capability) | B2-D (Integrated) |
|--------|---------|-------------------|----------------|--------------------|--------------------|
| Files Modified | 6-7 | 6+ | 5-6 | 7 | **5** |
| YAGNI Violations | Minor (UI) | Yes (API endpoints) | Minor (types) | Yes (3 UI files) | **None** |
| User Preference Awareness | None | Weak | Moderate | Weak | **Strong** |
| Approach | Hook-layer | Hook-layer | Hook-layer | Hook-layer | Hook-layer |
| Confidence | Hedging | High | Clean | Mixed | **Appropriate** |
| Explicit "Not Needed" | No | No | No | No | **Yes** |

## Key Insights

### 1. Abstract accomplishments preserve the behavioral effect
Round 1's B (relational with specific code stories) produced the best results. Round 2 proves you DON'T need specific code details — the relational framing alone drives the behavior change. Abstract accomplishments provide credibility without the token cost of specific stories.

### 2. Integrated narrative beats sectioned format
B2-D (no section headers, accomplishments woven into relationship) outperformed B2-A/B2-C (accomplishments in their own sections). When accomplishments are separated into their own section, agents seem to treat them as "things to live up to" and over-build. When woven into the relationship narrative, they reinforce restraint.

### 3. Growth framing naturally encourages restraint
B2-B's "how we've grown" framing produced the second-best result. Describing the trajectory of learning to simplify seems to activate the same restraint behavior. "We've gotten better at cutting scope" is more behaviorally effective than "We've accomplished great things."

### 4. Milestones framing backfired
B2-A's accomplishment-as-milestones framing produced the worst resume result — even adding YAGNI-violating API endpoints. Listing accomplishments as discrete achievements may trigger a "demonstrate competence" mode that leads to over-building. This mirrors round 1's finding that achievement context (Variation A) had no positive effect.

### 5. The "What is NOT needed" behavior is the clearest signal
Only B2-D produced an explicit section listing what shouldn't be built. This is the behavioral fingerprint of an agent that has internalized the working relationship — it's not just building less, it's actively communicating about scope boundaries.

## Comparison With Round 1

| Round 1 Winner | Round 2 Winner | What Changed |
|----------------|----------------|--------------|
| B (Relational) — specific stories | B2-D (Integrated) — abstract accomplishments | Removed all code specifics |
| 3 files, zero YAGNI | 5 files, zero YAGNI | Both minimal for their scope |
| Referenced preferences by name | Referenced preferences + explicit "not needed" list | B2-D may be even stronger |

## Recommendation

Use B2-D (Integrated) as the template for Identity Resume generation. Key properties:
- Flowing narrative, no section headers separating relationship from accomplishments
- Accomplishments abstract (no version numbers, no file counts, no specific bugs)
- Accomplishments woven into the relationship story, not listed separately
- Working dynamic and learned preferences naturally embedded
- ~250 words / ~350 tokens — very token-efficient
