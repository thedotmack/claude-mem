# Token Velocity Study

Measures how token consumption changes over successive Claude Code sessions within a project, and whether claude-mem's persistent memory reduces redundant context.

## Scripts

### 1. Extract metrics from local sessions

```bash
python3 velocity-study/extract.py
```

Scans `~/.claude/projects/` for session JSONL files, cross-references with the claude-mem database, and writes `velocity-study/metrics.csv`.

### 2. Generate plots

```bash
uv run --with matplotlib velocity-study/plot.py
```

Produces `results/token_trajectory.png`, `results/context_utilization.png`, and `results/cumulative_tokens.png`.

### 3. Cost analysis

```bash
uv run --with matplotlib velocity-study/cost_analysis.py
```

Applies Claude API pricing and writes `results/cost_summary.txt` and `results/cost_trajectory.png`.

### 4. Anonymize and export for sharing

```bash
python3 velocity-study/share_data.py
```

Reads `metrics.csv`, strips all identifying information, and writes `velocity-data.json`.

## Sharing your data

1. Run `share_data.py` (see above)
2. Review `velocity-data.json` to confirm you are comfortable sharing it
3. Submit by pasting the contents into the GitHub Discussion thread or emailing it to the study coordinator

## Privacy

**Collected** (anonymized):
- Sequence number, model name, total API tokens, context utilization
- Observation count bucket (0, 1-10, 10-50, 50+), has_claude_mem flag
- SHA256 hash of project ID and hostname (not reversible)

**Never collected**:
- Project names, session IDs, file paths, message content, dates, exact observation counts
