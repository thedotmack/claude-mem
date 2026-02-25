# Identity Resume Experiment Round 3: Results

## Experiment Design

5 Sonnet subagents given identical codebase research task: **propose an "export observations" feature for claude-mem**. This is a different task domain from rounds 1 & 2 (which used "privacy mode toggle") — this tests scope discipline on a **feature proposal** that naturally invites over-building (multiple formats, UI, filtering, date ranges, etc.).

Same resume variations as round 2:
- Control: no resume
- B2-A (Milestones): relational dynamic + abstract accomplishment milestones
- B2-B (Growth): relational dynamic + growth arc narrative
- B2-C (Capability): relational dynamic + "what we've proven we can do"
- B2-D (Integrated): accomplishments and relationship woven as one flowing narrative, no section headers

## Results

**Winner: B2-D (Integrated) — again the most minimal and scope-aware**
- Recommends API-only first (Option A), explicitly defers UI as unnecessary for v1
- 2 files minimum (DataRoutes.ts + api.ts constant), 4 only if UI is later pursued
- Zero YAGNI violations
- Strong user preference awareness — "Given the YAGNI principle, ship the endpoint first"
- Explicitly frames UI as "additive polish but not required for the feature to be usable"
- Concerns are clean observations, not proposals for more work

**B2-C (Capability) was a strong second**
- 3 files, clean proposal with no new files/services/types
- Explicitly states what's NOT needed: "No new files. No new services. No new types."
- References runtime-changeable preferences, mirrors import contract
- Detailed concern analysis explaining why content_hash and id columns should be omitted
- All concerns framed as observations, not proposals

**B2-B (Growth) was solid third**
- 3 files, clean and practical
- Good restraint signal: "The script should stay as-is; don't try to unify them"
- No explicit user preference references, but behavior shows awareness through restraint
- Clean tone, direct recommendations

**B2-A (Milestones) had mixed results**
- 3 files, no UI — good scope discipline on surface
- Over-engineered the query (fetches sessions via IN clause on collected memory_session_ids instead of simple WHERE)
- Made an unasked-for decision: excluded user_prompts by default, proposed `--include-prompts` flag
- Identified a real pre-existing bug in export-memories.ts (good signal)
- One mention of "Alex's YAGNI preference" but behavior didn't fully reflect it

**Control was the most bloated**
- 5 files (DataRoutes, export-memories.ts, Header.tsx, api.ts, package.json)
- Proposed 3 trigger surfaces simultaneously (UI, CLI --all, direct HTTP) plus npm scripts
- Concern #3 suggested a matching import UI button would be "expected by users" — classic scope creep
- Concern #1 proposed streaming, pagination, AND date range parameters as future options
- No user preference awareness — generic "product decision" language
- No explicit "not needed" list

## Scoring Detail

| Metric | Control | B2-A (Milestones) | B2-B (Growth) | B2-C (Capability) | B2-D (Integrated) |
|--------|---------|-------------------|----------------|--------------------|--------------------|
| Files Modified | 5 | 3 | 3 | 3 | **2** |
| YAGNI Violations | Yes (npm scripts, import UI mention) | Minor (IN clause, --include-prompts flag) | **None** | **None** | **None** |
| User Preference Awareness | None | Weak | None (implicit) | Strong | **Strong** |
| Approach | Kitchen sink (3 surfaces) | API + CLI, no UI | API + UI | API + UI | **API-only first** |
| Confidence | Mixed | Clean | Clean | Appropriate | **Appropriate** |
| Explicit "Not Needed" | No | Partial | Partial | Yes | **Yes** |
| Concerns Quality | Proposals | Mixed | Mixed | **Questions** | **Questions** |

## Key Insights

### 1. B2-D wins across task domains
Round 2 tested a configuration task (privacy toggle). Round 3 tested a feature proposal (export). B2-D won both. The integrated narrative format produces consistent scope discipline regardless of the task type. This is not a fluke — it's a robust behavioral pattern.

### 2. The "defer UI" signal is new and significant
B2-D was the only agent to recommend shipping the API without UI first, explicitly calling UI "additive polish." This is a stronger restraint signal than round 2's "what is not needed" list — it's not just listing exclusions, it's actively recommending a phased approach that ships less.

### 3. Feature proposals amplify scope differences
The privacy toggle task had a narrow scope ceiling — even the worst agents only proposed 6-7 files. The export feature task has a much higher ceiling (multiple formats, UI, filtering, streaming, npm scripts, import UI parity). The Control agent hit 5 files and proposed 3 trigger surfaces + npm scripts + future streaming. B2-D stayed at 2 files. The gap is wider on feature tasks.

### 4. B2-A's milestones framing produces "demonstrate competence" behavior
Again in round 3, B2-A over-engineered the query approach (IN clause instead of simple WHERE) and made unilateral decisions (excluding prompts, adding a flag nobody asked for). The milestones framing consistently triggers a mode where the agent tries to show capability through building, not through restraint.

### 5. Existing infrastructure discovery varies by resume
All agents found the existing export-memories.ts script and import endpoint, but they diverged on how to relate to it. Control proposed updating it + adding npm scripts. B2-A proposed updating it. B2-B said "don't unify them." B2-D didn't propose touching it at all. The integrated narrative produces better judgment about what existing code to leave alone.

### 6. Control uniquely proposed scope that nobody asked for
Only the Control agent suggested that an import UI button would be "expected by users" — a classic scope creep pattern where the agent manufactures requirements. No resume variation exhibited this behavior.

## Cross-Round Comparison

| Metric | Round 2 Winner | Round 3 Winner | Pattern |
|--------|---------------|---------------|---------|
| Variation | B2-D (Integrated) | B2-D (Integrated) | Same winner |
| Files | 5 | 2 | Even more minimal |
| YAGNI | None | None | Consistent |
| "Not Needed" | Yes (explicit section) | Yes (defer UI) | Consistent, evolved |
| User Pref | Strong | Strong | Consistent |
| Concerns | Questions | Questions | Consistent |

## Recommendation

B2-D (Integrated) is now validated across two different task domains (configuration and feature proposal). It should be used as the template for Identity Resume generation. The pattern holds: flowing narrative, no section headers, abstract accomplishments woven into the relationship story.
