// Git work product: commits and branches found in recorded Bash tool uses.
// Every command and output below is a recorded tool use from a real
// ~/.claude-mem/claude-mem.db (tool_uses id in each comment), with long commit
// bodies and unrelated output trimmed. Made-up samples say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { githubRepo, mergeProducts, productsFromToolUse } from '../../../src/services/work-view/work-product.mjs';

const bash = (id, command, response, at = 100) => ({ id, session_db_id: 7, prompt_number: 1, tool_name: 'Bash', tool_input: JSON.stringify({ command }), tool_response: JSON.stringify(response), created_at_epoch: at });
const brief = (products) => products.map(({ kind, title, sha, branch, url }) => ({ kind, title, ...(sha ? { sha } : {}), branch, url }));

test('git commit: the [<branch> <sha>] <subject> line names the commit; a commit with no GitHub push has no link', () => {
  // tool_uses 150563
  const products = productsFromToolUse(bash(150563, '/usr/bin/git -C /Users/alexnewman/Scripts/claude-mem-pro/.claude/worktrees/agent-afc16a745910ec389 commit -F /Users/alexnewman/Scripts/claude-mem-pro/.claude/worktrees/agent-afc16a745910ec389/.scratch/commit-msg-qa.txt', {
    stdout: '[teambrain-purchase 8ade2c4] fix(teambrain): QA for self-serve purchase (#333)\n 9 files changed, 642 insertions(+), 84 deletions(-)\n create mode 100644 src/lib/teambrain/billing-card.ts',
    stderr: '', gitOperation: { commit: { sha: '8ade2c4', kind: 'committed', branch: 'teambrain-purchase' } },
  }));
  assert.deepEqual(brief(products), [{ kind: 'commit', title: '8ade2c4 fix(teambrain): QA for self-serve purchase (#333)', sha: '8ade2c4', branch: 'teambrain-purchase', url: undefined }]);
  // tool_uses 9553 (stdout as recorded; the command is shortened): a detached HEAD has no branch.
  const [detached] = productsFromToolUse(bash(9553, 'git commit -m "fix(pro): the opt-out button ignores presses no person could have made"', { stdout: '[detached HEAD 6edf530] fix(pro): the opt-out button ignores presses no person could have made\n 7 files changed, 567 insertions(+), 146 deletions(-)' }));
  assert.deepEqual([detached.branch, detached.title], [null, '6edf530 fix(pro): the opt-out button ignores presses no person could have made']);
});

test('quiet git commits are found by their own subject printed back by git log, or by rtk\'s ok <sha>', () => {
  // tool_uses 179579: two `git commit -q -F - <<EOF` in one command, then `git log --oneline -3`.
  const command = [
    'cd "/Users/alexnewman/.superset/worktrees/claude-mem 🧠/my-work-react-viewer"; git reset -q; git add src/services/work-view/request-projection.mjs tests/worker/work-view/request-projection.test.mjs && git commit -q -F - <<\'EOF\'',
    'fix(work-view): English asks need an action verb before they become requests',
    '',
    'Port the prototype\'s action-verb rule.',
    'EOF',
    'git add -A src tests plugin && git commit -q -F - <<\'EOF\'',
    'feat(work-view): progress readings, measured ETA, goal links and the build story',
    '',
    '- record-progress keeps readings[].',
    'EOF',
    'git log --oneline -3; git status --short | grep -v "^??"',
  ].join('\n');
  const products = productsFromToolUse(bash(179579, command, { stdout: 'bc8cd096b feat(work-view): progress readings, measured ETA, goal links and the build story\naf4ba749c fix(work-view): English asks need an action verb before they become requests\n3990ea7e1 fix(work-view): port request-grouping review fixes from the prototype', stderr: '' }));
  assert.deepEqual(brief(products), [
    { kind: 'commit', title: 'af4ba74 fix(work-view): English asks need an action verb before they become requests', sha: 'af4ba749c', branch: null, url: undefined },
    { kind: 'commit', title: 'bc8cd09 feat(work-view): progress readings, measured ETA, goal links and the build story', sha: 'bc8cd096b', branch: null, url: undefined },
  ]);
  // tool_uses 175203 (Codex records the output as a plain string).
  assert.deepEqual(brief(productsFromToolUse(bash(175203, "rtk git commit -m 'Align timeline hydration assertions with expanded scope'", 'ok bb07907\n'))), [
    { kind: 'commit', title: 'bb07907 Align timeline hydration assertions with expanded scope', sha: 'bb07907', branch: null, url: undefined },
  ]);
  // A quiet commit whose subject is never printed back is not guessed (tool_uses 178279).
  assert.deepEqual(productsFromToolUse(bash(178279, '/usr/bin/git commit -q -F .scratch/hooks/msg-4962.txt', { stdout: '', stderr: '' })), []);
});

