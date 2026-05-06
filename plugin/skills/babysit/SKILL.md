---
name: babysit
description: Watch a pull request or review cycle until it is ready to merge. Use when asked to babysit, monitor, or keep checking PR comments, reviews, and CI until all actionable issues are resolved.
---

# Babysit PR

Stay with the PR until it is actually clean. Do not stop after one check pass if comments or review threads are still unresolved.

## Workflow

1. Identify the PR number, branch, and base branch.
2. Confirm the PR is not draft and inspect mergeability, checks, review decision, comments, and review threads.
3. Watch pending checks until they finish. Poll at a practical interval, usually 30-60 seconds unless the user asks for a different cadence.
4. Read new comments and unresolved review threads. Treat bot summaries as useful, but verify actionable findings against the code.
5. Fix real issues in focused commits, run relevant tests/builds, push, and return to step 2.
6. Resolve stale review threads only after verifying the code or generated artifact now addresses the comment.
7. Stop only when checks are passing or intentionally skipped, review decision is acceptable, no actionable comments remain, and no unresolved review threads remain.

## GitHub CLI Checks

Use `gh pr view` for the coarse status:

```bash
gh pr view <number> --json \
  number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,statusCheckRollup,url
```

Resolve the repository owner/name before using GraphQL:

```bash
repo_json=$(gh repo view --json owner,name)
owner=$(jq -r '.owner.login // .owner.name' <<<"$repo_json")
repo=$(jq -r '.name' <<<"$repo_json")
```

Use GraphQL for unresolved review threads. Include `pageInfo`; omit `cursor` on the first page, then pass the previous `endCursor` with `-f cursor="$cursor"` while `hasNextPage` is `true`.

```bash
gh api graphql \
  -f query='query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id,isResolved,isOutdated,path,line,comments(last:1){nodes{author{login},body,createdAt,url}}}}}}}' \
  -f owner="$owner" -f repo="$repo" -F number=<number>
```

Use this loop when a PR may have many review threads:

```bash
thread_query='query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){pageInfo{hasNextPage endCursor}nodes{id,isResolved,isOutdated,path,line,comments(last:1){nodes{author{login},body,createdAt,url}}}}}}}'
cursor_args=()

while :; do
  page=$(gh api graphql -f query="$thread_query" -f owner="$owner" -f repo="$repo" -F number=<number> "${cursor_args[@]}")
  printf '%s\n' "$page" | jq -r '.data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved==false)
    | [.id,.path,(.line//""),(.isOutdated|tostring),(.comments.nodes[-1].author.login//""),(.comments.nodes[-1].body|gsub("\n";" ")|.[0:240])]
    | @tsv'

  jq -e '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' >/dev/null <<<"$page" || break
  cursor=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor' <<<"$page")
  cursor_args=(-f cursor="$cursor")
done
```

Filter unresolved threads with `jq`:

```bash
jq -r '.data.repository.pullRequest.reviewThreads.nodes[]
  | select(.isResolved==false)
  | [.id,.path,(.line//""),(.isOutdated|tostring),(.comments.nodes[-1].author.login//""),(.comments.nodes[-1].body|gsub("\n";" ")|.[0:240])]
  | @tsv'
```

Resolve a stale thread only when the fix is verified:

```bash
gh api graphql \
  -f query='mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id,isResolved}}}' \
  -f threadId=<thread-id>
```

## Operating Rules

- Keep the watcher running while long checks are pending.
- If a generated file is part of the distribution, verify the source and generated artifact agree before resolving comments.
- If a bot reports an issue against stale code, confirm whether the thread is outdated or addressed in the latest head.
- Before final reporting, do one fresh sweep of PR status, unresolved threads, recent comments, and local `git status`.
- Report concrete evidence: latest commit SHA, check names and results, unresolved thread count, tests run, and any dirty local files left untouched.
