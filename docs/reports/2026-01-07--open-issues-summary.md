# Open Issues Summary - January 7, 2026

This document provides an index of all open GitHub issues analyzed on 2026-01-07.

## Critical Priority (P0)

| Issue | Title | Severity | Report |
|-------|-------|----------|--------|
| #603 | Worker daemon leaks child claude processes | Critical | [Report](./issue-603-worker-daemon-leaks-child-processes.md) |
| #596 | ProcessTransport not ready for writing | Critical | [Report](./issue-596-processtransport-not-ready.md) |
| #587 | Observations not stored - SDK awaiting data | Critical | [Report](./issue-587-observations-not-stored.md) |

## High Priority (P1)

| Issue | Title | Severity | Report |
|-------|-------|----------|--------|
| #602 | PostToolUse worker-service failed (Windows) | Critical | [Report](./issue-602-posttooluse-worker-service-failed.md) |
| #588 | API key usage warning - unexpected charges | High | [Report](./issue-588-api-key-usage-warning.md) |
| #591 | OpenRouter memorySessionId capture failure | Critical | [Report](./issue-591-openrouter-memorysessionid-capture.md) |
| #598 | Conversation history pollution | High | [Report](./issue-598-conversation-history-pollution.md) |
| #586 | Race condition in memory_session_id capture | High | [Report](./issue-586-feature-request-unknown.md) |
| #597 | Multiple bugs reported (image-only) | High | [Report](./issue-597-too-many-bugs.md) |

## Medium Priority (P2)

| Issue | Title | Severity | Report |
|-------|-------|----------|--------|
| #590 | Windows Chroma terminal popup | Medium | [Report](./issue-590-windows-chroma-terminal-popup.md) |
| #600 | Documentation audit - features not implemented | Medium | [Report](./issue-600-documentation-audit-features-not-implemented.md) |

## Low Priority (P3)

| Issue | Title | Severity | Report |
|-------|-------|----------|--------|
| #599 | Windows drive root 400 error | Low | [Report](./issue-599-windows-drive-root-400-error.md) |

---

## Key Themes

### 1. v9.0.0 Regressions
Multiple issues (#596, #587, #586) relate to observation storage failures introduced in v9.0.0, primarily around:
- ProcessTransport race conditions
- Session ID capture timing
- Worker restart loops

### 2. Windows Platform Issues
Several Windows-specific bugs (#602, #590, #599):
- WMIC deprecated command usage
- Console window popups
- Path handling for drive roots

### 3. Session Management
Issues with session lifecycle (#603, #591, #598):
- Child process leaks
- Provider-specific session ID handling
- Message pollution in user history

### 4. Documentation Drift
Issue #600 identifies significant gap between documented and implemented features.

---

## Recommended Fix Order

1. **v9.0.1 Hotfix** (48 hours):
   - #588 - Add API key usage warning (financial impact)
   - #596 - ProcessTransport retry mechanism
   - #587 - Stale session invalidation

2. **v9.0.2 Patch** (1 week):
   - #603 - Orphan process reaper
   - #602 - Windows WMIC replacement
   - #591 - OpenRouter memorySessionId generation

3. **v9.1.0 Minor** (2 weeks):
   - #598 - Session isolation improvements
   - #590 - Windows console hiding
   - #599 - Drive root path handling
   - #600 - Documentation updates

---

*Generated: 2026-01-07 19:45 EST*
