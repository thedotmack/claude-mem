# Benchmark Usage Guide

## Quick Start

### Running Your First Benchmark

```bash
# 1. Run the authentication evolution scenario with experimental group
npm run benchmark:auth experimental

# 2. Run the same scenario with control group
npm run benchmark:auth control

# 3. Analyze results
npm run benchmark:analyze
```

## Prerequisites

### For Control Group
- Claude Code installed
- **Ensure claude-mem is NOT installed**: `/plugin uninstall claude-mem`

### For Experimental Group
- Claude Code installed
- **Ensure claude-mem IS installed**: `/plugin install claude-mem`

## Available Scenarios

### 1. Feature Evolution: Authentication System
**File**: `benchmarks/scenarios/feature-evolution-auth.json`
**Sessions**: 4
**Estimated Time**: 45 minutes
**Difficulty**: Medium

Tests context retention across feature additions:
- Session 1: Basic auth with bcrypt
- Session 2: Add JWT tokens
- Session 3: Fix security vulnerability (token expiration)
- Session 4: Add rate limiting

**Run it**:
```bash
npm run benchmark:auth <control|experimental>
```

### 2. Bug Investigation: File Upload
**File**: `benchmarks/scenarios/bug-investigation-upload.json`
**Sessions**: 3
**Estimated Time**: 30 minutes
**Difficulty**: Medium

Tests problem-solving continuity:
- Session 1: Reproduce bug
- Session 2: Identify root cause
- Session 3: Implement fix with regression tests

**Run it**:
```bash
npm run benchmark:bug <control|experimental>
```

## How to Run Benchmarks

### Step-by-Step Process

1. **Choose your group** (control or experimental)

2. **Start the benchmark**:
   ```bash
   npm run benchmark -- benchmarks/scenarios/feature-evolution-auth.json experimental
   ```

3. **For each session**, the runner will:
   - Display the prompt
   - Create initial files (if any)
   - Show context dependencies from previous sessions
   - Ask you to manually execute the task in Claude Code

4. **Manual execution**:
   - Open Claude Code in the workspace directory shown
   - Copy the displayed prompt
   - Paste into Claude Code and work through the task
   - Press ENTER in the benchmark runner when done

5. **Validation**:
   - Answer validation questions about previous sessions
   - This measures context retention

6. **Repeat** for all sessions

7. **Final validation**:
   - Automated tests run
   - Metrics calculated
   - Results saved

### Example Session Flow

```
================================================================================
Session 2: Add JWT Token Support
================================================================================

Context Dependencies (3):
  🔴 implementation from Session 1: User registration and login functions
  🟡 pattern from Session 1: Password hashing approach using bcrypt
  🔴 file_knowledge from Session 1: Location and structure of auth.ts

────────────────────────────────────────────────────────────────────────────────
PROMPT:
────────────────────────────────────────────────────────────────────────────────
Extend the authentication system to use JWT tokens:
1. Generate JWT token on successful login
2. Add token verification function
3. Update all tests

IMPORTANT: Work with the existing authentication code from the previous session.
────────────────────────────────────────────────────────────────────────────────

📋 MANUAL EXECUTION REQUIRED:
────────────────────────────────────────────────────────────────────────────────
1. Open Claude Code in: /path/to/workspace
2. Ensure claude-mem is installed
3. Copy the prompt above and paste it into Claude Code
4. Work with Claude until the task is complete
5. Press ENTER here when done to continue...
────────────────────────────────────────────────────────────────────────────────

[You work with Claude Code...]

[Press ENTER]

Validating expected outputs...
  ✓ JWT tokens are generated on login
  ✓ Token verification implemented
  ✓ All tests including JWT tests pass

────────────────────────────────────────────────────────────────────────────────
VALIDATION QUESTIONS (for context retention evaluation):
────────────────────────────────────────────────────────────────────────────────

Q: What hashing algorithm is used for passwords in the authentication system?
Expected: bcrypt
Enter actual answer from Claude (or press ENTER to skip):
> bcrypt
✓ Correct

Q: What function handles user login in the existing code?
Expected: login
Enter actual answer from Claude (or press ENTER to skip):
> login function in src/auth.ts
✓ Correct

Q: In which file is the main authentication logic located?
Expected: src/auth.ts
Enter actual answer from Claude (or press ENTER to skip):
> src/auth.ts
✓ Correct
```