test('a command that only mentions git commit or git push made nothing', () => {
  // Shape of tool_uses 179799: a read-only search of recorded commits (made-up output).
  const search = bash(179799, `cd ~/.claude-mem && sqlite3 -readonly claude-mem.db "SELECT id FROM tool_uses WHERE tool_input LIKE '%git commit%' AND tool_input LIKE '%git push%'"`, { stdout: '[feat/x abc1234] subject\n   1111111..2222222  feat/x -> feat/x' });
  assert.deepEqual(productsFromToolUse(search), []);
});

test('git push names the branch, links it on GitHub, and links the commit the same command made', () => {
  // tool_uses 178944: a quiet commit, then `git push -u origin <branch>` of a new branch.
  const command = [
    'W="/Users/alexnewman/.superset/worktrees/claude-mem 🧠/install-funnel"; cd "$W"; git add src/services/agent-runner/detect.ts tests/services/agent-runner/detect.test.ts && git commit -q -F - <<\'EOF\'',
    'feat(agent-runner): detect which agent CLIs are installed and logged in',
    '',
    'Adds detectUsableAgents().',
    'EOF',
    'git log --oneline -1; git push -u origin feat/install-funnel-early 2>&1 | tail -6',
  ].join('\n');
  const products = productsFromToolUse(bash(178944, command, {
    stdout: "30d795d5a feat(agent-runner): detect which agent CLIs are installed and logged in\nremote: GitHub found 2 vulnerabilities on thedotmack/claude-mem's default branch (2 critical). To find out more, visit:        \nremote:      https://github.com/thedotmack/claude-mem/security/dependabot        \nremote: \nTo https://github.com/thedotmack/claude-mem.git\n * [new branch]          feat/install-funnel-early -> feat/install-funnel-early\nbranch 'feat/install-funnel-early' set up to track 'origin/feat/install-funnel-early'.",
    stderr: '', gitOperation: { push: { branch: 'feat/install-funnel-early' } },
  }));
  assert.deepEqual(brief(products), [
    { kind: 'commit', title: '30d795d feat(agent-runner): detect which agent CLIs are installed and logged in', sha: '30d795d5a', branch: 'feat/install-funnel-early', url: 'https://github.com/thedotmack/claude-mem/commit/30d795d5a' },
    { kind: 'branch', title: 'feat/install-funnel-early', branch: 'feat/install-funnel-early', url: 'https://github.com/thedotmack/claude-mem/tree/feat/install-funnel-early' },
  ]);
  // tool_uses 178498: `tail -1` hid the To line, so the remote URL comes from the command.
  const [fork] = productsFromToolUse(bash(178498, '/usr/bin/git push https://github.com/SuperMarioYL/claude-mem.git HEAD:perf/search-reads-read-worker 2>&1 | tail -1', { stdout: '   92aa26602..659ae0d38  HEAD -> perf/search-reads-read-worker', stderr: '', gitOperation: { push: { branch: 'perf/search-reads-read-worker' } } }));
  assert.deepEqual([fork.branch, fork.heads, fork.url], ['perf/search-reads-read-worker', ['659ae0d38'], 'https://github.com/SuperMarioYL/claude-mem/tree/perf/search-reads-read-worker']);
  // tool_uses 177037: `tail -2` hid the To line and the remote is only a name, so no link.
  const [named] = productsFromToolUse(bash(177037, 'cd "/Users/alexnewman/.superset/worktrees/claude-mem 🧠/my-work-react-viewer" && for i in 1 2 3; do git push -u origin feat/my-work-react-viewer 2>&1 | tail -2 && break; sleep 5; done', { stdout: "   81cc75296..3edf6fd8e  feat/my-work-react-viewer -> feat/my-work-react-viewer\nbranch 'feat/my-work-react-viewer' set up to track 'origin/feat/my-work-react-viewer'.", gitOperation: { push: { branch: 'feat/my-work-react-viewer' } } }));
  assert.deepEqual([named.kind, named.branch, named.url], ['branch', 'feat/my-work-react-viewer', undefined]);
  // tool_uses 175466 (Codex, rtk; command shortened): `git push origin HEAD:main`. Two commits print one
  // `ok <sha>`, which cannot be told apart, so only the branch is recorded.
  const release = productsFromToolUse(bash(175466, "rtk git add -A && rtk git commit -m 'chore: bump version to 15.0.1' && rtk git tag -a v15.0.1 -m 'Version 15.0.1' && rtk git push origin HEAD:main && rtk git push origin v15.0.1 && rtk git add CHANGELOG.md && rtk git commit -m 'docs: update changelog for v15.0.1' && rtk git push origin HEAD:main", "ok 1 file changed, 12 insertions(+)\nok 85e4ee3\nremote: \nTo https://github.com/thedotmack/claude-mem.git\n   0e7de4ee4..85e4ee31f  HEAD -> main\nok main\n"));
  assert.deepEqual(brief(release), [{ kind: 'branch', title: 'main', branch: 'main', url: 'https://github.com/thedotmack/claude-mem/tree/main' }]);
});

