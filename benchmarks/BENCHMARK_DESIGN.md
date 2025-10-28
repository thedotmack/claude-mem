# Claude-Mem Benchmark Design: Multi-Session Context Evaluation

## Overview

This benchmark extends established coding benchmarks (SWE-bench, HumanEval) to evaluate **persistent memory across multiple sessions** - a capability unique to systems like Claude-mem.

## Research Context (2025)

### Existing Benchmarks
- **SWE-bench**: Gold standard for software engineering tasks (2294 real GitHub issues)
- **HumanEval/HumanEval+**: 164 programming problems with pass@k metrics
- **AgentBench**: Multi-environment agent evaluation

### Gap in Current Benchmarks
Current benchmarks evaluate **single-session performance**. However, real-world development involves:
- Multiple coding sessions across days/weeks
- Context preservation across session boundaries
- Long-term project knowledge accumulation
- 30+ hour task continuity (as demonstrated by Claude Sonnet 4.5)

**Claude-mem addresses this gap** by providing persistent memory across sessions.

## Benchmark Tiers

### Tier 1: SWE-bench Baseline (Single Session)
**Purpose**: Establish baseline performance on established benchmark

**Method**:
- Select 50 problems from SWE-bench Verified (human-filtered subset)
- Run in single session (standard SWE-bench protocol)
- Measure: % Resolved metric

**Groups**:
- Control: Claude Code without claude-mem
- Experimental: Claude Code with claude-mem

**Expected Result**: Similar performance (no multi-session advantage)

### Tier 2: HumanEval+ Multi-Shot (Sequential Sessions)
**Purpose**: Evaluate context retention across sessions

**Method**:
- Take 50 problems from HumanEval+
- Split each problem into 3 sessions:
  - **Session 1**: Write initial implementation
  - **Session 2** (new session): Add edge case handling (requires remembering Session 1 approach)
  - **Session 3** (new session): Optimize performance (requires understanding previous implementations)

**Metrics**:
- pass@1, pass@5, pass@10 (HumanEval standard)
- Context accuracy: % of times correct approach recalled from previous sessions
- Redundant questions: Count of repeated requests for information

**Expected Result**: Experimental group shows higher pass rates and fewer redundant questions

### Tier 3: Real-World Multi-Session Scenarios
**Purpose**: Evaluate persistent memory in realistic development workflows

**Scenarios**:

#### A. Feature Evolution (4 sessions)
- Session 1: Implement authentication system
- Session 2: Add JWT tokens (context-dependent)
- Session 3: Fix security vulnerability (requires Sessions 1-2 understanding)
- Session 4: Add rate limiting (requires full system understanding)

**Validation**: Predefined test suites for each session

#### B. Bug Investigation (3 sessions)
- Session 1: Reproduce reported bug
- Session 2: Investigate root cause
- Session 3: Implement fix + regression tests

**Validation**: Bug must be fixed, tests must pass, no regressions

#### C. Refactoring Journey (3 sessions)
- Session 1: Audit codebase, document technical debt
- Session 2: Create refactoring plan based on audit
- Session 3: Execute refactoring following plan

**Validation**: Code quality metrics, architectural consistency

### Tier 4: Long-Duration Context Retention
**Purpose**: Test memory persistence over extended periods

**Method**:
- Implement feature across 10 sessions over 5 days
- Each session builds on previous work
- Measure context degradation over time

**Metrics**:
- Session-to-session context accuracy
- Time to re-establish context
- Consistency of implementation patterns

## Evaluation Metrics

### Primary Metrics

1. **Pass@k (HumanEval standard)**
   - pass@1: Probability first solution is correct
   - pass@5: Probability ≥1 of 5 solutions correct
   - pass@10: Probability ≥1 of 10 solutions correct

2. **% Resolved (SWE-bench standard)**
   - Percentage of problems solved correctly

3. **Context Accuracy** (Multi-session specific)
   - Formula: `(Correct Recalls / Total Context Dependencies) × 100`
   - Measured through validation questions between sessions

4. **Redundancy Score** (Multi-session specific)
   - Count of repeated questions for same information
   - Lower is better

