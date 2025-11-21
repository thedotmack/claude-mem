# Endless Mode: Test Plan

**Version**: 1.0  
**Date**: 2025-11-19  
**Branch**: `copilot/sub-pr-135`  
**Status**: Ready for Execution

---

## Overview

This document outlines the comprehensive testing strategy for Endless Mode, a feature that compresses tool outputs in Claude Code's context window to enable indefinite sessions without hitting token limits.

**Target**: Achieve 80-95% token reduction through real-time transcript compression.

---

## Prerequisites

### Environment Setup

1. **Build and deploy**:
   ```bash
   cd /home/runner/work/claude-mem/claude-mem
   npm run build
   npm run sync-marketplace
   npm run worker:restart
   ```

2. **Enable Endless Mode**:
   Create `~/.claude-mem/settings.json`:
   ```json
   {
     "model": "claude-sonnet-4-5",
     "workerPort": 37777,
     "enableMemoryStorage": true,
     "enableContextInjection": true,
     "contextDepth": 7,
     "env": {
       "CLAUDE_MEM_ENDLESS_MODE": true
     }
   }
   ```

3. **Monitoring terminals**:
   ```bash
   # Terminal 1: Worker logs
   pm2 logs claude-mem-worker --lines 100

   # Terminal 2: Silent debug logs
   tail -f ~/.claude-mem/silent.log

   # Terminal 3: Database queries
   watch -n 5 "sqlite3 ~/.claude-mem/claude-mem.db 'SELECT COUNT(*) as obs_count FROM observations;'"
   ```

---

## Test Suite

### Test 1: Happy Path - Basic Compression

**Objective**: Verify end-to-end compression works for common tools

**Steps**:
1. Start fresh Claude Code session
2. Execute the following commands:
   ```
   Read src/hooks/save-hook.ts
   Bash ls -la
   Grep "transformTranscript" src/
   Read package.json
   Bash git log --oneline -5
   ```
3. Wait for each tool to complete (observe 90s blocking)
4. Check transcript file after each tool use

**Success Criteria**:
- ✅ Each tool blocks for <60s
- ✅ Worker logs show compression stats (original size, compressed size, % savings)
- ✅ Transcript contains `[Compressed by Endless Mode]` markers
- ✅ JSONL structure remains valid
- ✅ No error messages in worker logs
- ✅ Compression ratio 80-95%

**Metrics to Collect**:
```bash
# Observation creation time
grep "Observation ready (synchronous mode)" ~/.pm2/logs/claude-mem-worker-out.log | tail -10

# Compression stats
grep "Transcript transformation complete" ~/.pm2/logs/claude-mem-worker-out.log | tail -10

# Transcript size
ls -lh ~/.claude/sessions/$(ls -t ~/.claude/sessions | head -1)/transcript.jsonl
```

---

### Test 2: Timeout Handling

**Objective**: Verify graceful fallback when observation creation exceeds 90s

**Setup**:
Temporarily modify `src/services/worker-service.ts` to simulate slow processing:
```typescript
// In handleObservations(), before queueing observation
await new Promise(resolve => setTimeout(resolve, 95000)); // Force timeout
```

**Steps**:
1. Rebuild: `npm run build && npm run sync-marketplace && npm run worker:restart`
2. Start Claude Code session
3. Execute: `Read package.json`
4. Observe timeout after 90s

**Success Criteria**:
- ✅ Hook times out after exactly 90s
- ✅ Full output preserved in transcript (not compressed)
- ✅ Worker logs show timeout warning
- ✅ No crashes or errors
- ✅ Observation still created in background (check database after 2 minutes)

**Revert**: Remove the setTimeout before continuing tests

---

### Test 3: Disabled Mode - Async Behavior

**Objective**: Verify Endless Mode doesn't affect behavior when disabled

**Setup**:
Edit `~/.claude-mem/settings.json`:
```json
{
  "env": {
    "CLAUDE_MEM_ENDLESS_MODE": false
  }
}
```

**Steps**:
1. Restart Claude Code
2. Execute: `Read src/hooks/save-hook.ts`
3. Observe hook returns immediately (<2s)

**Success Criteria**:
- ✅ Hook completes in <2s (async mode)
- ✅ No blocking behavior
- ✅ Full output in transcript (not compressed)
- ✅ Observation created in background
- ✅ Worker logs show "async mode"

---

### Test 4: Skipped Tools

**Objective**: Verify meta-tools are skipped and don't block

**Steps**:
1. Enable Endless Mode
2. Execute these commands:
   ```
   /clear
   /help
   Use mem-search to find recent work
   ```

**Success Criteria**:
- ✅ SlashCommand and Skill tools not compressed
- ✅ Hooks return immediately for skipped tools
- ✅ Worker logs show "skipped" status
- ✅ No observations created for meta-tools

**Reference**: SKIP_TOOLS list in `src/hooks/save-hook.ts` (lines 35-41)

---

### Test 5: Large Tool Outputs (>100KB)

**Objective**: Test compression on very large outputs