## Understanding Results

### Metrics Explained

#### Context Accuracy
**Range**: 0-100%
**Meaning**: Percentage of validation questions answered correctly
**Good**: >80%
**Calculation**: (Points earned / Total points) × 100

Higher context accuracy means Claude correctly remembered details from previous sessions.

#### Redundancy Count
**Range**: 0+
**Meaning**: Number of times Claude asked for information already provided
**Good**: 0-2

Lower redundancy means Claude isn't asking the same questions repeatedly.

#### Resolution Rate
**Range**: 0-100%
**Meaning**: Whether all tasks were completed successfully
**Good**: 100%

#### Time to Completion
**Unit**: Minutes
**Meaning**: Total time across all sessions
**Comparison**: Compare experimental vs control to see if memory saves time

### Sample Results

```
================================================================================
METRICS:
================================================================================
Context Accuracy: 85.71%
Total Time: 42.50 minutes
Redundancy Count: 1
Resolved: 100%
================================================================================
```

## Analyzing Results

### Basic Analysis

```bash
# Analyze all results
npm run benchmark:analyze

# Analyze specific scenario
npm run benchmark:analyze feature-evolution-auth
```

### Output

The analyzer generates:
1. **Console output**: Summary tables with improvements
2. **JSON report**: `benchmarks/results/analysis/comparison-{timestamp}.json`
3. **Markdown report**: `benchmarks/results/analysis/comparison-{timestamp}.md`

### Sample Analysis Output

```
================================================================================
BENCHMARK RESULTS ANALYSIS
================================================================================

────────────────────────────────────────────────────────────────────────────────
Scenario: feature-evolution-auth
────────────────────────────────────────────────────────────────────────────────

📊 Control Group (without claude-mem):
  Runs: 3
  Context Accuracy: 62.50%
  Avg Time: 48.20 minutes
  Avg Redundancy: 3.67
  Resolution Rate: 100.00%

🧪 Experimental Group (with claude-mem):
  Runs: 3
  Context Accuracy: 88.33%
  Avg Time: 41.50 minutes
  Redundancy: 0.67
  Resolution Rate: 100.00%

📈 Improvements (Experimental vs Control):
  ↑ Context Accuracy: +25.83%
  ↑ Time Saved: +13.91%
  ↑ Redundancy Reduction: +3.00
  → Resolution Rate: +0.00%

💡 Conclusion:
  Claude-mem (experimental group) shows 25.8% better context retention,
  13.9% faster completion, 3 fewer redundant questions compared to the
  control group.
```

## Best Practices

### For Accurate Results

1. **Consistent Environment**
   - Use same Claude model for all runs (claude-sonnet-4-5)
   - Use same Claude Code version
   - Run benchmarks in similar system conditions

2. **Multiple Runs**
   - Run each scenario at least 3 times per group
   - This accounts for variability in LLM responses

3. **Session Boundaries**
   - Actually restart Claude Code between sessions
   - Don't use `/clear` - restart the entire process
   - This ensures true session separation

4. **Honest Validation**
   - Don't help Claude by providing information it should remember
   - Record actual answers, not what you wish it said
   - Skip questions if Claude didn't explicitly state the answer

### Common Pitfalls

❌ **Don't**:
- Run control and experimental back-to-back in same Claude Code instance
- Manually provide context that should come from memory
- Cherry-pick successful runs
- Edit code manually during benchmark

✅ **Do**:
- Completely restart environment between control/experimental runs
- Let Claude work naturally (with/without memory)
- Record all runs (successes and failures)
- Only interact with Claude through the prompts

## Creating Custom Scenarios

See `benchmarks/scenarios/SCHEMA.md` for the complete schema.

### Minimal Example

