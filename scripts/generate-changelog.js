#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const CHANGELOG_PATH = 'docs/CHANGELOG.md';
const HEADER_LINES = [
  '# Changelog',
  '',
  'All notable changes to this project will be documented in this file.',
  '',
  'The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).',
  '',
];

async function listReleases() {
  // One page includes the bodies. Never turn a release tag into a shell command.
  const gh = spawn('gh', ['api', '--paginate', 'repos/{owner}/{repo}/releases?per_page=100',
    '--jq', '.[] | select(.draft | not) | {tagName: .tag_name, publishedAt: .published_at, body} | @json'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const finished = new Promise((resolve, reject) => {
    gh.once('error', reject);
    gh.once('close', (code) => code === 0 ? resolve() : reject(new Error(`gh api exited with ${code}`)));
  });
  const releases = [];
  const lines = createInterface({ input: gh.stdout, crlfDelay: Infinity });
  const read = async () => {
    for await (const line of lines) if (line) releases.push(JSON.parse(line));
  };
  try {
    await Promise.all([finished, read()]);
  } finally {
    lines.close();
    if (gh.exitCode === null) gh.kill();
  }
  return releases;
}

function formatDate(isoDate) {
  return new Date(isoDate).toISOString().split('T')[0];
}

function cleanReleaseBody(body) {
  // Only the trailing attribution block is boilerplate. Mentions inside notes
  // and a hyphenated last line belong to the release author.
  return (body ?? '').trim()
    .replace(/(?:^|\r?\n)(?:---[ \t]*\r?\n(?:[ \t]*\r?\n)*)?🤖 Generated with \[Claude Code\]\([^\r\n]*\)[ \t]*$/, '')
    .trim();
}

function extractVersion(tagName) {
  return tagName.replace(/^v/, '');
}

function renderEntry(release) {
  const version = extractVersion(release.tagName);
  const date = formatDate(release.publishedAt);
  const body = cleanReleaseBody(release.body);
  const lines = [`## [${version}] - ${date}`, ''];
  if (body) {
    const firstHeading = /^#{1,2}[ \t]+v?([^\s:]+)(?:[ \t:].*)?(?:\r?\n|$)/.exec(body);
    const bodyWithoutHeader = firstHeading?.[1] === version
      ? body.slice(firstHeading[0].length).trimStart() : body;
    lines.push(bodyWithoutHeader);
    lines.push('');
  }
  return lines.join('\n');
}

function readExistingChangelog() {
  if (!existsSync(CHANGELOG_PATH)) {
    return { knownVersions: new Set(), body: '' };
  }
  const content = readFileSync(CHANGELOG_PATH, 'utf-8');
  const knownVersions = new Set();
  const versionHeaderRe = /^## \[([^\]]+)\]/gm;
  let match;
  while ((match = versionHeaderRe.exec(content)) !== null) {
    knownVersions.add(match[1]);
  }
  const firstEntryIndex = content.search(/^## \[/m);
  const body = firstEntryIndex === -1 ? '' : content.slice(firstEntryIndex);
  return { knownVersions, body };
}

async function main() {
  const fullRegen = process.argv.includes('--full');

  console.log('🔧 Generating CHANGELOG.md from GitHub releases...\n');

  const { knownVersions, body: existingBody } = fullRegen
    ? { knownVersions: new Set(), body: '' }
    : readExistingChangelog();

  console.log('📋 Fetching release list from GitHub...');
  const allReleases = await listReleases();

  if (allReleases.length === 0) {
    console.log('⚠️  No releases found');
    return;
  }

  const newReleases = allReleases.filter(
    (release) => !knownVersions.has(extractVersion(release.tagName)),
  );

  if (newReleases.length === 0) {
    console.log('✅ CHANGELOG.md is already up to date.');
    return;
  }

  newReleases.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const newEntriesBlock = newReleases.map(renderEntry).join('\n');

  const finalBody = existingBody
    ? `${newEntriesBlock}\n${existingBody}`.trimEnd() + '\n'
    : `${newEntriesBlock}`.trimEnd() + '\n';

  const changelog = HEADER_LINES.join('\n') + '\n' + finalBody;
  writeFileSync(CHANGELOG_PATH, changelog, 'utf-8');

  console.log('\n✅ CHANGELOG.md generated successfully!');
  console.log(`   ${newReleases.length} new release(s) prepended`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
