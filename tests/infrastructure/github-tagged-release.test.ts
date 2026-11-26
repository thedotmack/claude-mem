import { describe, expect, test } from 'bun:test';
import { publicationState, requestRelease, taggedPublicationState, unreleasedNotes } from '../../scripts/github-tagged-release.mjs';

const tag = 'v16.1.0';
const version = '16.1.0';
const sha = 'a'.repeat(40);
const annotationSha = 'b'.repeat(40);
const previousSha = 'e'.repeat(40);
const changelog = '# Changelog\n\n## [Unreleased]\n\n## Cloud Sync\n\nNew monthly installer.\n\n## [16.0.4] - 2026-11-22\nEarlier work.';

function releaseApi() {
  const annotation = { tag, object: { type: 'commit', sha } };
  const tagRef = { object: { type: 'tag', sha: annotationSha } };
  const responses = new Map<string, any>([
    ['git/ref/heads/main', { object: { sha } }],
    [`git/ref/heads/release/publish/${tag}`, { object: { sha } }],
    [`git/ref/tags/${tag}`, null],
    [`contents/package.json?ref=${sha}`, JSON.stringify({ name: 'claude-mem', version })],
    [`contents/docs/CHANGELOG.md?ref=${sha}`, changelog],
    ['releases/latest', { tag_name: 'v16.0.4' }],
    [`releases/tags/${tag}`, null],
    [`actions/workflows/npm-publish.yml/runs?branch=${tag}&head_sha=${sha}&per_page=100`, { workflow_runs: [] }],
  ]);
  const writes: { path: string; body: any }[] = [];
  async function api(path: string, options: { method?: string; body?: any } = {}) {
    if (options.method === 'POST') {
      writes.push({ path, body: options.body });
      switch (path) {
        case 'git/tags':
          responses.set(`git/tags/${annotationSha}`, annotation);
          return { sha: annotationSha };
        case 'git/refs':
          responses.set(`git/ref/tags/${tag}`, tagRef);
          return tagRef;
        case 'releases':
          responses.set(`releases/tags/${tag}`, { draft: false, prerelease: false });
          return {};
        case 'actions/workflows/npm-publish.yml/dispatches': return null;
      }
    }
    if (!responses.has(path)) throw new Error(`Unexpected release API call to ${path}`);
    return responses.get(path);
  }
  return { api, responses, writes };
}

