import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const repository = 'thedotmack/claude-mem';
const packageName = 'claude-mem';
const releasePrefix = 'release/publish/';
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function compareStable(a, b) {
  requireCondition(stableVersion.test(a) && stableVersion.test(b), 'Both releases must have stable X.Y.Z versions.');
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export function unreleasedNotes(changelog) {
  const lines = changelog.split(/\r?\n/);
  const pendingHeading = /^## (?:\[Unreleased\]|Unreleased)\s*$/i;
  const datedHeading = /^## \[?v?\d+\.\d+\.\d+\b/;
  const releaseHeading = line => pendingHeading.test(line) || datedHeading.test(line);
  const start = lines.findIndex(releaseHeading);
  requireCondition(start >= 0 && pendingHeading.test(lines[start]),
    'The first release section in docs/CHANGELOG.md must be Unreleased.');
  const pending = lines.slice(start + 1);
  const end = pending.findIndex(releaseHeading);
  const notes = (end < 0 ? pending : pending.slice(0, end)).join('\n').trim();
  requireCondition(notes, 'The Unreleased section is empty.');
  return notes;
}

async function github(path, { method = 'GET', body, optional = false, raw = false } = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (optional && response.status === 404) return null;
  requireCondition(response.ok, `${method} ${path} failed with GitHub HTTP ${response.status}.`);
  const content = await response.text();
  if (raw) return content;
  return content.trim() ? JSON.parse(content) : null;
}

async function registry(version) {
  const response = await fetch(`https://registry.npmjs.org/${packageName}/${version}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404 && version !== 'latest') return null;
  requireCondition(response.ok, `npm returned HTTP ${response.status} for ${version}.`);
  return response.json();
}

export async function publicationState(version, sha, read = registry) {
  const [latest, exact] = await Promise.all([read('latest'), read(version)]);
  const relation = compareStable(version, latest.version);
  requireCondition(relation >= 0, `npm latest is already newer (${latest.version}).`);
  if (exact === null) {
    requireCondition(relation > 0, 'npm gave inconsistent exact-version and latest responses.');
    return 'unpublished';
  }
  requireCondition(relation === 0 && exact.gitHead === sha && latest.gitHead === sha,
    'The published version, latest tag, or published source commit differs. Nothing will be overwritten.');
  return 'published';
}

export async function taggedPublicationState(version, sha, read = registry) {
  const exact = await read(version);
  if (exact) {
    requireCondition(exact.gitHead === sha, 'The published version belongs to a different source commit.');
    return 'published';
  }
  if (!stableVersion.test(version)) return 'unpublished';
  return publicationState(version, sha, ref => ref === version ? null : read(ref));
}

async function verifyTag(tag, ref, sha, api) {
  requireCondition(ref?.object.type === 'tag', `${tag} must be an annotated tag.`);
  const annotation = await api(`git/tags/${ref.object.sha}`);
  requireCondition(annotation.tag === tag && annotation.object.type === 'commit' && annotation.object.sha === sha,
    `The existing ${tag} points to a different release. It will not be moved.`);
}

export async function requestRelease({ tag, sha }, api = github, check = publicationState) {
  const version = tag.replace(/^v/, '');
  requireCondition(tag === `v${version}` && stableVersion.test(version) && /^[a-f\d]{40}$/.test(sha),
    'A release request must name a stable vX.Y.Z tag and its exact commit.');
  const tagPath = `git/ref/tags/${tag}`;
  const [main, branch, tagRef, manifest, changelog, latestRelease, state] = await Promise.all([
    api('git/ref/heads/main'), api(`git/ref/heads/${releasePrefix}${tag}`),
    api(tagPath, { optional: true }), api(`contents/package.json?ref=${sha}`, { raw: true }),
    api(`contents/docs/CHANGELOG.md?ref=${sha}`, { raw: true }), api('releases/latest'), check(version, sha),
  ]);
  requireCondition(branch.object.sha === sha, 'The release request branch moved.');
  const pkg = JSON.parse(manifest);
  requireCondition(pkg.name === packageName && pkg.version === version, 'The package and requested tag must match.');
  requireCondition(compareStable(version, latestRelease.tag_name.replace(/^v/, '')) >= 0,
    `GitHub already has a newer stable release (${latestRelease.tag_name}).`);
  const newTagNotes = tagRef ? undefined : unreleasedNotes(changelog);

  if (tagRef) {
    await verifyTag(tag, tagRef, sha, api);
    // main can advance after a successful tag push. Retries keep that same
    // immutable commit, provided it still belongs to main's history.
    if (main.object.sha !== sha) {
      const comparison = await api(`compare/${sha}...${main.object.sha}`);
      requireCondition(comparison.status === 'ahead', 'The tagged commit is outside main history.');
    }
  } else {
    requireCondition(state === 'unpublished' && main.object.sha === sha,
      'A new tag can only be created at the current main commit for an unpublished version.');
    const annotation = await api('git/tags', { method: 'POST', body: {
      tag, message: `Version ${version}`, object: sha, type: 'commit',
      tagger: {
        name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com',
        date: new Date().toISOString(),
      },
    } });
    await api('git/refs', { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: annotation.sha } });
    await verifyTag(tag, await api(tagPath), sha, api);
  }

  const release = await api(`releases/tags/${tag}`, { optional: true });
  if (release) {
    requireCondition(!release.draft && !release.prerelease, 'An existing draft or prerelease needs maintainer review.');
  } else {
    await api('releases', { method: 'POST', body: {
      tag_name: tag, target_commitish: sha, name: tag, body: newTagNotes ?? unreleasedNotes(changelog),
    } });
  }
  const hasMacDownload = release?.assets?.some(asset =>
    asset.name === 'Claude-Mem-Messages.zip' && asset.label === `Claude-Mem Messages (${sha})` &&
    asset.state === 'uploaded' && /^sha256:[a-f\d]{64}$/.test(asset.digest));
  if (state === 'published' && hasMacDownload) return 'The exact tag commit and Mac download are already published.';

  const workflow = 'actions/workflows/npm-publish.yml';
  const { workflow_runs: runs } = await api(`${workflow}/runs?branch=${tag}&head_sha=${sha}&per_page=100`);
  const existing = runs.find(run => ['push', 'workflow_dispatch'].includes(run.event) && run.head_sha === sha);
  if (existing?.status === 'completed' && existing.conclusion !== 'success') {
    throw new Error(`Inspect or retry the existing publisher for this tag at ${existing.html_url}.`);
  }
  // A completed npm publication can be dispatched again to restore a missing download.
  if (existing && (state !== 'published' || existing.status !== 'completed')) {
    return `The publisher has already started at ${existing.html_url}.`;
  }
  await api(`${workflow}/dispatches`, { method: 'POST', body: { ref: tag } });
  return `Dispatched the trusted publisher on ${tag} (${sha}).`;
}

async function main() {
  const { GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_REF_TYPE, GITHUB_SHA, GITHUB_ACTOR, GITHUB_REPOSITORY_OWNER } = process.env;
  requireCondition(GITHUB_REPOSITORY === repository, 'This release helper runs only in thedotmack/claude-mem.');
  if (process.argv[2] === 'request') {
    requireCondition(GITHUB_REF_TYPE === 'branch' && GITHUB_REF_NAME.startsWith(releasePrefix)
      && GITHUB_ACTOR === GITHUB_REPOSITORY_OWNER, 'Only an owner-created release request branch is accepted.');
    console.log(await requestRelease({ tag: GITHUB_REF_NAME.slice(releasePrefix.length), sha: GITHUB_SHA }));
  } else if (process.argv[2] === 'publication-state' || process.argv[2] === 'notes') {
    requireCondition(GITHUB_REF_TYPE === 'tag' && /^v/.test(GITHUB_REF_NAME), 'Publish dispatches must target a version tag.');
    const version = GITHUB_REF_NAME.slice(1);
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    requireCondition(pkg.name === packageName && pkg.version === version, 'The checkout does not match the requested release tag.');
    if (process.argv[2] === 'notes') {
      console.log(unreleasedNotes(readFileSync('docs/CHANGELOG.md', 'utf8')));
    } else {
      console.log(await taggedPublicationState(version, GITHUB_SHA));
    }
  } else {
    throw new Error('Expected request, notes or publication-state.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
