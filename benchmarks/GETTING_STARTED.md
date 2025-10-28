# Getting Started with Claude-Mem Benchmarks

## What Are These Benchmarks?

The Claude-Mem benchmark suite evaluates **persistent memory across multiple coding sessions**. Unlike traditional benchmarks that test single-session performance, these benchmarks measure how well AI assistants maintain context when sessions are interrupted and resumed.

## Why This Matters

Real-world development happens across multiple sessions:
- You implement a feature on Monday
- You debug it on Tuesday (new session)
- You optimize it on Wednesday (another new session)

Without persistent memory, each new session starts from scratch. Claude-mem solves this by preserving context across session boundaries.

## The Challenge

Most AI coding assistants excel at single-session tasks but struggle when sessions are separated:
- ❌ Forgetting implementation details
- ❌ Asking the same questions repeatedly
- ❌ Inconsistent architectural decisions
- ❌ Unable to reference previous work

Claude-mem addresses these issues with persistent memory.

## Quick Demo

### 5-Minute Quick Test

```bash
# 1. Clone and setup
git clone https://github.com/thedotmack/claude-mem
cd claude-mem
npm install

# 2. Run authentication benchmark (experimental group)
npm run benchmark:auth experimental
```

This runs a 4-session scenario where each session builds on the previous one:
1. Build basic authentication
2. Add JWT tokens (requires remembering Session 1)
3. Fix security bug (requires understanding Sessions 1-2)
4. Add rate limiting (requires knowing entire system)

### What You'll See

**Session 1**: You'll implement basic auth
**Session 2**: The benchmark shows context dependencies and asks Claude to extend the auth system
**Validation**: You'll be asked questions about Session 1 to measure context retention

Example validation question:
```
Q: What hashing algorithm is used for passwords?
Expected: bcrypt
```

**With claude-mem**: Claude remembers it's bcrypt (from Session 1)
**Without claude-mem**: Claude might guess or ask you again

## Understanding the Results

After running, you'll see metrics:

```
Context Accuracy: 88.3%
```
Claude correctly answered 88.3% of questions about previous sessions

```
Redundancy Count: 0
```
Claude didn't ask for information already provided

```
Resolved: 100%
```
All tasks completed successfully

## Running Your First Complete Benchmark

### Prerequisites

- Node.js 18+
- Claude Code installed
- 1-2 hours of time

### Step 1: Run Experimental Group

```bash
# Ensure claude-mem is installed
/plugin install claude-mem

# Run benchmark
npm run benchmark:auth experimental
```

**During the benchmark**:
- Work naturally with Claude Code
- Don't manually provide context - let the memory system work
- Answer validation questions honestly

### Step 2: Run Control Group

```bash
# Uninstall claude-mem
/plugin uninstall claude-mem

# Run same benchmark
npm run benchmark:auth control
```

**Important**: Start fresh! Restart Claude Code completely.

### Step 3: Compare Results

```bash
npm run benchmark:analyze
```

You'll see side-by-side comparison:

```
Control Group (without claude-mem):
  Context Accuracy: 62.50%
  Avg Time: 48.20 minutes
  Redundancy: 3.67

Experimental Group (with claude-mem):
  Context Accuracy: 88.33%
  Avg Time: 41.50 minutes
  Redundancy: 0.67

Improvements:
  ↑ Context Accuracy: +25.83%
  ↑ Time Saved: +13.91%
  ↑ Redundancy Reduction: +3.00
```

## What the Metrics Mean

### Context Accuracy (Most Important)
**What it measures**: Can Claude remember details from previous sessions?
**How**: Validation questions between sessions
**Good score**: >80%

Example:
- Session 1: You build auth with bcrypt
- Session 2: Claude is asked "What hashing algorithm is used?"
- Correct answer = point earned

### Redundancy Count
**What it measures**: Does Claude ask the same questions repeatedly?
**How**: Manual tracking during sessions
**Good score**: 0-2

### Time to Completion
**What it measures**: How long did all sessions take?
**Why it matters**: Better context = less time re-establishing understanding

### Resolution Rate
**What it measures**: Did you complete all tasks successfully?
**Good score**: 100%

## Available Scenarios

### 1. Authentication Evolution (Medium, 45 min)
**Best for**: Testing context retention across feature additions
**Sessions**: 4 (Basic auth → JWT → Security fix → Rate limiting)
**Run**: `npm run benchmark:auth <group>`

### 2. Bug Investigation (Medium, 30 min)
**Best for**: Testing problem-solving continuity
**Sessions**: 3 (Reproduce → Investigate → Fix)
**Run**: `npm run benchmark:bug <group>`

## Best Practices

### For Accurate Results

✅ **Do**:
- Run each scenario 3+ times per group
- Actually restart Claude Code between sessions
- Let Claude work naturally (don't help with context)
- Record honest answers to validation questions

❌ **Don't**:
- Run control and experimental back-to-back without restart
- Manually provide context that should come from memory
- Cherry-pick successful runs
- Edit code manually

### For Faster Results

Start with just **one run per group**:
```bash
# Quick test (1-2 hours total)
npm run benchmark:auth experimental  # ~45 min
npm run benchmark:auth control       # ~45 min
npm run benchmark:analyze
```

Then expand to multiple runs for statistical significance.

## Common Questions

### Q: Why manual execution?
**A**: Automated evaluation would require simulating Claude's responses, which defeats the purpose. We want to measure real Claude Code behavior.

### Q: How many runs do I need?
**A**:
- Quick test: 1 run per group
- Reliable results: 3 runs per group
- Publication-quality: 10+ runs per group

### Q: Can I automate the validation questions?
**A**: The runner shows the expected answers, but you need to check what Claude actually said. This is inherently manual.

### Q: What if Claude doesn't explicitly state an answer?
**A**: Press ENTER to skip that validation question. It's okay - we're measuring what Claude naturally does.

### Q: Do I need both groups?
**A**: For comparison, yes. But you can run just experimental group to see how well claude-mem performs.

## Next Steps

1. **Run your first benchmark**: `npm run benchmark:auth experimental`
2. **Read the full usage guide**: [USAGE.md](USAGE.md)
3. **Understand the design**: [BENCHMARK_DESIGN.md](BENCHMARK_DESIGN.md)
4. **Create custom scenarios**: [scenarios/SCHEMA.md](scenarios/SCHEMA.md)

## Troubleshooting

### Claude doesn't remember context (experimental group)
- Check if claude-mem is installed: `/plugin list`
- Check worker is running: `pm2 list`
- View logs: `npm run worker:logs`

### Benchmark runner isn't responding
- Make sure you press ENTER after completing each session
- Check console for prompts

### Results seem inconsistent
- This is normal - LLMs have inherent variability
- Run multiple iterations (3-5) for more stable results
- Statistical analysis helps (see USAGE.md)

## Get Help

- **Issues**: https://github.com/thedotmack/claude-mem/issues
- **Discussions**: https://github.com/thedotmack/claude-mem/discussions
- **Full Documentation**: [README.md](README.md)

## Contributing

Found ways to improve the benchmarks? We'd love contributions:
- New scenarios
- Better metrics
- Analysis tools
- Documentation improvements

See [USAGE.md](USAGE.md) for contribution guidelines.