### Secondary Metrics

5. **Time to Completion**
   - Total time across all sessions
   - Time to re-establish context per session

6. **Code Consistency Score**
   - Naming convention alignment
   - Architectural pattern adherence
   - Measured via automated linting + human review

7. **Memory System Usage** (Experimental group only)
   - MCP search tool invocations
   - Types of searches performed
   - Search result relevance

## Benchmark Protocol

### Setup Phase
```bash
# Control group
/plugin uninstall claude-mem  # Ensure clean environment

# Experimental group
/plugin install claude-mem
```

### Execution Phase

**For each benchmark problem:**

1. **Session 1**: Start new Claude Code session, present initial prompt
2. **Checkpoint**: Save session state, close Claude Code
3. **Session 2**: Start NEW Claude Code session, present continuation prompt
4. **Repeat**: For multi-session scenarios

**Critical**: Sessions must be separate (restart Claude Code between sessions)

### Validation Phase

- Run test suites
- Calculate metrics
- Human review for quality assessment

## Expected Results

### Hypothesis
Experimental group (with claude-mem) will show:
- ✅ **Higher pass@k rates** in multi-session scenarios (Tier 2-3)
- ✅ **Higher context accuracy** (80%+ vs 40-60%)
- ✅ **Lower redundancy scores** (fewer repeated questions)
- ✅ **Better code consistency** across sessions
- ✅ **Faster completion times** (less context re-establishment)

Control group will match experimental group in:
- ↔️ **Single-session performance** (Tier 1)

### Statistical Significance
- Target: 50+ problems per tier
- Significance level: p < 0.05
- Effect size: Cohen's d ≥ 0.5 (medium effect)

## Integration with Existing Benchmarks

### SWE-bench Integration
```bash
# Clone SWE-bench
git clone https://github.com/SWE-bench/SWE-bench
cd SWE-bench

# Install dependencies
pip install -e .

# Export 50 problems from SWE-bench Verified
python export_subset.py --subset verified --count 50 --output ../claude-mem/benchmarks/scenarios/swe-bench-subset.json
```

### HumanEval+ Integration
```bash
# Clone HumanEval
git clone https://github.com/openai/human-eval
cd human-eval

# Install dependencies
pip install -e .

# Export problems for multi-shot extension
python export_problems.py --count 50 --output ../claude-mem/benchmarks/scenarios/humaneval-subset.json
```

## Reproducibility

### Environment
- Claude Code version: Latest stable
- Node.js: 18+
- Claude model: claude-sonnet-4-5 (consistent across control/experimental)
- Session restart delay: 10 seconds between sessions

### Random Seed
- Use deterministic random seed for problem selection
- Document seed in results for reproducibility

### Human Review
- 10% of results undergo blind human review
- Inter-rater reliability: κ ≥ 0.7

## Limitations

1. **SWE-bench data quality**: 32.67% of successful patches involve "cheating" (solutions in issue comments)
2. **HumanEval scope**: Limited to 164 problems, may not cover all coding scenarios
3. **Evaluation cost**: Multi-session benchmarks are more expensive (time, compute)
4. **Subjectivity**: Some metrics (code quality) require human judgment

## Future Extensions

1. **Multi-modal scenarios**: Incorporate SWE-bench Multimodal (visual debugging)
2. **Cross-project memory**: Test context transfer between related projects
3. **Collaborative scenarios**: Multi-agent sessions with shared memory
4. **Long-term studies**: Track memory effectiveness over weeks/months

## Citation

```bibtex
@misc{claudemem2025benchmark,
  title={Claude-Mem Multi-Session Benchmark: Evaluating Persistent Memory in Coding Agents},
  author={Newman, Alex},
  year={2025},
  url={https://github.com/thedotmack/claude-mem/benchmarks}
}
```

## References

- [SWE-bench](https://www.swebench.com/)
- [HumanEval](https://github.com/openai/human-eval)
- [AgentBench](https://github.com/THUDM/AgentBench)
- [AI Agent Benchmarks 2025](https://www.evidentlyai.com/blog/ai-agent-benchmarks)
