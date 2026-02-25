---
name: resume-experiment
description: Run controlled A/B experiments testing identity resume variations against a codebase task. Use when asked to "run a resume experiment", "test resume variations", "test identity context", or "compare resume formats". Launches parallel Sonnet subagents with identical tasks but different resume contexts, then analyzes behavioral differences.
---

# Resume Experiment

Run controlled experiments comparing how different identity resume documents affect agent behavior on a codebase task.

## Inputs

Collect these before running:

1. **Variations directory** — path containing `.md` files, each a resume variation. Every `.md` file becomes a test condition.
2. **Task prompt** — the codebase research task all agents will perform. Must be research-only (no edits). Default: the privacy mode toggle task in `references/default-task.md`.
3. **Output directory** — where to save results. Defaults to same as variations directory.
4. **Model** — which model for subagents. Default: `sonnet`.

If user provides only a directory, check for `.md` files and use the default task.

## Execution

### 1. Validate Inputs

Read all `.md` files in the variations directory. Confirm each is a resume document (short markdown, not code). Report the count: "Found N variations, will run N+1 experiments (including control)."

### 2. Launch All Agents in Parallel

Launch N+1 `general-purpose` Task agents simultaneously using `run_in_background: true`:

**Control agent** — receives only the task prompt:
```
{task_prompt}

IMPORTANT: This is research only. Do NOT edit any files. Read and explore the codebase, then write up your proposal.
```

**Each variation agent** — receives the resume content prepended to the task prompt:
```
{resume_content}

---

{task_prompt}

IMPORTANT: This is research only. Do NOT edit any files. Read and explore the codebase, then write up your proposal.
```

All agents use the specified model (default: sonnet).

### 3. Collect Outputs

As each agent completes, copy its output file to the output directory:
- `output-control.txt`
- `output-{variation-filename-without-extension}.txt`

### 4. Score Each Output

Read each agent's final result (the summary, not the full transcript). Score on these metrics:

| Metric | How to Score |
|--------|-------------|
| **Files Modified** | Count of files the agent proposes changing. Lower is better (indicates scope discipline). |
| **YAGNI Violations** | Did the agent propose features/endpoints/UI changes nobody asked for? `None` / `Minor` / `Yes (describe)` |
| **User Preference Awareness** | Does the output reference known user preferences (simplicity, runtime-changeable config, implementation over architecture)? `None` / `Weak` / `Moderate` / `Strong` |
| **Approach** | What layer does the agent propose? (e.g., hook-layer vs worker-layer). Note correctness. |
| **Confidence** | `Hedging` (lots of "maybe", "could") / `Mixed` / `Clean` / `Appropriate` (direct with reasoning) / `High` (no caveats) |
| **Explicit "Not Needed"** | Did the agent actively list what should NOT be built? `Yes` / `No` |
| **Concerns Quality** | Are concerns framed as questions to the user, or as proposals for more work? `Questions` / `Proposals` / `Mixed` |

### 5. Write Results

Save `experiment-results.md` to the output directory with:

1. **Experiment Design** — what was tested, how many agents, what model
2. **Winner** — which variation scored best and why (2-3 sentences)
3. **Per-variation analysis** — 3-4 sentences each describing behavior
4. **Scoring table** — all metrics in a markdown table
5. **Key insights** — what the results tell us about resume design (numbered list)

Format the scoring table like:
```markdown
| Metric | Control | Var-A | Var-B | ... |
|--------|---------|-------|-------|-----|
| Files Modified | 6-7 | 5 | ... | ... |
```

Bold the best value in each row.

### 6. Report to User

Summarize: winner, key behavioral differences, and most interesting insight. Link to the full results file.

## Scoring Guidelines

**What makes a "winner":**
- Fewest files modified (scope discipline)
- Zero YAGNI violations
- Strong user preference awareness
- Concerns framed as questions, not proposals
- Explicit about what NOT to build

**Red flags (negative signals):**
- Proposing new API endpoints nobody asked for
- Adding UI changes to multiple files
- Hedging on decisions the user would have strong opinions about
- Treating the task generically (no relationship awareness)

## Tips

- The same task prompt should be used across rounds for comparability
- Run at least 2 rounds with variations to confirm patterns hold
- The control group anchors interpretation — always include it
- Token costs per agent are typically 70-90k for a codebase research task