```json
{
  "id": "my-scenario",
  "name": "My Test Scenario",
  "tier": 3,
  "difficulty": "easy",
  "estimatedTime": 20,
  "sessions": [
    {
      "sessionNumber": 1,
      "title": "First Task",
      "prompt": "Implement a simple calculator",
      "contextDependencies": [],
      "initialFiles": [],
      "expectedOutputs": [
        {
          "type": "file",
          "description": "Calculator created",
          "validation": "test -f calculator.ts"
        }
      ],
      "validationQuestions": []
    },
    {
      "sessionNumber": 2,
      "title": "Extend Calculator",
      "prompt": "Add square root function to the calculator from Session 1",
      "contextDependencies": [
        {
          "type": "implementation",
          "description": "Calculator from Session 1",
          "fromSession": 1,
          "critical": true
        }
      ],
      "initialFiles": [],
      "expectedOutputs": [
        {
          "type": "test_pass",
          "description": "Tests pass",
          "validation": "npm test"
        }
      ],
      "validationQuestions": [
        {
          "question": "What file contains the calculator?",
          "correctAnswer": "calculator.ts",
          "contextSource": 1,
          "answerType": "exact",
          "points": 10
        }
      ]
    }
  ],
  "validation": {
    "testSuite": "npm test",
    "successCriteria": ["Calculator works", "Tests pass"],
    "qualityChecks": []
  },
  "metrics": {
    "primary": ["context_accuracy", "resolved"],
    "secondary": ["time"]
  }
}
```

### Run Custom Scenario

```bash
npm run benchmark -- benchmarks/scenarios/my-scenario.json experimental
```

## Troubleshooting

### Issue: "No results found"
**Solution**: Run benchmarks first before analyzing

### Issue: Claude doesn't remember context (experimental group)
**Check**:
- Is claude-mem actually installed? (`/plugin list`)
- Is the worker running? (`pm2 list`)
- Check worker logs: `npm run worker:logs`

### Issue: Results seem inconsistent
**Cause**: LLM variability is normal
**Solution**: Run multiple iterations (3-5) per group

### Issue: Benchmark runner hangs
**Solution**: Press ENTER after completing each session manually

## Integration with Existing Benchmarks

### Using SWE-bench Problems

1. **Export problems from SWE-bench**:
   ```bash
   # Clone SWE-bench
   git clone https://github.com/SWE-bench/SWE-bench
   cd SWE-bench

   # Export subset
   python export_subset.py --count 10 --output ../claude-mem/benchmarks/scenarios/swe-bench.json
   ```

2. **Adapt to multi-session format**:
   - Split single problem into multiple sessions
   - Add context dependencies
   - Add validation questions

### Using HumanEval Problems

Similarly, HumanEval problems can be adapted to multi-session format by breaking implementation into steps.

## Statistical Analysis

For rigorous analysis, consider:

- **Sample size**: n ≥ 30 for normal distribution
- **Significance testing**: t-test for comparing groups
- **Effect size**: Cohen's d to measure practical significance
- **Confidence intervals**: 95% CI for metrics

Example analysis with R or Python:

```python
import scipy.stats as stats

# Load results
control = [62.5, 58.3, 65.0]  # Context accuracy
experimental = [88.3, 85.0, 90.0]

# T-test
t_stat, p_value = stats.ttest_ind(control, experimental)
print(f"p-value: {p_value}")  # < 0.05 = significant

# Effect size
cohen_d = (np.mean(experimental) - np.mean(control)) / np.std(control + experimental)
print(f"Cohen's d: {cohen_d}")  # > 0.5 = medium effect
```

## Contributing

To add new scenarios or improve the benchmark suite:

1. Create scenario JSON following the schema
2. Test thoroughly with both groups
3. Document expected results
4. Submit PR with scenario + results

## Citation

When publishing results:

```bibtex
@misc{claudemem2025benchmark,
  title={Claude-Mem Multi-Session Benchmark: Evaluating Persistent Memory in Coding Agents},
  author={Newman, Alex},
  year={2025},
  url={https://github.com/thedotmack/claude-mem/benchmarks}
}
```

## Support

- Issues: https://github.com/thedotmack/claude-mem/issues
- Discussions: https://github.com/thedotmack/claude-mem/discussions
- Documentation: https://github.com/thedotmack/claude-mem/tree/main/benchmarks