test('a quiet git push -u origin <branch> names its branch; a rejected, deleting or non-GitHub push links nothing', () => {
  // Made-up samples.
  const [quiet] = productsFromToolUse(bash(1, 'git push -q -u origin feat/work-view-git-products', { stdout: '', stderr: '' }));
  assert.deepEqual([quiet.kind, quiet.branch, quiet.url], ['branch', 'feat/work-view-git-products', undefined]);
  assert.deepEqual(productsFromToolUse(bash(2, 'git push origin feat/x', { stdout: '', stderr: " ! [rejected]        feat/x -> feat/x (fetch first)\nerror: failed to push some refs to 'https://github.com/o/r.git'" })), []);
  assert.deepEqual(productsFromToolUse(bash(3, 'git push --delete origin feat/x', { stdout: '' })), []);
  const [gitlab] = productsFromToolUse(bash(4, 'git push origin feat/x', { stdout: '', stderr: 'To gitlab.com:o/r.git\n   1111111..2222222  feat/x -> feat/x' }));
  assert.deepEqual([gitlab.branch, gitlab.url], ['feat/x', undefined]);
  assert.deepEqual(['https://github.com/o/r.git', 'git@github.com:o/r.git', 'ssh://git@github.com/o/r', 'https://gitlab.com/o/r.git', 'origin'].map(githubRepo), ['o/r', 'o/r', 'o/r', null, null]);
});

