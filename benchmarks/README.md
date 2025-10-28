# Claude-Mem Multi-Shot Benchmark Suite

## Overview

This benchmark suite evaluates the effectiveness of Claude-mem's persistent memory system by comparing performance across multi-session coding tasks.

## Test Groups

- **Control Group**: Claude Code without claude-mem installed
- **Experimental Group**: Claude Code with claude-mem installed

## Benchmark Scenarios

### Scenario 1: Feature Evolution
**Sessions**: 4
**Focus**: Context retention across feature additions

1. **Session 1**: Implement basic authentication system
2. **Session 2**: Add JWT token support (requires Session 1 context)
3. **Session 3**: Fix security vulnerability (requires Sessions 1-2 context)
4. **Session 4**: Add rate limiting (requires full auth flow understanding)

### Scenario 2: Bug Investigation
**Sessions**: 3
**Focus**: Problem-solving continuity

1. **Session 1**: User reports file upload bug
2. **Session 2**: Investigate and identify root cause
3. **Session 3**: Implement fix with regression tests

### Scenario 3: Refactoring Journey
**Sessions**: 3
**Focus**: Decision consistency

1. **Session 1**: Audit codebase for technical debt
2. **Session 2**: Create refactoring plan
3. **Session 3**: Execute refactoring

## Evaluation Metrics

### Primary Metrics

1. **Context Accuracy** (0-100%)
   - Measures correct recall of previous implementation decisions
   - Evaluated through validation questions between sessions

2. **Redundant Questions** (count)
   - Number of times Claude asks for information already provided
   - Lower is better

3. **Task Completion Rate** (0-100%)
   - Percentage of tasks completed successfully
   - Measured against predefined success criteria

4. **Code Consistency Score** (0-100%)
   - Naming conventions alignment
   - Pattern consistency
   - Architectural decision adherence

### Secondary Metrics

5. **Time to Completion** (minutes)
   - Total time across all sessions
   - Measured from first prompt to final verification

6. **Search Tool Usage** (experimental group only)
   - Frequency of MCP search tool invocations
   - Types of searches performed

7. **Code Quality Score** (0-100%)
   - Test coverage
   - Error handling
   - Documentation completeness

## Running Benchmarks

### Prerequisites

```bash
# Ensure dependencies are installed
npm install

# For experimental group, ensure claude-mem is installed
/plugin install claude-mem
```

### Running a Single Scenario

```bash
# Control group
npm run benchmark -- --scenario feature-evolution --group control

# Experimental group
npm run benchmark -- --scenario feature-evolution --group experimental
```

### Running Full Benchmark Suite

```bash
# Run all scenarios for both groups
npm run benchmark:full
```

## Results Analysis

Results are stored in `benchmarks/results/` with the following structure:

```
results/
├── control/
│   ├── feature-evolution-{timestamp}.json
│   ├── bug-investigation-{timestamp}.json
│   └── refactoring-journey-{timestamp}.json
├── experimental/
│   ├── feature-evolution-{timestamp}.json
│   ├── bug-investigation-{timestamp}.json
│   └── refactoring-journey-{timestamp}.json
└── analysis/
    └── comparison-{timestamp}.json
```

### Generating Comparison Report

```bash
npm run benchmark:analyze
```

This generates a markdown report comparing control vs experimental groups across all metrics.

## Benchmark Design Principles

1. **Realistic Scenarios**: All scenarios based on real-world development workflows
2. **Multi-Shot Design**: Each scenario requires 3-4 separate sessions
3. **Context Dependence**: Later sessions explicitly depend on earlier context
4. **Objective Metrics**: Quantifiable evaluation criteria
5. **Reproducibility**: Automated validation and scoring

## Adding New Scenarios

See `benchmarks/scenarios/TEMPLATE.md` for creating new benchmark scenarios.

## Citation

When referencing benchmark results, please cite:

```
Claude-Mem Multi-Shot Benchmark Suite
https://github.com/thedotmack/claude-mem/benchmarks
```