**Steps**:
1. Create large file:
   ```bash
   dd if=/dev/urandom of=/tmp/large-file.bin bs=1M count=1
   base64 /tmp/large-file.bin > /tmp/large-file.txt
   ```
2. In Claude Code: `Read /tmp/large-file.txt`
3. Observe compression

**Success Criteria**:
- ✅ Observation created within 90s
- ✅ Transcript compressed (check file size before/after)
- ✅ Compression ratio >50% (large outputs compress better)
- ✅ No memory issues or crashes

**Metrics**:
```bash
# Original size (from worker logs)
grep "originalSize" ~/.pm2/logs/claude-mem-worker-out.log | tail -1

# Compressed size
grep "compressedSize" ~/.pm2/logs/claude-mem-worker-out.log | tail -1
```

---

### Test 6: Rapid-Fire Tool Uses

**Objective**: Test race conditions with multiple tools in quick succession

**Steps**:
1. Execute commands rapidly (don't wait for compression):
   ```
   Bash echo "test1"
   Bash echo "test2"
   Bash echo "test3"
   Bash echo "test4"
   Bash echo "test5"
   ```

**Success Criteria**:
- ✅ All observations created successfully
- ✅ No UNIQUE constraint errors
- ✅ Each tool_use_id mapped correctly
- ✅ All transcripts compressed
- ✅ No data corruption

**Check Database**:
```bash
sqlite3 ~/.claude-mem/claude-mem.db "SELECT tool_name, tool_use_id FROM observations ORDER BY created_at_epoch DESC LIMIT 5;"
```

---

### Test 7: Malformed Transcript Recovery

**Objective**: Verify error handling when transcript is corrupted

**Setup**:
Manually corrupt a transcript line:
```bash
# Add invalid JSON line
echo "THIS IS NOT JSON" >> ~/.claude/sessions/$(ls -t ~/.claude/sessions | head -1)/transcript.jsonl
```

**Steps**:
1. Execute: `Bash echo "test"`
2. Observe error handling

**Success Criteria**:
- ✅ Hook fails fast with clear error message
- ✅ Original transcript untouched (atomic rename failed)
- ✅ Temp file cleaned up
- ✅ Error logged to worker logs
- ✅ Session continues (observation saved even if transform fails)

---

### Test 8: Concurrent Sessions

**Objective**: Test multiple Claude Code sessions with Endless Mode

**Steps**:
1. Open 2 Claude Code windows/terminals
2. Execute tools simultaneously in both sessions
3. Verify no conflicts

**Success Criteria**:
- ✅ Both sessions compress correctly
- ✅ No database lock errors
- ✅ Observations mapped to correct sessions
- ✅ No transcript cross-contamination

---

### Test 9: Tool Use ID Extraction

**Objective**: Verify tool_use_id extraction from transcript works reliably

**Steps**:
1. Enable silent debug logging
2. Execute: `Read package.json`
3. Check silent.log

**Success Criteria**:
- ✅ tool_use_id extracted successfully
- ✅ Silent.log shows: `hasToolUseId: true`
- ✅ tool_use_id matches transcript entry
- ✅ No fallback to undefined

**Debug Output**:
```bash
tail -20 ~/.claude-mem/silent.log | grep "Endless Mode Check"
```

---

### Test 10: Network Interruption

**Objective**: Test resilience when worker service is unavailable

**Steps**:
1. Stop worker: `pm2 stop claude-mem-worker`
2. Execute: `Read package.json`
3. Observe error handling
4. Restart worker: `pm2 start claude-mem-worker`

**Success Criteria**:
- ✅ Hook shows clear error message
- ✅ Suggests restart command
- ✅ Session doesn't crash
- ✅ After restart, next tool works normally

---

## Performance Benchmarks

### Metrics to Track

| Metric | Target | Measurement Method |
|--------|--------|-------------------|
| Observation creation time | <60s (P95) | Worker logs: "Observation ready" |
| Transcript transformation | <1s | Worker logs: "Transcript transformation complete" |
| Hook execution time | <120s total | Silent.log timestamps |
| Compression ratio | 80-95% | (1 - compressed/original) × 100 |
| Error rate | <1% | Failed transformations / total attempts |

### Data Collection Script

Create `scripts/endless-mode-metrics.sh`:

```bash
#!/bin/bash

echo "=== Endless Mode Performance Metrics ==="
echo ""

echo "1. Observation Creation Times (last 10):"
grep "processingTimeMs" ~/.pm2/logs/claude-mem-worker-out.log | tail -10 | jq '.processingTimeMs'

echo ""
echo "2. Compression Ratios (last 10):"
grep "savings" ~/.pm2/logs/claude-mem-worker-out.log | tail -10 | grep -o "[0-9]\+%"

echo ""
echo "3. Total Observations with tool_use_id:"
sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM observations WHERE tool_use_id IS NOT NULL;"

echo ""
echo "4. Failed Transformations:"
grep "Transcript transformation failed" ~/.pm2/logs/claude-mem-worker-error.log | wc -l

echo ""
echo "5. Average Compression Ratio:"
# Calculate from worker logs (requires jq processing)
```

---

## Validation Checklist

Before declaring Endless Mode production-ready:

### Functionality
- [ ] Happy path works (Test 1)
- [ ] Timeout fallback works (Test 2)
- [ ] Disabled mode unchanged (Test 3)
- [ ] Skipped tools work (Test 4)
- [ ] Large outputs compress (Test 5)
- [ ] Rapid-fire safe (Test 6)
- [ ] Error recovery works (Test 7)
- [ ] Concurrent sessions safe (Test 8)
- [ ] tool_use_id extraction reliable (Test 9)
- [ ] Network resilience works (Test 10)

### Performance
- [ ] 80-95% compression achieved
- [ ] <60s observation creation (P95)
- [ ] <1s transcript transformation
- [ ] <120s total hook time
- [ ] <1% error rate

### Documentation
- [ ] README updated with Endless Mode section
- [ ] Configuration documented
- [ ] Monitoring commands documented
- [ ] Troubleshooting guide created
- [ ] Architecture diagram included

### User Experience
- [ ] No noticeable latency impact
- [ ] Clear error messages
- [ ] Easy enable/disable
- [ ] Monitoring tools available
- [ ] Compression visible in viewer UI

---

## Known Issues & Limitations

### Current Limitations
1. **90s timeout**: May not be sufficient for very complex tool outputs
2. **Single-threaded compression**: SDK Agent processes one at a time
3. **No per-tool configuration**: All tools compressed or none
4. **Pre-tool-use hook unused**: Experimental hook included but not active

### Future Enhancements
1. **Dynamic timeout**: Adjust based on output size
2. **Parallel compression**: Process multiple observations simultaneously
3. **Selective compression**: Configure which tools to compress
4. **Compression dashboard**: Real-time metrics in viewer UI
5. **Token counting**: Calculate exact token savings

---

## Troubleshooting

### Issue: Hook times out every time

**Symptoms**: All tools timeout after 90s, no observations created

**Diagnosis**:
```bash
pm2 logs claude-mem-worker --lines 50
```

**Solutions**:
1. Check worker is running: `pm2 status`
2. Check SDK Agent is processing: Look for "Generator auto-starting"
3. Check model availability: Verify `CLAUDE_MEM_MODEL` is valid
4. Increase timeout (advanced): Modify `TIMEOUT_MS` in worker-service.ts

---

### Issue: Transcript corrupted after transformation

**Symptoms**: Claude Code fails to read transcript, session broken

**Diagnosis**:
```bash
cat ~/.claude/sessions/<session-id>/transcript.jsonl | jq '.' > /dev/null
```

**Solutions**:
1. Check worker logs for errors
2. Restore from `.tmp` file if exists
3. Disable Endless Mode temporarily
4. File bug report with transcript snippet

---

### Issue: No compression happening

**Symptoms**: Full outputs in transcript, no `[Compressed by Endless Mode]` markers

**Diagnosis**:
```bash
tail -f ~/.claude-mem/silent.log | grep "Endless Mode Check"
```

**Solutions**:
1. Verify config: `cat ~/.claude-mem/settings.json`
2. Check `CLAUDE_MEM_ENDLESS_MODE=true` is set
3. Restart Claude Code
4. Check worker logs for "Endless Mode timeout"

---

## Test Report Template

```markdown
# Endless Mode Test Report

**Date**: YYYY-MM-DD
**Tester**: @username
**Branch**: copilot/sub-pr-135
**Claude Code Version**: X.X.X

## Test Results

### Test 1: Happy Path
- Status: ✅ PASS / ❌ FAIL
- Compression Ratio: XX%
- Avg Creation Time: XXs
- Notes: 

### Test 2: Timeout Handling
- Status: ✅ PASS / ❌ FAIL
- Timeout Behavior: 
- Fallback Worked: Yes/No
- Notes:

[... continue for all tests ...]

## Performance Metrics

| Metric | Target | Actual | Status |
|--------|--------|--------|--------|
| Compression Ratio | 80-95% | XX% | ✅/❌ |
| Creation Time (P95) | <60s | XXs | ✅/❌ |
| Transform Time | <1s | XXms | ✅/❌ |
| Error Rate | <1% | X% | ✅/❌ |

## Issues Found

1. [Issue description]
   - Severity: Critical/High/Medium/Low
   - Reproduction steps
   - Workaround

## Recommendations

- [ ] Ready for production
- [ ] Needs fixes (list above)
- [ ] Needs more testing (specify areas)

## Screenshots

[Attach: worker logs, compression stats, viewer UI]
```

---

## Next Steps

1. **Execute test suite** (prioritize Tests 1, 3, 4, 6, 9)
2. **Collect metrics** using the data collection script
3. **File test report** with results and recommendations
4. **Address issues** found during testing
5. **Update documentation** based on test findings
6. **Prepare demo video** showing compression in action

---

**Status**: Test plan ready for execution  
**Blocker**: None  
**Owner**: Engineering team  
**Target**: Complete testing by end of sprint
