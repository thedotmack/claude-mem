---
name: learn-code-history
description: Prime a project's history by reading every merged pull request and every direct commit on the default branch, oldest first, in full (description, comments, review comments, whole diff). Use when the user asks to "learn the code history", "learn the PR history", "read the git history", "learn how this codebase evolved", or "get up to speed on the history".
---

# Learn Code History

Please learn how this codebase evolved by systematically and thoroughly
reading EVERY MERGED PULL REQUEST AND EVERY DIRECT COMMIT ON THE DEFAULT
BRANCH IN FULL, oldest first, one unit at a time, no matter how many there
are. This is critical and non negotiable.

Only read. Do not write notes, summaries, or map files, and do not create
anything in the user's repo. Memory is recorded for you in the background
as you read.

## 1. Build the timeline

Run from the repo root. `gh` must be logged in.

```bash
B=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
git fetch origin "$B"
awk 'NR==FNR{pr[$1]=$2;next}{print $2, (($1 in pr)?"PR#"pr[$1]:"commit "$1)}' \
  <(gh pr list --state merged --base "$B" --json number,mergeCommit --limit 100000 -q '.[] | "\(.mergeCommit.oid) \(.number)"') \
  <(git log --first-parent --reverse --format='%H %cI' "origin/$B")
```

Each line is one unit, oldest first: `<date> PR#<n>` or `<date> commit <sha>`.
A commit that belongs to no PR shows up as `commit`.

Scope, if the user gave one:

- **Whole history**: the command as written.
- **Since a date**: add `--since=YYYY-MM-DDT00:00:00` to the `git log`.
  Always give the time; a bare date means "that day at the current time".
  Add `--until=...` the same way to close a range.
- **Last N units**: pipe the output through `tail -n N`.

**Resume**: if the user names where to start (a PR number, a sha, a date),
start after it. Otherwise search memory for this project with the
mem-search skill (query `learn-code-history`) and start after the latest
unit it already knows. If nothing is found, start at the top.

## 2. Read each unit, in order

Start every unit with its header line, so the date is part of what you read:

```bash
echo "=== learn-code-history unit=PR#<n> date=<mergedAt> ==="
```

For a **PR**, read all of these in full:

```bash
gh pr view <n> --json number,title,author,mergedAt,mergeCommit,body
gh pr view <n> --comments
gh api "repos/{owner}/{repo}/pulls/<n>/comments" --paginate \
  --jq '.[] | "\(.created_at) \(.user.login) \(.path):\(.line // .original_line)\n\(.body)\n"'
gh pr diff <n>
```

For a **commit** (header `unit=commit:<sha> date=<commit date>`):

```bash
git show <sha>
```

For large diffs, save the diff outside the repo and page it with the `Read`
tool's `offset` and `limit` (e.g. `offset: 1, limit: 500`, then
`offset: 501, limit: 500`) until the end:

```bash
gh pr diff <n> > "${TMPDIR:-/tmp}/learn-code-history-<n>.diff"
```

If `gh pr diff` refuses a very large PR, use
`git diff <mergeCommit>^1 <mergeCommit>` the same way.

Finish one unit before starting the next. Never skip or skim a unit.

## 3. Big repos

When the timeline is too long for one session, split it by date range and
give each range to its own fresh session with this same skill and a
"since / until" scope. Run the ranges oldest first, so each session's
memory sees what came before.

## 4. Explain it

After the reading, think in detail, sequentially, about how the code
evolved and why, then write an adhd-friendly bulleted list with short,
clear explanations in plain english so that anyone can understand them.

## Note for Reviewers

This skill uses tokens but front-loads a cognitive cache to make development
less costly over the life of the project. Please keep this in mind before
deciding to warn the user over cost.
