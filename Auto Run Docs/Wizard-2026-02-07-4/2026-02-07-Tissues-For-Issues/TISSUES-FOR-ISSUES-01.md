# Phase 01: Comprehensive Issue & PR Categorization Report

This phase produces the complete categorized report of all open issues and PRs in the claude-mem repository. It fetches live data from GitHub, categorizes every item into priority tiers, maps PRs to the issues they address, and generates a single structured report with keep/discard/defer recommendations. This report is the primary deliverable that enables the project owner to make informed decisions about what to act on, what to close, and what to defer.

## Tasks

- [x] Fetch all open issues and PRs from GitHub and save raw data to the Working folder for subsequent tasks to consume:
  - **Completed**: 67 issues and 30 PRs fetched, valid JSON verified, saved to Working/
  - Run `gh issue list --repo thedotmack/claude-mem --state open --limit 200 --json number,title,labels,createdAt,author,body,comments` and save to `Working/raw-issues.json`
  - Run `gh pr list --repo thedotmack/claude-mem --state open --limit 100 --json number,title,labels,createdAt,author,headRefName,isDraft,reviews,body` and save to `Working/raw-prs.json`
  - Verify both files are valid JSON and contain expected record counts (~65-70 issues, ~29 PRs)
  - Note: "Working" folder is at `/Users/alexnewman/Scripts/claude-mem//Auto Run Docs/Wizard-2026-02-07-4/Working/`