describe('owner-requested GitHub releases', () => {
  test('reads only the pending notes, preserving section titles', () => {
    expect(unreleasedNotes(changelog)).toBe('## Cloud Sync\n\nNew monthly installer.');
    expect(() => unreleasedNotes('## Unreleased\n\n## [1.0.0]\nOld')).toThrow('empty');
  });

  test('never reuses historical Unreleased notes after a dated release', () => {
    const historical = '# Changelog\n\n## [16.0.4] - 2026-11-22\nCurrent release.\n\n## [Unreleased]\nNotes archived years ago.';
    expect(() => unreleasedNotes(historical)).toThrow('first release section');
  });

  test('allows pending, recognizes the exact published commit, and rejects downgrades or other commits', async () => {
    const latest = { version: '16.0.4', gitHead: previousSha };
    const exact = { version, gitHead: sha };
    expect(await publicationState(version, sha, async ref => ref === 'latest' ? latest : null)).toBe('unpublished');
    expect(await publicationState(version, sha, async () => exact)).toBe('published');
    await expect(publicationState(version, previousSha, async () => exact)).rejects.toThrow('differs');
    await expect(publicationState(version, sha, async ref => ref === 'latest' ? { version: '16.10.0' } : null)).rejects.toThrow('newer');
  });

  test('publisher retries recognize immutable versions even after latest has advanced', async () => {
    const calls: string[] = [];
    const exact = { version, gitHead: sha };
    const read = async (ref: string) => { calls.push(ref); return exact; };
    expect(await taggedPublicationState(version, sha, read)).toBe('published');
    expect(calls).toEqual([version]);
    await expect(taggedPublicationState(version, previousSha, read)).rejects.toThrow('different source commit');
    expect(await taggedPublicationState(version, sha, async ref => ref === 'latest' ? { version: '16.0.4' } : null)).toBe('unpublished');
    await expect(taggedPublicationState(version, sha, async ref => ref === 'latest' ? { version: '17.0.0' } : null)).rejects.toThrow('newer');
    expect(await taggedPublicationState('17.0.0-beta.1', sha, async () => null)).toBe('unpublished');
  });

  test('creates an annotated tag for the requested main commit and dispatches npm on that tag', async () => {
    const { api, writes } = releaseApi();
    await requestRelease({ tag, sha }, api, async () => 'unpublished');
    expect(writes.map(write => write.path)).toEqual(['git/tags', 'git/refs', 'releases', 'actions/workflows/npm-publish.yml/dispatches']);
    expect(writes[0].body).toMatchObject({ tag, object: sha, type: 'commit' });
    expect(writes[1].body).toEqual({ ref: `refs/tags/${tag}`, sha: annotationSha });
    expect(writes[2].body).toMatchObject({ tag_name: tag, target_commitish: sha, body: unreleasedNotes(changelog) });
    expect(writes[3].body).toEqual({ ref: tag });
  });

  test('rejects a stale request before touching any ref', async () => {
    const { api, responses, writes } = releaseApi();
    responses.set('git/ref/heads/main', { object: { sha: previousSha } });
    await expect(requestRelease({ tag, sha }, api, async () => 'unpublished')).rejects.toThrow('current main');
    expect(writes).toHaveLength(0);
  });

  test('never moves an existing tag, and resumes from correctly completed steps', async () => {
    const { api, responses, writes } = releaseApi();
    await requestRelease({ tag, sha }, api, async () => 'unpublished');
    writes.length = 0;
    responses.set('git/ref/heads/main', { object: { sha: previousSha } });
    responses.set(`compare/${sha}...${previousSha}`, { status: 'ahead' });
    responses.set(`actions/workflows/npm-publish.yml/runs?branch=${tag}&head_sha=${sha}&per_page=100`, {
      workflow_runs: [{ event: 'workflow_dispatch', head_sha: sha, status: 'queued', html_url: 'https://github.com/actions' }],
    });
    await requestRelease({ tag, sha }, api, async () => 'unpublished');
    await requestRelease({ tag, sha }, api, async () => 'published');
    expect(writes).toHaveLength(0);
    responses.set(`git/tags/${annotationSha}`, { tag, object: { type: 'commit', sha: previousSha } });
    await expect(requestRelease({ tag, sha }, api, async () => 'unpublished')).rejects.toThrow('different release');
    expect(writes).toHaveLength(0);
  });

  test('an owner retry repairs a missing Mac download and preserves an already complete release', async () => {
    const { api, responses, writes } = releaseApi();
    await requestRelease({ tag, sha }, api, async () => 'unpublished');
    writes.length = 0;
    responses.set(`contents/docs/CHANGELOG.md?ref=${sha}`, '# Changelog\n## [16.1.0]\nDated notes.');
    responses.set(`actions/workflows/npm-publish.yml/runs?branch=${tag}&head_sha=${sha}&per_page=100`, {
      workflow_runs: [{ event: 'push', head_sha: sha, status: 'completed', conclusion: 'success', html_url: 'https://github.com/actions' }],
    });
    await requestRelease({ tag, sha }, api, async () => 'published');
    expect(writes.map(write => write.path)).toEqual(['actions/workflows/npm-publish.yml/dispatches']);
    writes.length = 0;
    responses.set(`releases/tags/${tag}`, { draft: false, prerelease: false, assets: [{
      name: 'Claude-Mem-Messages.zip', label: `Claude-Mem Messages (${sha})`, state: 'uploaded', digest: `sha256:${'1'.repeat(64)}`,
    }] });
    expect(await requestRelease({ tag, sha }, api, async () => 'published')).toContain('already published');
    expect(writes).toHaveLength(0);
  });
});
