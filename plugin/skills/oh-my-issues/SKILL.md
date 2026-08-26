---
name: oh-my-issues
description: Cluster a GitHub issue backlog by root cause into a small set of plan-master issues, redirect children with a standardized comment, and bundle architectural-fix PRs that close clusters atomically. Use when an issue tracker has accumulated dozens of reports that share underlying defects, when asked to triage / consolidate / cluster / dedupe issues, when asked to build a plan series or roadmap from open issues, or when routing a new incoming bug into an existing plan.
---

# oh-my-issues

Turn an issue backlog into a roadmap. Issues are symptom data, not units of work — the unit of work is the architectural defect that produces them. The end state is `open issues == open plans`, 1:1.

## Core principle

Stop closing issues one at a time. Group symptoms that share a single architectural fix into a cluster, give the cluster one canonical home (a plan-master issue + a `plans/0X-*.md` design doc), close every child with a standardized redirect, and ship one PR per cluster that closes all children atomically. New incoming bugs get appended to the matching master as a "Round N" comment, not opened as new tracked issues.

This compounds three ways: architectural fixes retire whole symptom families, the plan's test matrix institutionalizes prevention in CI, and standardized triage makes residual inflow cheap.

## When to use

- The repo has 20+ open issues and many feel like duplicates or platform-specific symptoms of the same defect.
- The user asks to "triage", "consolidate", "cluster", "dedupe", "group", or "make a plan from" the issue list.
- A new bug is filed and the user wants to know whether it belongs to existing work.
- The user wants to ship a focused PR that resolves a cluster of related issues.

## When NOT to use

- Fewer than ~15 open issues: just close them.
- Issues are genuinely independent (no shared root causes): one fix per issue is correct.
- The repo lacks `plans/` discipline and the user does not want to introduce one — propose first, do not impose.

## Three modes

### Mode 1: Cluster pass (initial reduction)

Use when the backlog has never been consolidated. Goal: go from N issues to N_plans masters in one operation.

1. **Read everything in full.** Fetch every open issue's body *and* its comment thread — not just titles. Surface-level grouping fails without full text, and reproduction steps, linked duplicates, and diagnostic output often live in comments rather than the original body. See "GitHub CLI primitives" below for the correct paginated listing + per-issue comment fetch (a single `gh issue list` call does **not** return comment bodies).
2. **Cluster by root cause, not by surface.** The clustering question is *would one architectural change retire all of these?* — not *do these mention the same word?*. "Windows" is a surface; "spawn contract violated by host shells" is a root cause. Two issues with different surfaces can share a cluster (e.g. an env-var leak in two different code paths sharing one missing env-isolation boundary).
3. **Name each cluster as an architectural problem.** Title format: `[plan-XX] <Architectural Defect> — <one-line scope>`. Example: `[plan-02] Spawn-Contract Templating — canonical ${CLAUDE_PLUGIN_ROOT} resolution across all hosts`. The title must imply a fix, not a topic.
4. **Open one master issue per cluster** with a body that lists: the architectural defect, the children (by issue number), the fix sequence, and a required test matrix (host × IDE × shell, etc.) that prevents regression.
5. **Mirror each master as `plans/0X-<slug>.md`** in the repo. The issue is the public tracker; the doc is the design. They reference each other.
6. **Close every child** with the standardized redirect comment (see below) and state `not planned`.
7. **Verify end state:** `gh issue list --state open` returns exactly the masters and nothing else.

Target shape for ~100 issues: 4–8 masters. More than 10 means you're clustering by surface; fewer than 3 means clusters are too broad to ship as one PR each.

### Mode 2: Triage (new incoming bug, steady state)

Use when a new issue is filed after consolidation is in place. Goal: never let the issue list re-accumulate.

1. **Read the new issue's body in full.**
2. **Pattern-match the symptom against existing plan masters.** For each open master, ask: *would the fix described here also fix this new bug?* If yes → it belongs to that plan.
3. **If a match exists**, post a "Round N" comment on the master that:
   - Names the new child by number
   - Describes the symptom in one line
   - Sketches the concrete fix (1–3 lines, e.g. "guard with `case "$_SH" in /*.exe|"") _SH=bash ;; esac`")
   - Adds any new test-matrix cell the bug exposes
4. **Close the child** with the standardized redirect comment, `not planned`.
5. **If no match exists** and the bug is genuinely novel: open a new plan master + `plans/0X-*.md`. Resist this. Most bugs are children of existing plans.

### Mode 3: Bundle (ship the cluster)

Use when a plan slice is ready to ship. Goal: one PR closes N children atomically.

1. **List the master's children.** From the master body and consolidation comments, collect every child issue number routed to this plan.
2. **Verify each child's symptom is covered** by the architectural fix in the PR. If a child is not covered, the PR is not ready or that child belongs in a different plan.
3. **Generate the PR description**: title is the plan slice (e.g. "fix(spawn): canonical ${CLAUDE_PLUGIN_ROOT} resolution"); body lists every child with `Closes #N` so GitHub auto-closes them on merge.
4. **Add the test matrix from the plan** to CI in the same PR. Without the matrix, the cluster will re-emerge.
5. **After merge**, the master issue can be closed only if every child was covered. If the plan has remaining scope, leave the master open and link the PR as a partial-shipping checkpoint.

## Naming a plan master

A plan-master title must imply its fix.

