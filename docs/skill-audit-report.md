# Skill Audit Report

**Date:** 2025-11-10
**Validation:** Anthropic's official skill-creator documentation
**Skills Audited:** mem-search, search

## Executive Summary

The mem-search skill achieves 100% compliance across all dimensions. The search skill meets technical requirements but fails effectiveness metrics critical for auto-invocation.

**mem-search:** Production-ready. No changes required.

**search:** Requires three critical fixes before Claude reliably discovers and invokes this skill.

## mem-search Skill Results

**Status:** ✅ PASS
**Compliance:** 100% technical, 100% effectiveness
**Files:** 17 (202-line SKILL.md + 13 operations + 2 principles)

### Strengths

The skill demonstrates exemplary effectiveness engineering:

1. **Trigger Design (85% concrete)**
   - Five unique identifiers: claude-mem, PM2-managed database, cross-session memory, session summaries, observations
   - Nine scope differentiation keywords
   - Explicit boundary: "NOT in the current conversation context"
   - Minimal overlap with Claude's native capabilities

2. **Capability Visibility (100%)**
   - All nine operations include inline "Use when" examples
   - Decision guide reduces complexity from nine operations to five common cases
   - No navigation friction

3. **Structure**
   - 202 lines (60% under limit)
   - Perfect progressive disclosure with token cost documentation
   - Clean file organization: operations/ and principles/ directories
   - No content duplication

### Issues

**One false positive:** Line 152 contains backslashes in regex notation `(bugfix\|feature\|decision)`. This documents parameter syntax, not Windows paths. No action required.

## search Skill Results

**Status:** ⚠️ NEEDS IMPROVEMENT
**Compliance:** 100% technical, 67% effectiveness
**Files:** 13 (96-line SKILL.md + 12 operations)

### Critical Effectiveness Issues

Three failures prevent reliable auto-invocation:

#### Issue 1: Insufficient Scope Differentiation

**Problem:** Description contains only two differentiation keywords (threshold: ≥3). Claude cannot distinguish this skill from native conversation memory.

**Current description:**
```text
Search claude-mem persistent memory for past sessions, observations, bugs
fixed, features implemented, decisions made, code changes, and previous work.
Use when answering questions about history, finding past decisions, or
researching previous implementations.
```

**Domain overlap analysis:**
- Claude answers natively: "What bugs did we fix?" (current conversation)
- Claude needs skill: "What bugs did we fix last week?" (external database)

**Fix required:**

```text
Search claude-mem's external database of past sessions, observations, and
work from previous conversations. Accesses persistent memory stored outside
current session context - NOT information from today's conversation. Use when
users ask about: (1) previous sessions ("what did we do last week?"),
(2) historical work ("bugs we fixed months ago"), (3) cross-session patterns
("how have we approached this before?"), (4) work already stored in claude-mem
("what's in the database about X?"). Searches FTS5 full-text index across
typed observations (bugfix/feature/refactor/decision/discovery). For current
session memory, use native conversation context instead.
```

This adds eight differentiation keywords: "external database", "past sessions", "previous conversations", "outside current session", "NOT information from today's", "last week", "months ago", "already stored in claude-mem".

#### Issue 2: Weak Trigger Specificity

**Problem:** Only 44% concrete triggers (threshold: >50%). Only one unique identifier (threshold: ≥2).

**Abstract triggers (low specificity):**
- "history" (could mean git history, browser history)
- "past work" (could mean files, commits, documents)
- "decisions" (could mean any decision tracking)
- "previous work" (could mean current session earlier)
- "implementations" (could mean code in current conversation)

**Concrete triggers (high specificity):**
- "claude-mem" (unique system name)
- "persistent memory" (system-specific)
- "sessions" (cross-session concept)
- "observations" (system-specific)

**Concrete ratio:** 4/9 = 44% (fails 50% threshold)

**Fix required:** Add system-specific terminology: "HTTP API", "port 37777", "FTS5 full-text index", "typed observations". See combined description in Issue 1 fix.

#### Issue 3: Wasted Content in Body

**Problem:** Lines 10-22 contain "When to Use This Skill" section in SKILL.md body. This loads AFTER triggering, wastes ~200 tokens, provides no value.

**Reference:** [Anthropic's skill-creator documentation](https://github.com/anthropics/anthropic-quickstarts/tree/main/skill-creator) states: "The body is only loaded after triggering, so 'When to Use This Skill' sections in the body are not helpful to Claude."

**Fix required:** Delete lines 10-22 entirely. Move triggering examples to description field (already included in Issue 1 fix).

### Strengths

The skill demonstrates strong structure:

- Excellent progressive disclosure (96-line navigation hub)
- Strong decision guide (reduces 10 operations to common cases)
- 100% capability visibility (all operations show purpose inline)
- No forbidden files or content duplication
- Clean operations/ directory structure

### Warning

**Minor:** Description uses imperative "Use when" instead of third person. Change to "Useful for" or "Invoked when" for consistency with skill-creator best practices.

## Comparison

| Metric | mem-search | search | Impact |
|--------|-----------|---------|--------|
| Concrete triggers | 85% | 44% | search harder to discover |
| Unique identifiers | 5+ | 1 | search less distinct |
| Scope differentiation | 9 keywords | 2 keywords | **search conflicts with native memory** |
| Body optimization | Clean | Wasted section | search wastes tokens |
| Overall effectiveness | 100% | 67% | search needs fixes |

## Critical Recommendations

The search skill requires three changes before production use:

1. **Rewrite description** to add scope differentiation and concrete triggers (see Issue 1 fix)
2. **Delete lines 10-22** from SKILL.md body
3. **Convert to third person** - change "Use when" to "Useful for"

**Why this matters:** Without scope differentiation, Claude assumes "What bugs did we fix?" refers to current conversation, not the external claude-mem database. This causes systematic under-invocation.

## Reference Implementation

The mem-search skill serves as a reference implementation for:

- Trigger design with explicit scope boundaries
- Progressive disclosure with token efficiency documentation
- Inline capability visibility eliminating navigation friction
- Decision guides reducing cognitive load

Study mem-search when creating skills that overlap with Claude's native capabilities.