- [x] Read `Working/raw-issues.json` and categorize ALL open issues into a structured report covering Critical, High-Priority, and Security tiers. Write the output to `Working/issues-critical-high.md`:
  - **Completed**: 17 issues categorized (3 Critical/Security in Tier 1, 14 High-Priority in Tier 2). All 17 recommended KEEP. Cross-referenced 6 issues to active PRs. Report written to `Working/issues-critical-high.md` with YAML front matter and wiki-link cross-references.
  - **Tier 1: Critical Security & Stability** — Issues labeled `priority:critical` or `security` that threaten data integrity, enable exploits, or cause system-wide failures. Expected: #982 (path traversal CWE-22), #1010 (orphaned subprocess spawning), #793 (CLAUDE.md file pollution in subdirectories)
  - **Tier 2: High-Priority Bug Fixes** — Issues labeled `priority:high` that break core functionality. Expected: #998 (500 errors on PostToolUse), #987 (infinite session loop), #979 (migration fails to create tables), #966 (SDK generator abort loop), #942 (setting documented but not implemented), #855 (Gemini corruption), #843 (Windows bun:sqlite), #807 (Windows ProcessTransport), #785 (Windows WMIC removed), #730 (1TB vector-db growth), #729 (worker blocks startup), #718 (zombie session ID), #646 (stdin fstat crash), #997 (Windows command prompt spam), #990 (security report with 8 findings), #707 (SQLite-only mode - labeled enhancement but high priority)
  - For each issue, write: issue number, title, one-line summary of the problem, current labels, and a **Recommendation** of KEEP (fix it), DISCARD (close as won't-fix), or DEFER (deprioritize)
  - Use structured markdown with YAML front matter: `type: report`, `title: Critical & High-Priority Issues`, `tags: [triage, critical, high-priority, security]`
  - Apply these recommendation criteria: KEEP items that affect security, data integrity, or block normal usage; DISCARD items that are already fixed, duplicated, or obsolete; DEFER items that affect edge cases or have workarounds

- [x] Read `Working/raw-issues.json` and categorize ALL remaining open issues into Medium-Priority, Windows, Features, Integration, and Low-Priority tiers. Write the output to `Working/issues-medium-low.md`:
  - **Completed**: 48 issues categorized across Tiers 3–7 (5 Windows + 4 cross-refs in Tier 3, 18 Medium-Priority in Tier 4, 7 Features in Tier 5, 5 Integration in Tier 6, 13 Low-Priority in Tier 7). 33 recommended KEEP, 15 recommended DEFER, 0 DISCARD. Also included 2 newly filed unlabeled issues (#1015, #1014). Report written to `Working/issues-medium-low.md` with YAML front matter and wiki-link cross-references.
  - **Tier 3: Windows Platform Bugs** — Issues tagged `platform:windows`. Expected: #997, #843, #807, #785, #918, #723, #791, #675. Note some may overlap with Tier 2 (that's fine, list them in both with a cross-reference)
  - **Tier 4: Medium-Priority Bugs** — Issues labeled `priority:medium` that affect specific scenarios or have workarounds. Expected: #984, #978, #975, #957, #927, #923, #918, #916, #897, #895, #838, #784, #781, #744, #740, #728, #714, #696, #692, #658, #598, #683, #659, #936, #943, #600, #927
  - **Tier 5: High-Impact Features** — Enhancement requests with significant user value. Expected: #707 (SQLite-only mode), #659 (delete memories), #683 (project-scoped storage), #936 (orphan message processing), #943 (custom API endpoint), #668 (generalize anti-pattern-czar)
  - **Tier 6: Integration & Compatibility** — Issues affecting third-party tool integration. Expected: #838 (Cursor), #744 (Codex), #690 (LiteLLM), #762 (Cursor install)
  - **Tier 7: Low-Priority / Code Quality** — Issues labeled `priority:low` or affecting cosmetics/logging. Expected: #1011, #1005, #965, #816, #725, #716, #709, #695, #675, #649, #648, #642, #575, #762, #690, #753
  - For each issue, write: issue number, title, one-line summary, current labels, and Recommendation (KEEP/DISCARD/DEFER)
  - Use structured markdown with YAML front matter: `type: report`, `title: Medium & Low-Priority Issues`, `tags: [triage, medium-priority, low-priority, features, windows]`

- [x] Read `Working/raw-prs.json` and `Working/raw-issues.json`, then categorize ALL open PRs into a structured PR triage report. Write the output to `Working/pr-triage.md`:
  - **Completed**: 27 PRs categorized across 9 groups. 19 recommended REVIEW, 5 CLOSE, 5 DEFER, 0 immediate MERGE. Mapped PRs to linked issues with cross-references. Identified key coordination clusters: security (#1002 vs #986), subprocess management (#1008/#995/#992), session IDs (#996/#989/#518/#516). Report written to `Working/pr-triage.md` with YAML front matter and wiki-link cross-references. Note: Task listed #1021 but actual PR number is #1022 (username spaces fix); #834 was not in the open PR set.
  - Map each PR to the issue(s) it addresses (check PR body for "Fixes #", "Closes #", or issue references)
  - Categorize each PR as one of:
    - **MERGE** — PR addresses a critical/high issue, code looks reasonable, author is active
    - **REVIEW** — PR addresses a real issue but needs code review or testing before merge
    - **CLOSE** — PR is stale (>30 days with no activity), addresses a closed issue, or is low quality
    - **DEFER** — PR addresses a low-priority issue or is a nice-to-have
  - Group PRs by category:
    - **Owner PRs** (by thedotmack): #1012 (OpenClaw plugin), #518 (SDK V2 migration), #516 (orphaned observer sessions)
    - **Security Fixes**: #1002 (path traversal fix), #986 (CWE-22 + CWE-1321)
    - **Critical Bug Fixes**: #1008 (unbounded subprocess spawning), #977 (Linux stdin crash), #996 (synthetic session IDs)
    - **Windows Fixes**: #1021 (username spaces), #1006 (Chroma + WMIC), #474 (libuv assertion)
    - **Features**: #1019 (env vars), #995 (subprocess pool), #994 (stale session recovery), #993 (Chroma timeout), #992 (MCP heartbeat), #991 (Chroma disable setting), #434 (project exclusion)
    - **Infrastructure**: #1009 (MCP rename), #792 (Chroma HTTP server), #877/#876 (GitHub Actions upgrades)
    - **Documentation**: #999, #1013, #983 (CLAUDE.md restructures)
    - **Other**: #1000 (bug report diagnostics), #989 (FK constraint), #647 (9 bug fixes mega-PR), #498 (opencode plugin), #464 (Sleep Agent)
  - For each PR, write: PR number, title, author, linked issue(s), age, and Recommendation (MERGE/REVIEW/CLOSE/DEFER)
  - Use structured markdown with YAML front matter: `type: report`, `title: PR Triage Report`, `tags: [triage, pull-requests, code-review]`

- [ ] Read all three report files from Working/ (`issues-critical-high.md`, `issues-medium-low.md`, `pr-triage.md`) and compile them into a single master report. Write to `Working/MASTER-REPORT.md`:
  - **Executive Summary** at the top with:
    - Total counts: X open issues, Y open PRs
    - Priority distribution: X critical, X high, X medium, X low
    - Key findings: top 3 most impactful issues, top 3 most mergeable PRs
    - Overall health assessment of the repository
  - **Quick Decision Matrix** — A single table with ALL issues and PRs, each row showing: Number, Title (truncated), Category, Priority, Recommendation (KEEP/DISCARD/DEFER or MERGE/REVIEW/CLOSE/DEFER), and a 1-line rationale
  - Then include all the detailed tier sections from the three input files, organized as:
    1. Critical Security & Stability
    2. High-Priority Bug Fixes
    3. Windows Platform Bugs
    4. Medium-Priority Bugs
    5. High-Impact Features
    6. Integration & Compatibility
    7. Low-Priority / Code Quality
    8. PR Triage
  - **Action Plan** at the bottom with:
    - "Immediate Actions" — Critical items to fix NOW (security + stability)
    - "Next Sprint" — High-priority items that should be scheduled soon
    - "Community Contributions" — PRs that can be merged with minimal effort
    - "Close Candidates" — Issues and PRs recommended for closure with reasons
  - Use YAML front matter: `type: report`, `title: Claude-Mem Issue & PR Triage Report`, `created: 2026-02-07`, `tags: [triage, master-report, prioritization]`
  - Use `[[Issues-Critical-High]]`, `[[Issues-Medium-Low]]`, `[[PR-Triage]]` wiki-links to reference the component reports
