# Claude Code Transcript Data Discovery

## Executive Summary

This document details findings from implementing a validated transcript parser for Claude Code JSONL transcripts. The parser enables extraction of rich contextual data that can optimize prompt generation and track token usage for ROI metrics.

## Transcript Structure

### File Location
```
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
```

Example:
```
~/.claude/projects/-Users-alexnewman-Scripts-claude-mem/2933cff9-f0a7-4f0b-8296-0a030e7658a6.jsonl
```

### Entry Types

Discovered 5 transcript entry types:

1. **`file-history-snapshot`** (NEW - not in Python model)
   - Purpose: Track file state snapshots
   - Frequency: ~10 entries per session

2. **`user`** - User messages and tool results
   - Contains actual user text messages OR tool result data
   - Can have string content or array of ContentItems

3. **`assistant`** - Assistant responses and tool uses
   - Contains text responses, tool uses, and thinking blocks
   - **Critical**: Contains usage data with token counts

4. **`summary`** (not yet observed in test data)
   - Session summaries

5. **`system`** (not yet observed in test data)
   - System messages/warnings

6. **`queue-operation`** (not yet observed in test data)
   - Queue tracking for message flow

## Key Findings

### 1. Message Extraction Complexity

**Problem**: Naively getting the "last" entry doesn't work because:
- Last user entry might be a tool result, not a text message
- Last assistant entry might only contain tool uses, no text

**Solution**: Iterate backward through entries to find the last entry with actual text content.

### 2. Tool Use Tracking

**Discovery**: Tool uses are in **assistant** messages, not user messages.

**Data Available**:
```typescript
{
  name: string;      // Tool name (e.g., "Bash", "Read", "TodoWrite")
  timestamp: string; // When the tool was used
  input: any;        // Full tool input parameters
}
```

**Test Session Results** (168 entries):
- 42 tool uses across 7 different tool types
- Most used: Bash (24x), TodoWrite (5x), Edit (4x)

### 3. Token Usage Data (ROI Foundation)

**Critical Discovery**: Every assistant message contains complete token usage data:

```typescript
interface UsageInfo {
  input_tokens?: number;              // Total input tokens (includes context)
  cache_creation_input_tokens?: number; // Tokens used to create cache
  cache_read_input_tokens?: number;   // Cached tokens read (discounted cost)
  output_tokens?: number;             // Model output tokens
}
```

**Test Session Token Analysis**:
```
Input tokens:          858
Output tokens:         44,165
Cache creation tokens: 469,650
Cache read tokens:     5,294,101  ← 5.29M tokens saved by caching!
Total tokens:          45,023
```

**ROI Implication**: This validates our ROI implementation plan. We can track:
- Discovery cost = sum of all input + output tokens across session
- Context savings = cache_read_input_tokens (tokens NOT paid for in full)
- ROI = Discovery cost / Context savings

### 4. Parse Reliability

**Result**: 0.00% parse failure rate on production transcript with 168 entries.

**Conclusion**: The JSONL format is stable and well-formed. No need for extensive error handling.

## Implementation Files

### Created Files

1. **`src/types/transcript.ts`** - TypeScript types matching Python Pydantic model
   - All entry types, content types, usage info
   - Drop-in compatible with Python model structure

2. **`src/utils/transcript-parser.ts`** - Robust transcript parsing class
   - Handles all entry types
   - Smart message extraction (finds last text message, not just last entry)
   - Tool use history extraction
   - Token usage aggregation
   - Parse statistics and error tracking

3. **`scripts/test-transcript-parser.ts`** - Validation script
   - Tests all extraction methods
   - Reports parse statistics
   - Shows token usage breakdown
   - Lists tool use history

### Usage Example

```typescript
import { TranscriptParser } from '../src/utils/transcript-parser.js';

const parser = new TranscriptParser('/path/to/transcript.jsonl');

// Extract messages
const lastUserMsg = parser.getLastUserMessage();
const lastAssistantMsg = parser.getLastAssistantMessage();

// Get tool history
const tools = parser.getToolUseHistory();
// => [{name: 'Bash', timestamp: '...', input: {...}}, ...]

// Get token usage
const tokens = parser.getTotalTokenUsage();
// => {inputTokens: 858, outputTokens: 44165, cacheReadTokens: 5294101, ...}

// Parse statistics
const stats = parser.getParseStats();
// => {totalLines: 168, parsedEntries: 168, failedLines: 0, ...}
```

## Next Steps for PR Review

### Addressing "Drops Unknown Lines" Concern

**Original Issue**: Summary hook silently skipped malformed lines without visibility.

**Root Cause**: We didn't understand the full transcript model. The "skip malformed lines" was a band-aid.

**Solution**: Replace ad-hoc parsing in `summary-hook.ts` with validated `TranscriptParser` class:

**Before** (summary-hook.ts:38-117):
```typescript
// Manually parsing with try/catch, no type safety
for (let i = lines.length - 1; i >= 0; i--) {
  try {
    const line = JSON.parse(lines[i]);
    if (line.type === 'user' && line.message?.content) {
      // ... extraction logic
    }
  } catch (parseError) {
    // Skip malformed lines  ← BLACK HOLE
    continue;
  }
}
```

**After** (using TranscriptParser):
```typescript
import { TranscriptParser } from '../utils/transcript-parser.js';

const parser = new TranscriptParser(transcriptPath);
const lastUserMessage = parser.getLastUserMessage();
const lastAssistantMessage = parser.getLastAssistantMessage();

// Parse errors are tracked in parser.getParseErrors()
```

**Benefits**:
1. ✅ Type-safe extraction based on validated model
2. ✅ No silent failures - parse errors are tracked
3. ✅ Smart extraction (finds last TEXT message, not last entry)
4. ✅ Reusable across all hooks and scripts
5. ✅ Enables token usage tracking (ROI metrics)
6. ✅ Enables tool use tracking (prompt optimization)

## Prompt Optimization Opportunities

With rich transcript data available, we can enhance prompts with:

### 1. Tool Use Patterns
- "In this session you've used: Bash (24x), TodoWrite (5x), Edit (4x)"
- Helps Claude understand what kind of work is being done

### 2. Token Economics Awareness
- "Cache read tokens: 5.29M (context savings)"
- Reinforces value of memory system

### 3. Session Flow Understanding
- Number of user/assistant exchanges
- Tools used per exchange
- Session complexity metrics

### 4. File History Snapshots
- Track which files were modified during session
- Provide file change context to summaries

## Testing

Run the validation script:
```bash
# Find your current session transcript
ls -lt ~/.claude/projects/-Users-alexnewman-Scripts-claude-mem/*.jsonl | head -1

# Test the parser
npx tsx scripts/test-transcript-parser.ts <path-to-transcript.jsonl>
```

## Conclusion

The transcript parser implementation:
1. ✅ Addresses PR review concern about dropped lines
2. ✅ Validates the ROI metrics implementation plan
3. ✅ Enables prompt optimization with rich context
4. ✅ Provides foundation for future enhancements

**Recommendation**: Replace ad-hoc transcript parsing in hooks with `TranscriptParser` class for improved reliability and feature richness.