test('git checkout -b and git switch -c record the branch they created', () => {
  // tool_uses 171667
  const created = productsFromToolUse(bash(171667, '/usr/bin/git fetch origin -q && /usr/bin/git checkout -b fix/launcher-bun-be-bun-reentry-4933 origin/main && /usr/bin/git log -1 --oneline', { stdout: "Switched to a new branch 'fix/launcher-bun-be-bun-reentry-4933'\nbranch 'fix/launcher-bun-be-bun-reentry-4933' set up to track 'origin/main'.\nf3cb32e43 fix: skip reasoning on OpenRouter field condensation requests (#4925)" }));
  assert.deepEqual(brief(created), [{ kind: 'branch', title: 'fix/launcher-bun-be-bun-reentry-4933', branch: 'fix/launcher-bun-be-bun-reentry-4933', url: undefined }]);
  // tool_uses 171854 (Codex, rtk)
  const switched = productsFromToolUse(bash(171854, 'rtk git switch -c fix/cloud-sync-census-api-execution origin/main', "Switched to a new branch 'fix/cloud-sync-census-api-execution'\nbranch 'fix/cloud-sync-census-api-execution' set up to track 'origin/main'.\n"));
  assert.deepEqual(switched.map((product) => product.branch), ['fix/cloud-sync-census-api-execution']);
  // Made-up: a branch that already exists was not created.
  assert.deepEqual(productsFromToolUse(bash(5, 'git checkout -b feat/x', { stdout: '', stderr: "fatal: a branch named 'feat/x' already exists" })), []);
});

test('merging keeps one entry per commit sha and per branch, and links them from a later push', () => {
  const commits = productsFromToolUse(bash(179579, 'git commit -q -m "fix(work-view): English asks need an action verb before they become requests" && git commit -q -m "feat(work-view): progress readings, measured ETA, goal links and the build story"; git log --oneline -2', { stdout: 'bc8cd096b feat(work-view): progress readings, measured ETA, goal links and the build story\naf4ba749c fix(work-view): English asks need an action verb before they become requests' }, 10));
  const created = productsFromToolUse(bash(9, 'git checkout -b feat/my-work-react-viewer', { stdout: "Switched to a new branch 'feat/my-work-react-viewer'" }, 5));
  // tool_uses 179704: the push that left the branch at bc8cd096b.
  const pushed = productsFromToolUse(bash(179704, 'rtk git push origin feat/my-work-react-viewer 2>&1 | tail -3', { stdout: ' 23 files changed, 1101 insertions(+), 597 deletions(-)\nTo https://github.com/thedotmack/claude-mem.git\n   3990ea7e1..bc8cd096b  feat/my-work-react-viewer -> feat/my-work-react-viewer\nok feat/my-work-react-viewer', gitOperation: { push: { branch: 'feat/my-work-react-viewer' } } }, 20));
  const again = productsFromToolUse(bash(11, 'git commit -m x', { stdout: '[feat/my-work-react-viewer bc8cd096b] feat(work-view): progress readings, measured ETA, goal links and the build story' }, 8));
  const merged = mergeProducts([commits, created, pushed, again]);
  assert.deepEqual(merged.map((product) => [product.kind, product.title, product.url]), [
    ['branch', 'feat/my-work-react-viewer', 'https://github.com/thedotmack/claude-mem/tree/feat/my-work-react-viewer'],
    // bc8cd09 is the pushed head; af4ba74 was made by the same command, so it is in the same repo.
    ['commit', 'af4ba74 fix(work-view): English asks need an action verb before they become requests', 'https://github.com/thedotmack/claude-mem/commit/af4ba749c'],
    ['commit', 'bc8cd09 feat(work-view): progress readings, measured ETA, goal links and the build story', 'https://github.com/thedotmack/claude-mem/commit/bc8cd096b'],
  ]);
  // A branch pushed before a commit was made does not prove that commit reached GitHub.
  const later = productsFromToolUse(bash(12, 'git commit -m y', { stdout: '[feat/my-work-react-viewer 20c6a29] fix(agent-runner): wait for each agent CLI instead of timing out' }, 30));
  assert.equal(mergeProducts([pushed, later]).find((product) => product.kind === 'commit').url, undefined);
});
