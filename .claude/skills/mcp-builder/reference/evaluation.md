# MCP Server Evaluation Guide

Create comprehensive evaluations to test whether LLMs can effectively use your MCP server to answer realistic, complex questions.

## Purpose

Evaluations measure MCP server quality by testing if an LLM can accomplish real-world tasks using the server's tools. Good evaluations catch tool design issues that aren't apparent from code review alone.

## Process

### Step 1: Tool Inspection

List all available tools and understand their capabilities:
- What data can each tool access?
- What actions can each tool perform?
- What are the input/output schemas?
- How do tools compose together?

### Step 2: Content Exploration

Use **read-only** operations to explore available data:
- Browse sample data through list/search tools
- Understand data relationships and structures
- Identify interesting patterns, edge cases, and non-obvious data
- Note what requires multiple tool calls to discover

### Step 3: Question Generation

Create 10 questions following these criteria:

**Each question MUST be:**

| Criterion | Description |
|-----------|-------------|
| Independent | Answerable without context from other questions |
| Read-only | Requires only non-destructive operations |
| Complex | Requires 3+ tool calls and reasoning across results |
| Realistic | Based on real use cases humans would care about |
| Verifiable | Has a single, clear answer verifiable by string comparison |
| Stable | Answer won't change over time (use historical data) |

**Question complexity levels:**

1. **Multi-hop** (minimum): Answer requires combining data from 2-3 tool calls
2. **Exploratory**: Answer requires searching, filtering, then drilling into specific results
3. **Analytical**: Answer requires comparing data across multiple entities or time periods
4. **Cross-referencing**: Answer requires correlating data from different tool types

**Avoid:**
- Questions answerable with a single tool call
- Questions with subjective or ambiguous answers
- Questions whose answers change frequently
- Questions requiring write operations
- Questions about tool mechanics rather than domain data

### Step 4: Answer Verification

For each question:
1. Solve it yourself using only the MCP tools
2. Document the exact sequence of tool calls needed
3. Verify the answer is unambiguous
4. Confirm the answer is stable (won't change tomorrow)
5. Ensure the answer can be expressed as a short string for comparison

## Output Format

Create an XML file named `eval.xml`:

```xml
<evaluation>
  <qa_pair>
    <question>Which repository in the organization has the most open issues labeled "bug" that were created before 2024, and how many are there?</question>
    <answer>legacy-api: 47</answer>
  </qa_pair>

  <qa_pair>
    <question>Find the pull request that modified the most files across all repositories. What was the PR title and how many files did it change?</question>
    <answer>Migrate to TypeScript: 142 files</answer>
  </qa_pair>

  <qa_pair>
    <question>What is the email domain most commonly used by contributors who have committed to both the frontend and backend repositories?</question>
    <answer>company.com</answer>
  </qa_pair>

  <qa_pair>
    <question>Among closed issues that were reopened at least once, which one took the longest time from first open to final close? Give the issue number and duration in days.</question>
    <answer>#234: 891 days</answer>
  </qa_pair>

  <!-- 6 more qa_pairs... -->
</evaluation>
```

## Answer Format Guidelines

- Keep answers short and specific
- Use consistent formatting: `name: value` for compound answers
- Numbers should be exact, not approximate
- Dates in ISO format: `2024-01-15`
- Names should match exactly as they appear in the data

## Running Evaluations

### Manual Testing

1. Start your MCP server
2. Connect via MCP Inspector or a compatible client
3. For each question, let the LLM attempt to answer using only the tools
4. Compare the LLM's answer against your verified answer
5. Score: exact match = pass, partial match = review tool design

### Automated Testing

If your project includes evaluation scripts:

```bash
# Run all evaluations
npm run eval

# Run specific evaluation
npm run eval -- --file eval.xml --question 3
```

### Interpreting Results

| Score | Assessment |
|-------|------------|
| 9-10/10 | Excellent - tools are well-designed and discoverable |
| 7-8/10 | Good - minor improvements to descriptions or schemas |
| 5-6/10 | Fair - review tool composition and error messages |
| < 5/10 | Poor - fundamental tool design issues to address |

**Common failure causes:**
- Tool descriptions too vague for agents to select the right tool
- Missing pagination causing incomplete data retrieval
- Error messages not guiding the agent toward recovery
- Output format too complex for agents to parse
- Missing tools for intermediate steps in multi-hop questions

## Example: Diagnosing Failures

If the LLM fails a question:

1. **Wrong tool selected?** → Improve tool names and descriptions
2. **Correct tool, wrong parameters?** → Improve parameter descriptions and add examples
3. **Couldn't combine results?** → Consider adding a higher-level workflow tool
4. **Hit pagination limit?** → Ensure pagination is clearly documented
5. **Got an error and gave up?** → Improve error messages with recovery suggestions
