import { describe, expect, it } from 'bun:test';

process.env.PR_BABYSIT_STATUS_NO_MAIN = '1';

describe('pr-babysit-status helpers', () => {
  it('extracts concise actionable hints from bot review bodies', async () => {
    const { extractActionableHints } = await import('../../scripts/pr-babysit-status.ts');

    const hints = extractActionableHints(`
**Actionable comments posted: 2**

<details>
<summary>Prompt for all review comments with AI agents</summary>

Inline comments:
In \`@src/file.ts\`:
- Line 10: Replace the unsafe fallback with a checked path.
- Around line 22: Treat a missing binary as stale.
</details>
`);

    expect(hints).toContain('Actionable comments posted: 2');
    expect(hints).toContain('10: Replace the unsafe fallback with a checked path.');
    expect(hints).toContain('22: Treat a missing binary as stale.');
    expect(hints.join('\n')).not.toContain('Prompt for all review comments');
  });

  it('extracts review comment headings without dumping full markdown', async () => {
    const { extractActionableHints } = await import('../../scripts/pr-babysit-status.ts');

    const hints = extractActionableHints(`
_Potential issue_ | _Major_ | _Quick win_

**Treat a missing current Bun binary as stale too.**

If the marker says this install was created with Bun but getBunVersion now
returns null, this still reports the install as current and skips repair.
`);

    expect(hints).toContain('Treat a missing current Bun binary as stale too.');
    expect(hints.some(hint => hint.includes('skips repair'))).toBe(false);
  });

  it('summarizes branch protection without requiring unavailable fields', async () => {
    const { summarizeProtection } = await import('../../scripts/pr-babysit-status.ts');

    expect(summarizeProtection({
      required_pull_request_reviews: {
        dismiss_stale_reviews: true,
        require_code_owner_reviews: false,
        require_last_push_approval: false,
        required_approving_review_count: 1,
      },
      enforce_admins: { enabled: false },
      allow_force_pushes: { enabled: true },
    })).toEqual([
      'Required checks: none',
      'Required reviews: 1 approval',
      'Dismiss stale reviews: yes',
      'Code owner reviews: no',
      'Last-push approval: no',
      'Conversation resolution: no',
      'Signed commits: no',
      'Enforce admins: no',
      'Allow force pushes: yes',
    ]);
  });
});