| Bad (surface) | Good (architectural) |
|---|---|
| Windows bugs | Spawn-Contract Templating across hosts |
| Worker crashes | Worker / Daemon Lifecycle Hardening — supervision, health, retry |
| Auth issues | Worker Env Isolation — strip host CLI env from the SDK subprocess |
| Install failures | Installer Failure Transparency — cross-IDE error taxonomy + 12×4 test matrix |

If you cannot write a one-line architectural scope, the cluster is wrong.

## The standardized redirect comment

Use this exact phrasing on every child closure. Consistency lets contributors recognize the pattern at a glance and keeps the audit trail searchable.

```text
Consolidating into #<MASTER> (plan-XX). The root cause and fix sequencing are tracked there alongside the rest of the cluster — please follow that issue for progress.
```

Close as `not planned` (not `completed`) — the child was a symptom, not a unit of work.

## GitHub CLI primitives

Resolve repo:

```bash
repo_json=$(gh repo view --json owner,name)
owner=$(jq -r '.owner.login // .owner.name' <<<"$repo_json")
repo=$(jq -r '.name' <<<"$repo_json")
```

List all open issues (the read-everything pass). Two gotchas:
- `gh issue list --json comments` returns only a count placeholder, not the comment bodies. You must fetch comments per issue with `gh issue view <N> --json comments`.
- Any explicit `--limit` silently truncates if the backlog is larger. Always check the total open count first.

```bash
# 1. Confirm total — never trust an arbitrary --limit.
# Note: GitHub's REST API treats PRs as issues, so .open_issues_count
# from /repos/{owner}/{repo} is actually issues + PRs. Use the search
# API to get the issue-only count.
total=$(gh api "search/issues?q=repo:$owner/$repo+is:issue+is:open" --jq '.total_count')
echo "Open issues: $total"

# 2. List bodies (set --limit at or above the true total)
gh issue list --state open --limit "$total" \
  --json number,title,body,labels,author,createdAt

# 3. For each issue, fetch its full comment thread
for n in $(gh issue list --state open --limit "$total" --json number --jq '.[].number'); do
  echo "=== Issue #$n ==="
  gh issue view "$n" --json comments \
    --jq '.comments[] | "\(.author.login) (\(.createdAt)): \(.body)"'
done
```

If `total > 1000`, paginate via the REST API: `gh api "repos/$owner/$repo/issues?state=open&per_page=100&page=N"` looped until the result array is empty (note this includes PRs, so filter `select(.pull_request|not)`).

Open a plan master:

```bash
gh issue create \
  --title "[plan-02] Spawn-Contract Templating — canonical \${CLAUDE_PLUGIN_ROOT} resolution across all hosts" \
  --body-file plans/02-spawn-contract-templating.md \
  --label plan,plan-02
```

Post the consolidation comment + close the child:

```bash
gh issue comment <CHILD> --body "Consolidating into #<MASTER> (plan-XX). The root cause and fix sequencing are tracked there alongside the rest of the cluster — please follow that issue for progress."
gh issue close <CHILD> --reason "not planned"
```

Append a "Round N" triage comment to a master:

```bash
gh issue comment <MASTER> --body "$(cat <<'EOF'
**Round N consolidation**

- #<CHILD> (<one-line symptom>) folded into this plan as <classification>.

Proposed fix: <1–3 line sketch>.

Adds matrix cell: <host/IDE/shell combination>.
EOF
)"
```

Verify final state:

```bash
gh issue list --state open --json number,title \
  | jq -r '.[] | "\(.number)\t\(.title)"'
```

Output should be exactly the plan masters.

## Plan master body template

Save as `plans/0X-<slug>.md` and use as `--body-file` for the master issue.

```markdown
# [plan-XX] <Architectural Defect> — <one-line scope>

## Defect

<One paragraph: what is structurally broken, why it produces the observed family of symptoms.>

## Children

- #N — <symptom one-liner>
- #N — <symptom one-liner>
- ...

## Fix sequence

1. <First architectural change — bounded, reviewable>
2. <Second>
3. ...

## Test matrix

| Axis A | Axis B | Required behavior |
|---|---|---|
| ... | ... | ... |

The matrix lives in CI. A future regression must fail CI before a user can file.

## Out of scope

<What this plan deliberately does not cover, with pointers to other plan masters.>
```

## Health checks

Run periodically against the plan masters to catch the failure modes.

- **Graveyard master:** master issue has accumulated 5+ "Round N" comments without a shipping PR. The plan needs a forcing PR or it must be split.
- **Over-broad master:** the children's fixes cannot fit one PR. Split into two plans with narrower scope.
- **Surface-clustered master:** the children share a topic but not a fix. Re-cluster by root cause; some children belong to different plans.
- **Drift between issue and doc:** the plan master body and `plans/0X-*.md` disagree. Pick one as canonical (the doc) and regenerate the issue body from it.

## Stop conditions

For a cluster pass: stop when `gh issue list --state open` returns exactly the masters.

For a triage: stop when the new child is closed and the master has a Round-N entry.

For a bundle: stop when the PR is merged and every listed child is auto-closed by `Closes #N`.

## Failure modes worth refusing

- **Premature clustering** before reading every issue body in full. Don't.
- **Closing children before the master is open.** Children must always have a redirect target.
- **Using the redirect comment for issues that aren't symptoms** (e.g. genuine feature requests with no shared root cause). Those stay open or get their own track.
- **Closing a master before every listed child is shipped.** The master is the contract; closing it early breaks the audit trail.
